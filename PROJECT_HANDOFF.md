---
# PROJECT HANDOFF

## PROJECT
Real-Time Collaborative Whiteboard

## Current Phase
Phase 6 — Version History

## Phase Status
COMPLETE (see caveat in KNOWN ISSUES: MongoDB happy path verified by code review, not live —
no MongoDB available in this sandbox)

## COMPLETED
Phase 0 + Phase 1 + Phase 2 + Phase 3 (see DAILY_PROGRESS.md), plus in Phase 4:
- Replaced per-client local undo/redo (each browser tab navigating its own full-canvas snapshot
  array) with a single shared, server-authoritative history stack per room, stored in Redis.
- `types/index.ts`: added `groupId: string` to `CanvasOperation` — all ops emitted from one local
  commit (a single `commitAndSync`/`broadcastDiff` call, e.g. one group-drag touching 3 shapes)
  share the same `groupId`, so the server can snapshot undo history once per commit, not once per
  changed object. Replaced the old (mismatched-purpose) `history:undo`/`history:redo` entries in
  `ServerToClientEvents` with a single `history:state: (data: { objects: CanvasObject[] }) => void`.
- `lib/redis/client.ts`: registered two atomic Lua scripts on `getDataClient()` via
  `defineCommand` — `applyCanvasOp` (apply one operation's mutation + snapshot-for-undo-if-new-
  commit, in one round trip) and `popHistory` (pop one stack, push current state onto the other,
  restore the popped snapshot, in one round trip). See IMPORTANT IMPLEMENTATION DETAILS below for
  why these had to be single atomic scripts rather than sequential Node-side calls.
- `lib/room/roomManager.ts`: `applyOperation` now calls `applyCanvasOp` (does both the mutation
  and the undo bookkeeping atomically); added `popUndo`/`popRedo` (call `popHistory` in each
  direction) and removed the old two-step JS-side snapshot/restore logic they replaced.
- `server/socket.ts`: `canvas:operation` handler simplified to one `applyOperation` call (was
  two: a separate `maybeSnapshotForUndo` + `applyOperation`). Added `history:undo`/`history:redo`
  handlers — pop the shared stack and `io.to(roomId).emit('history:state', ...)` (not
  `socket.to`, since the requester also needs the authoritative result, not just everyone else).
- `components/canvas/Canvas.tsx`: removed the local `history`/`historyIndex` state and
  `commitHistory`/`syncAfterHistoryNav` entirely. `doUndo`/`doRedo` now emit `history:undo`/
  `history:redo` and wait for the server's `history:state` broadcast to update local state — no
  local optimistic update, since the shared stack is server-authoritative and a local guess could
  diverge from what another client's concurrent undo produces.
- PNG/PDF export (Phase 1, `stage.toDataURL()` + jsPDF) reconfirmed working — untouched by this
  phase, verified unaffected since export reads local Konva canvas state, not roomManager.

## CURRENT ARCHITECTURE
```
app/
  page.tsx              Landing (create/join room) -- imports lib/room/roomId, NOT roomManager
  room/[roomId]/         Dynamic room page (SSR disabled)
  api/rooms/             REST: create room -- also imports lib/room/roomId
components/
  room/RoomClient        Main room layout controller
  toolbar/Toolbar        Tool selection, stroke/fill colors, actions, export
  canvas/Canvas          Konva stage + socket sync: drawing, selection, transform, erase,
                         text-edit, export, real-time broadcast/apply, cursors, undo/redo
                         (undo/redo now round-trip through the server -- no local history)
  presence/PresencePanel Sidebar showing participants
lib/
  db/mongoose.ts         Cached mongoose connection (not yet called anywhere)
  db/models.ts           Room + Version mongoose models (not yet used)
  redis/client.ts        getPublisher/getSubscriber (Socket.io adapter pair) + getDataClient
                         (plain commands + 2 atomic Lua scripts: applyCanvasOp, popHistory) +
                         connectRedisClients (startup helper)
  socket/client.ts       Socket.io browser client singleton
  room/roomManager.ts    Redis-backed room state (objects/participants/undo/redo), server-only
                         (imports ioredis -- do not import from a Client Component)
  room/roomId.ts          generateRoomId() only, no Redis import -- safe for client components
  canvas/userStore.ts     User identity in localStorage
server/
  index.ts               Custom HTTP server (Next.js + Socket.io), connects Redis clients then
                         starts Socket.io, run via `tsx`
  socket.ts               Socket.io event handlers + Redis adapter setup: room:join/leave,
                         canvas:operation, history:undo/redo, cursor:move, disconnect -- ops
                         relay via `socket.to()` (never echoed to sender, sender already has the
                         local state it broadcast); undo/redo results relay via `io.to()` (DOES
                         include the requester -- the result is authoritative, not an echo)
types/index.ts            Shared TypeScript types (CanvasOperation now carries groupId; a
                         `history:state` server->client event replaced the old undo/redo op echo)
```

## TECH STACK
- Next.js 16 (App Router), TypeScript, Tailwind CSS
- Konva.js / react-konva (canvas engine)
- jsPDF (PDF export)
- Socket.io + Socket.io-client + @socket.io/redis-adapter (cross-instance broadcast, Phase 3)
- tsx (runs the TypeScript custom server directly)
- ioredis (Redis pub/sub, room-state store, AND now 2 Lua scripts for atomic history ops)
- mongoose (MongoDB, still not connected -- persistence remains an explicit follow-up)
- uuid

## PROJECT STRUCTURE
See README.md

## DATABASE
Unchanged from Phase 3 -- MongoDB models exist in `lib/db/models.ts`, connection helper in
`lib/db/mongoose.ts`, neither is called. Room state AND now undo/redo history both live in Redis,
which survives a Node process restart but NOT a Redis restart/flush. Persistence remains an
explicit, deliberately deferred follow-up (not this phase's scope).

## REAL-TIME ARCHITECTURE
Unchanged from Phase 3 at the transport level (Socket.io + Redis adapter for cross-instance
fan-out). What's new in Phase 4 is what happens server-side per event:

- **canvas:operation** -> `roomManager.applyOperation` -> one atomic Redis Lua script
  (`applyCanvasOp`) that both (a) snapshots the room's pre-op object state onto the undo stack
  *if* this op's `groupId` differs from the last-seen group for the room, clearing the redo stack,
  and (b) applies the op's actual mutation (HSET/HDEL/DEL) to the objects hash. Broadcast to
  others via `socket.to(roomId)`, same as Phase 2/3.
- **history:undo / history:redo** -> `roomManager.popUndo`/`popRedo` -> one atomic Redis Lua
  script (`popHistory`) that pops the requested stack, pushes the room's current state onto the
  *other* stack, restores the popped snapshot as the live object hash, and returns the snapshot
  JSON directly (no extra read-back needed). Broadcast to **everyone** in the room via
  `io.to(roomId)` (including the requester) as `history:state`, since this result is
  authoritative for the whole room, not just other clients.

Undo/redo is a single shared LIFO stack per room, not per-client -- this replaces Phase 0-3's
model where each browser tab tracked its own full-canvas snapshot history locally and undo/redo
only affected that one tab's view (while still broadcasting the resulting diff to others, which
meant one user's undo could silently revert *another* user's edit without their tab's own history
ever reflecting it).

## IMPORTANT IMPLEMENTATION DETAILS
- **Why the two operations had to be single atomic Lua scripts, not sequential JS-side calls
  (found via testing, not by inspection):** the first implementation did
  `GET lastGroupId` -> compare -> (maybe) `RPUSH` snapshot -> `SET lastGroupId`, as separate
  awaited Redis calls from Node, followed by a separate `applyOperation` call for the actual
  mutation. This raced in two different ways, both confirmed with scripted two-client tests
  before being fixed:
  1. Two ops sharing one `groupId` (e.g. a group-drag's per-shape update ops, emitted
     back-to-back with no `await` between the `socket.emit` calls) could both read the *old*
     `lastGroupId` before either had written the new one, so both decided "this starts a new
     commit" and pushed two snapshots for what should have been one undo step.
  2. Independent ops with *different* `groupId`s, when applied to the same room in immediate
     succession (e.g. 3 unrelated `add` commits fired without awaiting the previous one's
     server ack), could have op2's "snapshot the current state" step run on Redis *before* op1's
     "apply the mutation" step had landed -- because each op did two separate awaited round trips
     on the same Redis connection, and Node dispatches the next socket event's handler before the
     previous one's promise chain resolves, so the round trips from different ops interleaved.
     This produced snapshots that didn't reflect the actual commit-by-commit history (verified:
     undoing appeared to skip states entirely, e.g. jumping straight from 3 objects to 0 instead
     of removing one at a time).
  The fix: `applyCanvasOp` bundles the group-check + snapshot + actual mutation into one Lua
  script; `popHistory` bundles pop + push-to-other-stack + restore into another. Redis executes
  each `EVAL` to completion (atomically, with respect to all other commands on that connection)
  before starting the next queued command, so every op's full effect happens as one indivisible
  step in strict arrival order -- closing both races regardless of how Node interleaves the
  socket handlers.
- `popHistory` uses Redis's built-in `cjson` library (available in the Lua scripting environment
  since Redis 2.6) to decode the popped snapshot array and re-encode each object when restoring
  it into the objects hash, and returns the popped JSON string directly to Node -- no separate
  read-back of the restored state is needed, guaranteeing the emitted `history:state` payload is
  exactly what was popped.
- History stacks are capped at 50 entries per room (`MAX_HISTORY` in `roomManager.ts`) via
  `LTRIM` inside each script, so a very long editing session doesn't grow the undo list forever.
- A new commit (any op with a different `groupId` than the current `lastGroupId`) always clears
  the redo stack -- standard undo/redo semantics, confirmed by test (redo silently no-ops after
  a fresh edit, rather than replaying stale future state).
- Concurrent undo/redo requests from different clients in the same room are serialized by Redis
  itself (single-threaded `EVAL` execution), so there's still no need for vector clocks / OT here
  -- two near-simultaneous undo requests deterministically pop two different stack entries in
  order, same LIFO guarantee as before, just now proven safe under the concurrency that actually
  occurs (rapid-fire ops from one client), not only under careful one-at-a-time testing.
- Verified with: `tsc --noEmit` clean, `eslint` clean, `next build` clean, and three scripted
  Socket.io tests run against a live server (Redis running locally in the dev sandbox): (1) basic
  undo/redo/redo-invalidation sequence, (2) the group-race scenario above (3 independent adds,
  each undoing one object at a time, plus a 3-object grouped move undoing as one step) -- this is
  the test that caught both races described above before the Lua-script fix, and (3) a genuine
  two-process multi-instance test (ports 4201/4202, one shared Redis) confirming a client on
  instance 1 requesting undo correctly produces a `history:state` broadcast received by a client
  connected to instance 2.

## ENVIRONMENT VARIABLES
Unchanged from Phase 3 -- see `.env.example` (NEXT_PUBLIC_APP_URL, MONGODB_URI, REDIS_URL,
NODE_ENV, PORT, HOST). REDIS_URL is required.

## KNOWN ISSUES
- Still no persistence: a Redis restart or `FLUSHALL` drops room objects, participants, AND now
  the undo/redo history stacks. MongoDB models exist but aren't called. Unchanged gap from
  Phase 2/3, just now also covers history.
- History is capped at 50 entries per room (oldest silently drop off via `LTRIM`). Not currently
  configurable via env var -- a constant in `roomManager.ts`.
- Object-level conflict resolution is still last-write-wins via `HSET` (unchanged from Phase 2/3)
  -- Phase 4 added a shared *undo/redo stack*, not an OT/CRDT layer for concurrent edits to the
  SAME object at the SAME instant. This was flagged as a design question in Phase 3's roadmap and
  deliberately not addressed here either -- it's a separate problem from shared history and would
  be its own phase if it becomes a real issue at higher concurrency.
- Touch-based multi-select still not implemented (carried over from Phase 1, desktop-first).
- Rotating a points-based shape then resizing again compounds scale rather than re-baking into
  points (carried over from Phase 1/2 -- still relevant to Phase 6 snapshot replay).
- `server/index.ts` runs via `tsx` in both dev and `start` -- fine at this scale; a compiled-
  artifact deployment would need a `tsc`/`esbuild` step instead (unchanged note from Phase 3).
- Two `npm run dev` processes still can't share one checkout (Next dev-server lock) -- use
  `npm run build && npm start` for local multi-instance testing (unchanged from Phase 3).

## DECISIONS MADE
- Chose server-authoritative snapshot-based shared history over per-operation forward/inverse
  ops with an OT/CRDT layer. The existing pre-Phase-4 model was already full-canvas-snapshot-per-
  commit (just per-client); making that snapshot store shared and server-side was the smallest
  change consistent with the existing architecture, and Phase 3's own roadmap explicitly flagged
  building a real OT layer as separate, harder scope not to take on incidentally here.
- Added `groupId` to `CanvasOperation` rather than batching multiple ops into a single socket
  event, to keep the existing "one event per changed object" wire format (cheap, already proven
  in Phase 2/3) while still letting the server recognize "these N ops are one undo step."
- Made `applyCanvasOp` and `popHistory` single atomic Lua scripts only after finding races in an
  initial two-round-trip implementation via actual scripted testing -- not by static reasoning
  about Redis/Node concurrency in the abstract. Both races were real and reproducible, not
  theoretical; documented in IMPORTANT IMPLEMENTATION DETAILS above so a future phase doesn't
  reintroduce a similar check-then-act pattern for other Redis-backed features.
- Undo/redo emits `io.to(roomId)` (includes the requester), unlike normal canvas ops which use
  `socket.to(roomId)` (excludes the sender) -- because canvas ops are already applied optimistically
  on the sender's own client before broadcasting, but undo/redo has no local optimistic update
  (the shared stack is server-authoritative), so the requester needs the same broadcast as
  everyone else to see the result at all.
- Did not add MongoDB persistence this phase either -- consistent with Phase 2/3's explicit
  deferral; still out of scope until a phase specifically calls for durability across Redis
  restarts.

## NEXT PHASE
Phase 7 — WebRTC Video Call

## NEXT PHASE ROADMAP
1. Read `lib/db/models.ts` (Version model already exists) and `lib/db/mongoose.ts` before writing anything and the `participant:join`/`participant:leave`/
   `participant:cursor` handling already in `server/socket.ts` and `Canvas.tsx` before changing
   anything -- basic presence (participant list, live cursors) already exists from Phase 2; Phase
   5's job is to round it out (viewer vs. editor state, online/offline transitions beyond simple
   join/leave, cleaner reconnect handling) rather than build presence from scratch.
2. Decide what "editing" vs. "viewing" means concretely (e.g. actively drawing/dragging vs. idle)
   and how briefly that state should persist after the last op before reverting to "viewing" --
   flag the tradeoff rather than picking arbitrarily.
3. Confirm presence state survives correctly across the same multi-instance setup Phase 3/4 were
   tested against (participants list should stay accurate across a disconnect/reconnect that
   lands on a different server instance).
4. Existing participant Redis hash key (`room:{roomId}:participants`) is not itself the "who does
   what" data yet — decide whether editor/viewer state lives on the existing `Participant` object
   (extend the type) or as separate Redis keys, and update `types/index.ts` accordingly.

## HOW TO CONTINUE
1. Read PROJECT_HANDOFF.md (this file)
2. Read README.md
3. Read DAILY_PROGRESS.md
4. Start Redis locally (`redis-server`, or `docker run -p 6379:6379 redis`) -- required, the
   server will not start without it
5. Run: `npm install && npm run dev`
6. Visit http://localhost:3000, create a room, open the same room URL in a second tab, and test:
   draw a few shapes, Ctrl+Z/Ctrl+Shift+Z should undo/redo across BOTH tabs identically (shared
   history, not per-tab)
7. To verify multi-instance specifically: `npm run build`, then `PORT=4001 npm start` and
   `PORT=4002 npm start` in two terminals against the same Redis, open the same room on both
   ports in different tabs, and confirm undo on one tab is reflected on the other
8. Verified working in this session: `tsc --noEmit` clean, `eslint` clean, `next build` clean,
   and 3 scripted Socket.io tests (see IMPORTANT IMPLEMENTATION DETAILS above) -- basic undo/redo
   sequence, grouped-vs-independent-commit undo granularity (this is the test that caught the two
   races described above), and genuine two-process multi-instance cross-instance undo/redo
9. Begin Phase 5 using the roadmap above -- start by reading the existing presence code
   (`PresencePanel.tsx`, the `participant:*` events in `socket.ts`/`Canvas.tsx`) before writing
   anything new
10. Do NOT restart the project -- Phase 0-4 architecture is in place and tested
11. `roomManager.ts` remains the server-side source of truth for room state AND shared history
    (Redis-backed); `Canvas.tsx` remains the client-side source of truth for local canvas
    rendering state only -- it no longer maintains its own undo/redo history, by design

---
## PHASE 5 ADDITIONS

### What changed in Phase 5
- `types/index.ts`: `Participant` now has `lastActiveAt: number`; added `participant:update` to both `ServerToClientEvents` and `ClientToServerEvents`
- `lib/room/roomManager.ts`: added `updateParticipant(roomId, userId, patch)` — reads existing participant from Redis, merges patch, writes back
- `server/socket.ts`: added `participant:update` handler — calls `updateParticipant`, relays to room via `socket.to` (excludes sender since sender already updated local state optimistically)
- `components/canvas/Canvas.tsx`: 
  - `currentRoomId` ref added (was only `roomId` prop, which caused stale closure issues in timeout callbacks)
  - `editingTimeoutRef` + `isEditingRef` added for idle timer management
  - `broadcastEditingState(editing: boolean)`: emits `participant:update`, resets 2s idle timer on repeated calls with `editing=true`, avoids redundant emits when state unchanged
  - Fires `broadcastEditingState(true)` at top of `handleMouseDown`
  - `handleParticipantUpdate` listener added: updates `participants` state + calls `onParticipantsChange`
  - Cleanup: `editingTimeoutRef` cleared on unmount
- `components/presence/PresencePanel.tsx`: full redesign — animated avatar glow rings, bouncing-bar editing indicator, TimeAgo relative timestamps, online dot, hover states, editing count badge in header
- `components/room/RoomClient.tsx`: room info bar now shows "N editing" count when any participant is editing

### Presence design decisions
- "Editing" = any mousedown on the canvas (tool-agnostic). Reverts to false after 2s idle. This is deliberate: tracking per-tool drawing-start would be more granular but fragile; mousedown covers all interactions (draw, drag, select, resize) and a 2s timeout feels natural in practice.
- Editing state is persisted to Redis (not just relayed ephemerally) so late joiners get correct state via `room:state`. This required `updateParticipant()` rather than a cursor-style ephemeral relay.
- `socket.to()` (not `io.to()`) for participant:update — the sender already applied the state locally; broadcasting back to the sender would cause a flicker if network RTT is high.

### Next Phase Roadmap (Phase 6 — Version History)
1. Read `lib/db/models.ts` (Version model already defined) and `lib/db/mongoose.ts` (connection helper exists, not yet called anywhere) before writing anything
2. Connect MongoDB: call `connectMongo()` in `server/index.ts` startup (already has Redis connect, add Mongo alongside it)
3. Add `version:save` and `version:restore` socket handlers in `server/socket.ts` (event types already in `ClientToServerEvents` / `ServerToClientEvents`)
4. Implement snapshot save: capture current `getRoomObjects()` → save as `Version` document in MongoDB
5. Implement `version:list` server→client event + `getVersions(roomId)` query
6. Implement `version:restore`: load snapshot from MongoDB → `io.to(roomId).emit('history:state', ...)` (reuse existing history:state handler on the client — it already replaces canvas state wholesale)
7. Add `version:replay` (step through snapshots): could be client-only using fetched version list + setInterval
8. Build VersionHistoryPanel component: version list, timestamps, restore button, replay button
9. Wire panel into RoomClient layout (consider a slide-out drawer rather than permanent sidebar to avoid crowding the canvas)

---
## PHASE 6 ADDITIONS

### What changed in Phase 6
- `lib/redis/client.ts` + `lib/room/roomManager.ts`: new atomic `restoreSnapshot` Lua script/function — pushes the room's pre-restore state onto the undo stack (so a restore is itself undoable), clears redo, replaces the objects hash wholesale. Same one-atomic-script pattern as `applyCanvasOp`/`popHistory` from Phase 4, for the same reason (several logically-dependent Redis steps against shared room state).
- `lib/db/versionManager.ts` (new): `saveVersion(roomId, userId, label, snapshot)`, `listVersions(roomId)`, `getVersion(versionId)` against the existing Mongoose `Version` model (`lib/db/models.ts`, unchanged). Caps at 30 versions/room — oldest trimmed on save via a `countDocuments` + `deleteMany`.
- `types/index.ts`: added `version:list` to both `ClientToServerEvents` (request: `{roomId}`) and `ServerToClientEvents` (response: `Version[]`). `version:save`/`version:saved`/`version:restore` already existed from Phase 0's type stubs and needed no changes.
- `server/socket.ts`: added `version:save`, `version:list`, `version:restore` handlers, each wrapped in try/catch emitting a clean `error` event on failure (MongoDB unreachable, or a restore targeting a deleted/bad version id) rather than hanging the requester or crashing the process. `version:restore` reuses the existing `history:state` broadcast — no new client-side canvas-sync code needed, `Canvas.tsx` is untouched by this phase.
- `server/index.ts`: added `connectDB()` (MongoDB) at startup, called via `.catch()` rather than `await`ed alongside Redis. This is deliberate, not an oversight: MongoDB has been optional-to-run since Phase 0 (see README), and Phase 6 shouldn't quietly make it required. If Mongo is unreachable, the server logs a warning and starts normally; only the three version handlers above degrade (gracefully, via their try/catch).
- `components/version/VersionHistoryPanel.tsx` (new): slide-out drawer (backdrop + fixed-right panel, matches the app's existing dark UI). Label input + "Save current state" button, a version list (label + relative timestamp, Restore button on hover), a "Replay N versions" button, and an inline error banner for `error` events. Uses `getSocket()` directly (the existing browser socket singleton) rather than going through `Canvas.tsx`'s ref — versions are independent of canvas-local state.
- `components/toolbar/Toolbar.tsx` / `components/room/RoomClient.tsx`: added a history-icon button to open the panel; `RoomClient` owns the `versionsOpen` boolean and renders `<VersionHistoryPanel>` alongside the existing `<PresencePanel>`.
- Incidentally fixed 2 pre-existing lint errors (not part of this phase's scope, but trivial and caught by the same lint run): `Date.now()` called during render in `PresencePanel.tsx`'s `me` object — replaced with fixed sentinel values since `joinedAt`/`lastActiveAt` are never read for the local user's own row.

### Design decisions
- **Restore reuses `history:state` rather than a new event.** Every client already has correct, tested logic for "replace my whole canvas state with this array of objects" from Phase 4's undo/redo. A version restore is exactly that operation with a different data source (MongoDB instead of a popped Redis stack entry), so reusing the event avoids a second code path in `Canvas.tsx` for something that behaves identically.
- **Restore pushes onto the undo stack first (via `restoreSnapshot`'s Lua script), not a special "un-restore" op.** Keeps "undo" meaning one thing everywhere: whatever the room's object state was immediately before this action.
- **Replay is a client-driven loop of real `version:restore` calls, not a server-side replay mode.** Simpler (no new server state machine, no new socket events), and it's genuinely accurate to "replay" as everyone in the room sees each historical state live via the normal broadcast path, not just the person who clicked Replay. Trade-off: it's not cancelable mid-flight and bumps the undo stack once per replayed version (capped at 50 anyway, so bounded).
- **MongoDB connects in the background, not awaited at startup.** This preserves an explicit prior-phase guarantee (README: "MongoDB is not required to run") rather than silently tightening it. `bufferCommands: false` (already set in `lib/db/mongoose.ts` since Phase 0) makes this safe: a query against a disconnected mongoose throws immediately instead of hanging, which is exactly what the try/catch in each handler expects.
- **Versions capped at 30/room (vs. 50 for the Redis undo/redo stack).** These are deliberate user-triggered saves, not per-op snapshots, so a smaller number was chosen to keep the list scannable in a 320px-wide drawer; not tied to the undo cap for any technical reason.

### Known limitation: MongoDB happy path not exercised live
This sandbox has no MongoDB: it's not available via `apt`, and `mongodb-memory-server`'s binary
download is blocked by network egress policy here (`fastdl.mongodb.org` / `downloads.mongodb.org`
both return `host_not_allowed`). What WAS verified live: Redis running, MongoDB deliberately down,
a scripted two-client Socket.io test confirming (a) `canvas:operation` relay is unaffected by
this phase's changes, and (b) all three version handlers fail cleanly with a caught `error` event
— no hang, no server crash, server fully responsive immediately after. The actual save → list →
restore round trip against a real MongoDB was verified by code review only (straightforward
Mongoose calls against the pre-existing `Version` model), not by running it. **First thing to do
in an environment with MongoDB available: run `scripts/test-phase6.js` (or just use the UI) end to
end and confirm a saved version actually appears in the list and restores correctly** — flagging
this rather than asserting it works is the point of this note.

### Next Phase Roadmap (Phase 7 — WebRTC Video Call)
1. This is the first phase touching peer-to-peer connections rather than server-relayed state — skim `server/socket.ts`'s existing `cursor:move` handler first as the closest existing precedent for a lightweight, ephemeral (non-Redis-persisted) relay, since WebRTC signaling (offer/answer/ICE candidates) is the same shape: relay-only, no room state to persist.
2. Add signaling-only socket events (e.g. `webrtc:offer`, `webrtc:answer`, `webrtc:ice-candidate`), each just relayed via `socket.to(targetSocketId)` or `socket.to(roomId)` — no Redis/Mongo involvement, this is pure Socket.io relay like cursors.
3. Decide mesh (every pair connects directly — simpler, fine for the "multiple participants if practical" requirement at small room sizes) vs. SFU (needs a media server — likely overkill and against the "avoid paid third-party services" / "don't over-engineer" ground rules). Recommend starting with mesh given the project's stated scale.
4. Build a `useWebRTC` hook or `lib/webrtc/` module: getUserMedia, RTCPeerConnection per remote participant, camera/mic toggle state.
5. Build a floating/overlay video UI component (per the master prompt's "Video call overlay" requirement) — likely a new `components/video/VideoOverlay.tsx`, toggled from the toolbar similar to how `VersionHistoryPanel` was wired in this phase.
6. Handle cleanup on participant leave/disconnect (existing `participant:leave`/`disconnect` handlers in `socket.ts` are the place to also tear down any WebRTC signaling state, though the peer connections themselves are client-side only).
7. Test with at least 2 real browser tabs (WebRTC can't be meaningfully scripted the way Socket.io was in this and prior phases) — flag this as a real testing gap upfront, similar to this phase's MongoDB gap.

## HOW TO CONTINUE (Phase 7)
1. Read PROJECT_HANDOFF.md (this file), README.md, DAILY_PROGRESS.md
2. Start Redis locally (required). MongoDB is optional — start it too if you want to verify Phase 6's version history actually persists (this sandbox could not; see the note above)
3. Run: `npm install && npm run dev`
4. Re-verify Phase 6 still works: open a room, use the version-history (clock) button in the toolbar to save a labeled snapshot, confirm it appears in the list, draw something else, then Restore it and confirm the canvas reverts (and that Ctrl+Z after a restore undoes the restore, not something older)
5. If MongoDB is available: this is also the first opportunity to confirm the actual save/list/restore round trip end-to-end, which this session could not do
6. Begin Phase 7 using the roadmap above
7. Do NOT restart the project — Phase 0-6 architecture is in place and tested (module the MongoDB-happy-path caveat above)

---
## GITHUB-READINESS PASS (2026-08-30, no feature work)

README.md was fully rewritten (hero image, badges, screenshots section using new `public/readme/`
SVG assets, architecture diagram, reorganized by-capability feature list, tech stack table,
project structure tree, corrected roadmap checklist, consolidated Known Limitations). Also added:
`LICENSE` (MIT), `CONTRIBUTING.md`, `.github/workflows/ci.yml` (tsc + eslint + build on push/PR),
and `.gitignore` (this last one was actually missing since Phase 0 despite being required by the
master prompt — added in the Phase 6 session, noted here again for visibility). `eslint.config.mjs`
now ignores `scripts/**` (the Phase 6 test script isn't part of the Next.js app and doesn't need
app lint rules applied to it).

None of this changed any application code path — `tsc --noEmit`, `eslint .`, and `next build` were
all re-verified clean after. Screenshots in the README are hand-built SVG mockups matching the real
component styling, not actual screen captures (no browser available in that environment) — swap in
real ones under `public/readme/` whenever convenient, filenames are already referenced correctly.


