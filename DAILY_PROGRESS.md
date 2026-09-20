## 2026-08-29

Phase: 0 — Architecture & Setup

Completed:
- Initialized Next.js 15 + TypeScript + Tailwind CSS
- Established full project structure (lib, components, server, types)
- TypeScript types: ToolType, CanvasObject, CanvasOperation, Participant, Room, Version, User, socket events
- MongoDB: mongoose connection + Room/Version models
- Redis: pub/sub client pair (publisher/subscriber)
- Socket.io: custom server (server/index.ts + server/socket.ts)
- Room state: in-memory manager with operations, participants
- User identity: localStorage UUID + color
- Landing page: create/join room UI
- Room page: dynamic client shell (no SSR)
- Canvas: Konva.js with pen, rectangle, circle, line, arrow, triangle, text; undo/redo, zoom/pan, keyboard shortcuts
- Toolbar: all tools, color picker, stroke width, zoom, export
- Presence panel: participant list
- .env.example, .gitignore, README.md, PROJECT_HANDOFF.md

Status:
Phase 0 complete. TypeScript clean (tsc --noEmit passes).

Next:
Phase 1 — Whiteboard MVP (polish canvas, selection transforms, PDF export, text editing)

## 2026-08-29 (Phase 1)

Phase: 1 — Whiteboard MVP

Completed:
- Transformer-based resize/rotate for selected shapes
- Multi-select via shift-click and marquee drag-select, with group-drag
- Duplicate (Ctrl+D) and Delete wired to toolbar + keyboard
- Eraser tool implemented (was a no-op before)
- Double-click text editing via textarea overlay
- Real PDF export with jsPDF (was a PNG-export stub before)
- Fill color picker added to toolbar (prop existed but had no UI)
- Cleaned unused imports in RoomClient.tsx

Status:
Phase 1 complete. `tsc --noEmit` clean, `next build` clean, dev server smoke-tested (/ and /room/[roomId] both 200).

Next:
Phase 2 — Rooms & real-time collaboration (wire Socket.io into the canvas).

## 2026-08-29 (Phase 2)

Phase: 2 — Rooms & Real-Time Collaboration

Completed:
- Fixed broken dev:server script (missing tsconfig.server.json, ts-node never installed) by
  switching to tsx; npm run dev now runs the Socket.io-enabled server directly
- Wired Canvas.tsx to lib/socket/client.ts: room:join on connect, room:state initial sync,
  diff-based canvas:operation broadcast/apply (add/update/delete/clear), participant join/leave,
  throttled cursor broadcast + remote cursor rendering, connecting-status banner
- Fixed pre-existing lint errors (impure Date.now() in render, setState-in-effect, unused imports)
- Verified with tsc --noEmit, eslint, next build, and a scripted two-client Socket.io test
  (join/state-sync/participant-join/op-broadcast/cursor/leave all confirmed against the running
  server)

Status:
Phase 2 complete. tsc clean, eslint clean, next build clean, live two-client socket test passed.

Next:
Phase 3 — Redis Pub/Sub + scalable real-time architecture (multi-instance fan-out).

## 2026-08-29 (Phase 3)

Phase: 3 — Redis Pub/Sub + Scalable Real-Time Architecture

Completed:
- Rewrote lib/room/roomManager.ts from an in-process Map to Redis-backed hashes (objects +
  participants), all functions now async
- Added getDataClient() + connectRedisClients() to lib/redis/client.ts (separate connection from
  the publisher/subscriber pair reserved for the Socket.io adapter)
- Wired @socket.io/redis-adapter into server/socket.ts so socket.to()/io.to() fan out across
  server instances; server/index.ts connects Redis before starting Socket.io
- Fixed a client-bundle break this caused: extracted generateRoomId into lib/room/roomId.ts
  (no ioredis import) so app/page.tsx doesn't pull ioredis into the browser
- Added @socket.io/redis-adapter to package.json; REDIS_URL is now a required env var

Status:
Phase 3 complete. tsc clean, eslint clean, next build clean. Verified with two actual server
processes (production build, different ports) sharing one Redis instance plus a scripted
two-client test: cross-instance participant state, participant:join fan-out, canvas:operation
add/delete fan-out, and correct final state on a third join all confirmed. Note: two `npm run dev`
processes can't share one checkout (Next dev-server lock) -- use `npm run build && npm start` for
local multi-instance testing (documented in README.md).

Next:
Phase 4 — Shared history (distributed undo/redo) & confirming export still works on Redis-backed state.

## 2026-08-30

Phase: 4 — Shared History & Export

Completed:
- Replaced per-client local undo/redo with a single shared, server-authoritative history stack
  per room (Redis-backed), including a per-commit groupId so multi-object commits (group-drag,
  multi-delete) undo/redo as one step
- Found and fixed two real concurrency races via scripted testing (not just code review): both
  fixed by making the undo-snapshot-plus-mutation, and the pop-plus-restore, each a single atomic
  Redis Lua script instead of sequential JS-side round trips
- Confirmed PNG/PDF export still works (untouched, pure client-side)

Verified:
tsc clean, eslint clean, next build clean. Three scripted Socket.io tests against a live server:
basic undo/redo/redo-invalidation, grouped-vs-independent-commit undo granularity (this is what
caught the two races before the Lua fix), and genuine two-process multi-instance cross-instance
undo/redo (ports 4201/4202, one Redis).

Status:
Phase 4 complete.

Next:
Phase 5 — Presence (viewer/editor state, cleaner reconnect handling; basic presence already
exists from Phase 2 -- see PROJECT_HANDOFF.md roadmap).

## 2026-08-30

Phase: 5 — Presence

Completed:
- Added `lastActiveAt` to `Participant` type
- Added `participant:update` to socket event types (client+server)
- Added `updateParticipant()` to roomManager — persists isEditing + lastActiveAt to Redis so late joiners see current editing state
- Added `participant:update` server handler in socket.ts — updates Redis + relays to room (excluding sender)
- Added `broadcastEditingState()` in Canvas.tsx — fires on mousedown, reverts after 2s idle timeout; uses refs to avoid stale closures
- Added `handleParticipantUpdate` socket listener in Canvas.tsx to sync isEditing state from other clients
- Redesigned PresencePanel with rich UI: animated avatar rings on editing users, bouncing bars indicator, TimeAgo relative timestamps, online dot, hover states
- Added editing count to room info bar in RoomClient

Status:
Phase 5 complete. tsc clean, next build clean.

Next:
Phase 6 — Version History

## 2026-08-30 (Phase 6)

Phase: 6 — Version History

Completed:
- Added `restoreSnapshot` atomic Redis Lua script + `roomManager.restoreSnapshot()` — pushes
  current state onto the undo stack (restore is itself undoable), clears redo, replaces objects
- Added `lib/db/versionManager.ts`: saveVersion/listVersions/getVersion against the existing
  Mongoose `Version` model, capped at 30 versions/room
- Added `version:save`/`version:list`/`version:restore` handlers in `server/socket.ts`; restore
  reuses the existing Phase 4 `history:state` broadcast, so Canvas.tsx needed no changes
- Connected MongoDB in `server/index.ts` — deliberately non-blocking/background, so the rest of
  the app keeps working with zero MongoDB, same as Phases 0-5
- Added try/catch + `error` emission around all three Mongo-backed socket handlers, so a down
  MongoDB fails a single request gracefully instead of hanging the client or crashing the server
- Added `components/version/VersionHistoryPanel.tsx`: slide-out drawer to save labeled snapshots,
  browse them with relative timestamps, restore any one, and a sequential "Replay" through all of
  them; wired into Toolbar (new history button) and RoomClient
- Fixed 2 pre-existing lint errors found along the way (impure `Date.now()` calls during render
  in PresencePanel.tsx)

Verified:
`tsc --noEmit` clean, `eslint` clean, `next build` clean. Live scripted Socket.io test against a
running server (Redis up, MongoDB deliberately NOT running in this sandbox): confirmed
canvas:operation relay unaffected, and all three version handlers fail gracefully (clean `error`
event, no hang) with MongoDB down, with the server remaining fully responsive afterward. Could not
verify the MongoDB happy path end-to-end in this sandbox (no MongoDB package available and
mongodb-memory-server's binary download is blocked by network policy here) — the version manager
code was reviewed carefully instead; see PROJECT_HANDOFF.md KNOWN ISSUES.

Status:
Phase 6 complete (Mongo-down path verified live; Mongo-up path verified by code review only).

Next:
Phase 7 — WebRTC Video Call.


## 2026-08-30 (Phase 7)

Phase: 7 — WebRTC Video Call

Completed:
- Extended `types/index.ts`: `WebRTCSignal` type (offer/answer/ice-candidate), `inCall?: boolean`
  on `Participant`, `webrtc:signal` event both directions, broadened `participant:update` so
  `isEditing`/`inCall` can each be patched independently without clobbering the other
- `server/socket.ts`: `participant:update` now merges only the fields actually sent; added
  `webrtc:signal` as a pure room-wide relay (ephemeral, no Redis/Mongo — same treatment as
  `cursor:move`). Each client filters by the `to` userId itself.
- Added `lib/webrtc/useWebRTC.ts`: mesh-topology peer connection hook, STUN-only (Google public
  STUN, no TURN/paid media server), userId comparison decides who sends the initial offer per
  pair (avoids both sides offering simultaneously), driven entirely by the `inCall` flag already
  present on each Participant
- Added `components/video/VideoOverlay.tsx`: floating bottom-right call panel — join/leave,
  camera/mic toggle, video tiles for self + each remote peer; minimizes to a small reopen pill
  without ending the call
- Wired into `Toolbar.tsx` (new 🎥 button) and `RoomClient.tsx`; added a small in-call indicator
  to `PresencePanel.tsx`; fixed `Canvas.tsx`'s `participant:update` handler to merge patches
  correctly instead of assuming both fields are always present

Verified:
`tsc --noEmit` clean, `eslint` clean, `next build` clean. Live scripted Socket.io test
(`scripts/test-phase7.mjs`, Redis up) against a running server: inCall presence relay,
isEditing-only updates leaving inCall untouched, offer/answer/ICE-candidate relay all correct,
and canvas:operation relay confirmed unaffected. Real two-browser-tab peer connection testing
(actual audio/video flowing) was not done in this sandbox — same category of gap as Phase 6's
MongoDB happy path, flagged rather than assumed; see PROJECT_HANDOFF.md.

Status:
Phase 7 complete (signaling relay verified live; real peer-to-peer media flow not exercised in
this sandbox).

Next:
Phase 8 — AI Shape Recognition.

## 2026-09-03 (Phase 8)

Phase: 8 — AI Shape Recognition

Completed:
- Added `lib/canvas/shapeRecognizer.ts`: pure geometric/heuristic classifier (no ML model, no
  paid API) — corner detection (RDP simplification + jitter smoothing) for rectangle/triangle,
  isoperimetric circularity fallback for circle/ellipse, straight-open-stroke detection for arrow
- Wired into `Canvas.tsx` at pen-stroke commit time (mouseup), gated behind a new off-by-default
  toggle so freehand strokes are never surprised into a shape
- Added ✨ toggle to `Toolbar.tsx`, state owned by `RoomClient.tsx`
- Added `scripts/test-shape-recognizer.mjs`: synthetic rough-stroke unit tests, no
  browser/server/Redis/Mongo needed

Verified:
`tsc --noEmit` clean, `eslint` clean (no new issues), `next build` clean. Classifier unit tests:
29/29 core cases pass (rectangle/triangle/circle/ellipse/arrow positives, scribble/tiny-drag/wavy/
star negatives); separate non-gating stress test at extreme jitter recognizes 3/5, reported not
hidden. Re-ran the existing Phase 7 scripted Socket.io test (`scripts/test-phase7.mjs`) against a
live server (Redis up) to confirm this phase's changes didn't regress presence/WebRTC-signaling/
canvas-operation relay -- all passed.

Status:
Phase 8 complete. Not verified against real human-drawn strokes in a browser (only synthetic
point paths) -- flagged in PROJECT_HANDOFF.md, same "flag don't assert" pattern as Phase 6/7.

Next:
Phase 9 — Security & Production Hardening.

## 2026-09-03 (Phase 9)

Phase: 9 — Security & Production Hardening

Decision made first (per PROJECT_HANDOFF.md's flagged Phase 8 open question): hardened the
existing no-auth trust model rather than adding accounts -- a scope increase beyond "harden what
exists," documented as a deliberate choice, not picked silently.

Completed:
- Added `lib/security/validation.ts`: zod schemas for every Socket.io event payload and the
  `/api/rooms` REST body -- runtime validation, since TypeScript types don't constrain what an
  arbitrary client sends over the wire. Size caps: 200KB per canvas object, 20KB per WebRTC signal.
- Added `lib/security/rateLimiter.ts`: Redis-backed fixed-window rate limiter, per-user, shared
  across server instances (canvas:operation 60/s, cursor:move 30/s, undo/redo 10/s,
  webrtc:signal 50/s, version ops 5-10/10s, room:join 10/10s by IP).
- `server/socket.ts`: every handler now binds identity ONCE at `room:join` (`currentUserId`/
  `currentRoomId`) and uses those closure values for anything security-relevant instead of
  trusting client-sent fields in later payloads -- closes the identity-spoofing gap flagged in
  Phase 8's handoff (a client could previously forge `canvas:operation`/`webrtc:signal` under
  another user's identity). All handlers wrapped in try/catch; version:restore also checks the
  restored version actually belongs to the requesting room.
- `app/api/rooms/route.ts`: zod validation + IP-scoped rate limit (this route turned out unused
  by the current UI, but hardened anyway as a public endpoint).
- `next.config.ts`: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy headers on every HTTP response.
- `lib/canvas/userStore.ts`: client-side username trim/cap (UX-only; server is the real boundary).
- Reviewed for XSS (grep for innerHTML/dangerouslySetInnerHTML across the repo): none found;
  canvas text renders via Konva's `<Text>`, not raw DOM.
- `MONGODB_URI`/`REDIS_URL` already support credentialed/TLS connection strings -- no code change
  needed, documented as a deployment responsibility rather than adding unused config surface.

Verified:
`tsc --noEmit` clean, `next build` clean. `eslint` shows only pre-existing warnings/1 pre-existing
error in files untouched by this phase (`test-phase6.js` require-import, `PresencePanel.tsx`
unused vars) -- confirmed not introduced here. New live scripted test
(`scripts/test-phase9.mjs`, Redis up, real running server, run in-process so the background
server survives the sandbox's per-tool-call process boundary): 11/11 passed -- oversized-username
rejection, canvas-op and WebRTC identity-spoof rejection, oversized-payload rejection,
flood/rate-limit drop (59/150 relayed), REST validation (400 bad body / 201 good), security
headers present. Re-ran `scripts/test-phase7.mjs` against the hardened server -- all passed, no
regression. Re-ran `scripts/test-shape-recognizer.mjs` -- 29/29, unaffected.

Status:
Phase 9 complete.

Next:
Phase 10 — Testing & Finalization.
