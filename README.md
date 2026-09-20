# Whiteboard — Real-Time Collaborative Canvas

Production-quality real-time collaborative whiteboard: Next.js, Konva.js, Socket.io, Redis, MongoDB.

## Tech Stack
- **Frontend**: Next.js 15, TypeScript, Tailwind CSS
- **Canvas**: Konva.js / react-konva
- **Real-time**: Socket.io + Redis Pub/Sub
- **Database**: MongoDB + Mongoose
- **Video**: WebRTC (native)

## Setup
```bash
npm install
cp .env.example .env.local
# REDIS_URL must point at a running Redis instance from Phase 3 onward (see below).
# MONGODB_URI is only used for Save/Restore Version (Phase 6) -- the rest of the app runs fine
# without it; see below.
npm run dev
```

`npm run dev` runs the custom Socket.io + Next.js server (`server/index.ts`) via `tsx`, so real-time
collaboration works out of the box in dev. Use `npm run dev:next-only` if you only need the Next.js
routes without the socket server (note: the socket server is what talks to Redis, so this mode won't
have real-time collaboration).

**Redis is required from Phase 3.** Room state (canvas objects + participants) now lives in Redis
instead of process memory, and Socket.io uses the Redis adapter to fan out events across multiple
server instances. Run a local Redis (`redis-server`, or `docker run -p 6379:6379 redis`) before
starting the app.

**MongoDB is only used for Version History (Phase 6).** It's connected in the background, not
awaited at startup — if it's unreachable, the server logs a warning and everything else (canvas,
rooms, undo/redo, presence) keeps working exactly as before; only Save/List/Restore Version show
a clear error in that panel instead of hanging. Run a local MongoDB
(`mongod`, or `docker run -p 27017:27017 mongo`) to use version history.

### Running multiple server instances (to see the scaling actually work)
Next's dev server takes a lock on `.next/` per project directory, so two `npm run dev` processes
can't share one checkout. To actually see two instances behind the same Redis, use a production
build instead:
```bash
npm run build
# terminal 1
PORT=4001 npm start
# terminal 2
PORT=4002 npm start
```
Both point at the same `REDIS_URL`. Open a room on `:4001` in one browser tab and the same room URL
on `:4002` in another — participants, cursors, and canvas operations sync across the two processes
exactly as they would across two behind a real load balancer. (Verified in this session with a
two-process + scripted-client test — see PROJECT_HANDOFF.md.)

Open http://localhost:3000

## Environment Variables
```
NEXT_PUBLIC_APP_URL=http://localhost:3000
MONGODB_URI=mongodb://localhost:27017/whiteboard
REDIS_URL=redis://localhost:6379
```
No new environment variables were needed for Phase 7 (WebRTC) — signaling rides the existing
Socket.io connection, and the only ICE server config is a hardcoded public Google STUN endpoint
(no TURN, no account/API key required).

## Features (Phase 8)
- AI shape recognition: toggle (✨ button in the toolbar, off by default) that snaps a finished
  pen stroke to a clean shape when it confidently matches one — rough circle → clean circle,
  rough rectangle → clean rectangle, rough triangle → clean triangle, rough straight stroke →
  clean arrow
- Pure geometric/heuristic classifier — no ML model, no vision API, no network call, no paid
  service. Runs synchronously on stroke completion (not live during the stroke): corner detection
  (path simplification + jitter smoothing) identifies rectangles/triangles; an isoperimetric
  circularity check catches circles and moderately elongated ellipses; straight open strokes
  become arrows
- Confidence-gated with a documented fallback: anything that doesn't confidently match stays
  freehand rather than being forced into a bad shape
- Runs entirely client-side, before the stroke is broadcast — remote peers just see a normal
  `add` operation for a clean shape, no server or wire-format changes needed
- Unit-tested with synthetic rough-stroke point paths (`scripts/test-shape-recognizer.mjs`,
  no browser/server required) — 29/29 core cases pass; a separate, non-gating stress test at
  extreme jitter (10px noise on a 250x150 shape) recognizes 3/5, reported as a known limit of a
  pure-geometry approach rather than hidden

## Features (Phase 7)
- Video call: floating overlay (bottom-right, not a sidebar) with a Join/Leave button, camera and
  microphone toggles, and a video tile per participant currently in the call
- Mesh WebRTC: every in-call participant connects directly to every other in-call participant
  (no media server) — call membership is just another field (`inCall`) on the existing Participant
  presence data from Phase 5, so it persists and survives late joiners the same way `isEditing` does
- Signaling (offer/answer/ICE candidates) is relayed through the existing Socket.io connection —
  no separate signaling server, no paid service, STUN-only (Google public STUN) with no TURN
  fallback for peers both behind symmetric NATs (documented limitation, not solved)
- Minimizing the call panel (✕) does not end the call — it collapses to a small reopenable pill so
  audio/video keeps running while you work on the canvas
- Participants currently in the call show a small 🎥 indicator in the presence panel

## Features (Phase 6)
- Version History: save a labeled snapshot of the current canvas at any time, browse past
  snapshots in a slide-out drawer (timestamps, labels), and restore any of them
- Restoring a version reuses the existing shared `history:state` broadcast (same one Phase 4's
  undo/redo uses), and pushes the pre-restore state onto the undo stack first, so a restore is
  itself undoable with a normal Ctrl+Z
- Replay: steps through every saved version oldest → newest with a short pause between each,
  visible live to everyone in the room (each step is a real restore, not a local-only preview)
- Snapshots persist in MongoDB (separate from the Redis undo/redo stacks, which are ephemeral),
  capped at 30 per room
- MongoDB connects in the background at startup, not awaited — the rest of the app (canvas, rooms,
  presence, shared undo/redo) requires no MongoDB at all, same as Phases 0-5; only the version
  panel degrades (with a visible error) if Mongo is unreachable

## Features (Phase 5)
- Presence panel redesign: animated avatar glow rings, a bouncing-bar "editing" indicator, and
  relative ("2m ago") timestamps for each participant
- "Editing" state: any mousedown on the canvas marks a participant as editing for 2s of idle time
  (tool-agnostic — draw, drag, select, and resize all count), synced to everyone via
  `participant:update` and persisted so late joiners see the correct state immediately
- Room info bar shows a live "N editing" count when anyone in the room is actively interacting
  with the canvas

## Features (Phase 4)
- Shared undo/redo: a single history stack per room (Redis-backed), not per client — undo/redo
  is now a server round trip, and the resulting state is broadcast to everyone in the room
- Multi-object commits (group-drag, multi-delete) undo/redo as one step, not one step per object,
  via a per-commit `groupId` on each operation
- Undo/redo apply + history bookkeeping run as a single atomic Redis Lua script per operation —
  needed to avoid a real race found via testing (see KNOWN ISSUES / PROJECT_HANDOFF.md)
- Verified working across multiple server instances (Redis adapter fan-out), not just single-process
- PNG/PDF export (Phase 1) reconfirmed working — both are pure client-side (Konva `toDataURL` /
  jsPDF) and untouched by this phase's server-side changes

## Features (Phase 3)
- Room state (canvas objects + participants) moved from a single process's memory into Redis
  (hashes, one per room) — every server instance reads/writes the same shared state
- Socket.io Redis adapter wired in, so `io.to()`/`socket.to()` broadcasts (canvas operations,
  presence, cursors) reach clients connected to *any* server instance, not just the one they
  broadcast from
- Everything from Phase 2 (rooms, live sync, presence, cursors) now works correctly across
  multiple server processes/instances, not just one

## Features (Phase 2)
- Room-based sessions: create a room from the landing page or join by room code/link
- Live canvas sync: draw/move/resize/rotate/delete/duplicate/clear on one client appears on every
  other client in the room, sent as per-object operations (not full-canvas snapshots)
- Presence: participant list updates live as people join/leave; live cursor indicators (name + color)
  for every other participant in the room
- Reconnect handling: the client rejoins the room and receives a fresh state snapshot after a drop
- Everything from Phase 1 (drawing tools, selection, transform, undo/redo, export) still works

## Features (Phase 1)
- Freehand pen, rectangle, circle, line, arrow, triangle, text
- Select tool: click, shift-click multi-select, marquee (drag-select) selection
- Transformer: resize + rotate selected shape(s); group move for multi-select
- Duplicate (Ctrl+D / toolbar), Delete (Del/Backspace), Clear all
- Eraser tool (click or drag over an object to remove it)
- Double-click text to edit in place
- Stroke + fill color swatches plus custom color picker
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z), zoom (wheel + toolbar), pan (drag canvas)
- Export to PNG and real PDF (jsPDF)

## Features (Phase 9)
- **No new authentication was added** — a deliberate decision, documented as a real scope
  question in PROJECT_HANDOFF.md, not picked silently: `userId` remains a client-generated,
  client-trusted value (localStorage). What Phase 9 hardens is everything *given* that trust
  model, so the existing app-without-accounts design is no longer wide open.
- Runtime input validation (`lib/security/validation.ts`, zod) on every Socket.io event payload
  and the `/api/rooms` REST body — TypeScript types only constrain Claude's own code, not what an
  arbitrary client can send over the wire. Includes size caps (200KB per canvas object, 20KB per
  WebRTC signal) so a malformed or hostile payload can't bloat Redis/Mongo or blow up a broadcast.
- Identity is now bound once at `room:join` and never re-trusted from a later payload: every
  handler uses the socket's own authenticated `userId`/`roomId`, not the fields a client happens
  to send in that event. Closes a real gap from Phase 8's handoff — previously a client could
  emit `canvas:operation` or `webrtc:signal` claiming to be a different user.
- Redis-backed rate limiting (`lib/security/rateLimiter.ts`) per user, shared across server
  instances (not per-process) — canvas ops, cursor moves, undo/redo, WebRTC signaling, version
  saves, and room joins all have their own limit.
- Security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy) on every HTTP response via `next.config.ts`.
- Reviewed for XSS: canvas text renders through Konva's `<Text>` (canvas-drawn), not raw DOM
  `innerHTML`/`dangerouslySetInnerHTML` — confirmed via a full-repo grep, not assumed.
- `MONGODB_URI`/`REDIS_URL` already support full connection strings with credentials and TLS
  (`mongodb+srv://user:pass@host/db?tls=true`, `rediss://user:pass@host:port`) — no code change
  needed, just a production deployment's responsibility to set them that way; documented in
  PROJECT_HANDOFF.md rather than adding unused config surface.

## Known limitations (Phase 8)
- Pure geometry, not ML: recognizes rectangles, triangles, circles/ellipses, and arrows (straight
  open strokes) only — no free-form icon/symbol recognition, and won't distinguish e.g. a rounded
  square from a circle as gracefully as a trained model would.
- Accuracy degrades at high stroke jitter: heavily shaky strokes (well beyond normal hand tremor)
  can fail to resolve to a clean corner count and are correctly left as freehand rather than
  force-matched, but this means very noisy drawings just won't get recognized. See
  `scripts/test-shape-recognizer.mjs`'s stress-test section for measured numbers.
- Straight open pen strokes always become arrows, never plain lines, when recognition is on — a
  deliberate choice (see PROJECT_HANDOFF.md), not a limitation of the classifier itself; the
  dedicated Line tool is unaffected and always produces a plain line.
- Recognition is opt-in (off by default) and pen-tool-only; it does not touch the dedicated
  rectangle/circle/line/arrow/triangle tools, which already draw clean shapes directly.

## Known limitations (Phase 9)
- No authentication/accounts — `userId` is still a client-generated, unauthenticated localStorage
  value. Hardening in this phase assumes that trust model rather than replacing it; see
  PROJECT_HANDOFF.md for why, and what real auth would change.
- Rate limits are fixed constants (`lib/security/rateLimiter.ts`), not configurable per
  deployment or per room.
- CSP still allows `'unsafe-inline'`/`'unsafe-eval'` on `script-src`, required by Next.js's own
  dev/runtime bootstrap; a stricter nonce-based CSP would need a custom middleware layer — flagged
  as a follow-up, not solved here.
- No automated abuse/anomaly detection beyond the fixed-window rate limits — e.g. no ban list, no
  detection of a client cycling `userId` values to dodge its own limit (mitigated but not
  eliminated: identity is bound at `room:join`, but nothing stops a client from reconnecting with
  a fresh `userId` and rejoining).

## Known limitations (Phase 7)
- STUN-only, no TURN: two peers who are both behind a symmetric NAT may fail to establish a
  direct connection. Adding TURN would mean self-hosting (or paying for) a relay server, which
  this project deliberately avoids per the master prompt's constraints.
- Mesh topology (not an SFU): each participant opens a direct connection to every other
  participant, so bandwidth/CPU cost grows with the square of call size. Fine at small room
  scale; not something this project attempts to solve for large calls.
- No server-side cap on call size.
- Real two-browser media flow was not verified live in this sandbox (no way to run two browsers
  with camera access here) — only the signaling relay was tested live. See PROJECT_HANDOFF.md.

## Known limitations (Phase 4)
- Still no persistence: restarting Redis (or `FLUSHALL`) drops all room objects, participants,
  AND now the undo/redo history stacks too. MongoDB models exist in `lib/db` but aren't called —
  still an explicit follow-up, not scheduled to a specific phase.
- Undo/redo history is capped at 50 entries per room (oldest snapshots drop off); this is a fixed
  constant (`MAX_HISTORY` in `lib/room/roomManager.ts`), not currently configurable.
- Still last-write-wins at the object level for concurrent non-undo edits — Phase 4 added a shared
  *history stack*, not an OT/CRDT layer. Two users editing the same object at the same instant still
  resolve by whichever `HSET` lands last in Redis, unchanged from Phase 2/3.
- Redis is still a hard runtime dependency (unchanged from Phase 3).

## Known limitations (Phase 3)
- Undo/redo is per-client history navigation, not a shared distributed undo stack — undoing can
  revert another user's most recent change. Proper shared history is Phase 4 scope.
- No persistence: restarting Redis (or `FLUSHALL`) drops all room objects/participants. MongoDB
  models exist in `lib/db` but aren't called yet — still an explicit follow-up, not scheduled to a
  specific phase.
- Operation ordering across instances is last-write-wins via `HSET`, same as the Phase 2 in-memory
  `Map.set` semantics — there's no vector clock / operational-transform layer, so two near-simultaneous
  edits to the same object from different instances resolve by whichever `HSET` lands last in Redis,
  not by causal order.
- Redis is now a hard runtime dependency (previously optional) — the server won't start without a
  reachable `REDIS_URL`.

## Phase Status
- [x] Phase 0 — Architecture & Setup
- [x] Phase 1 — Whiteboard MVP
- [x] Phase 2 — Rooms & Real-Time
- [x] Phase 3 — Redis Pub/Sub Scale
- [x] Phase 4 — History & Export
- [x] Phase 5 — Presence
- [x] Phase 6 — Version History (MongoDB happy path verified by code review only, not live — see PROJECT_HANDOFF.md)
- [x] Phase 7 — WebRTC Video (signaling relay verified live; real browser-to-browser media flow not exercised in this sandbox — see PROJECT_HANDOFF.md)
- [x] Phase 8 — AI Shape Recognition (heuristic, geometry-only; no paid AI API)
- [x] Phase 9 — Security Hardening (no auth added, deliberately — see PROJECT_HANDOFF.md)
- [ ] Phase 10 — Testing & Finalization
