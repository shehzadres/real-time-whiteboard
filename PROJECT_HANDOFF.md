---
# PROJECT HANDOFF

## PROJECT
Real-Time Collaborative Whiteboard

## Current Phase
Phase 9 — Security & Production Hardening

## Phase Status
COMPLETE. Runtime validation (zod) + Redis-backed rate limiting + server-side identity binding
added to every Socket.io handler and the REST room-creation route, plus baseline HTTP security
headers. No authentication was added -- a deliberate scope decision, see PHASE 9 ADDITIONS below.
Verified with a new live scripted test (`scripts/test-phase9.mjs`, 11/11) plus regression runs of
the existing Phase 7 socket test and the Phase 8 shape-recognizer unit tests.

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
## PHASE 7 ADDITIONS

### What changed in Phase 7
- `types/index.ts`: added `WebRTCSignal` union type (`offer` / `answer` / `ice-candidate`), added
  `inCall?: boolean` to `Participant`, added `webrtc:signal` to both `ServerToClientEvents` and
  `ClientToServerEvents`. Broadened `participant:update` on both sides so `isEditing` and `inCall`
  are each optional and independently patchable — a video-call join no longer needs to (and
  doesn't) touch `isEditing`, and vice versa.
- `server/socket.ts`: `participant:update` handler now builds a partial patch from only the fields
  present in the incoming payload (`lastActiveAt` is always refreshed, `isEditing`/`inCall` only if
  provided) before calling `updateParticipant`, and re-emits only what was actually patched. Added
  `webrtc:signal` — a pure `socket.to(roomId)` relay of `{from, to, signal}`, no Redis/Mongo
  involvement, same ephemeral treatment as `cursor:move`. There's no per-user socket-id tracking,
  so this broadcasts to the whole room and each client is expected to ignore anything where
  `to !== myUserId`.
- `lib/webrtc/useWebRTC.ts` (new): the mesh WebRTC hook. Takes `{roomId, userId, participants,
  active}` and returns local/remote streams plus mic/camera toggle state. Key design points:
  - **Mesh, not SFU.** Every in-call participant opens a direct `RTCPeerConnection` to every other
    in-call participant. Fine at the small room sizes this project targets; an SFU would need a
    self-hosted (or paid) media server, which the master prompt explicitly says to avoid.
  - **STUN only, no TURN.** Uses Google's public STUN servers. No relay fallback for peers both
    behind symmetric NATs — documented as a known limitation, not solved, consistent with this
    project's pattern of flagging real gaps instead of quietly working around them with paid
    infrastructure.
  - **Who offers whom is decided by comparing `userId` strings** (`myId < peerId` → I send the
    offer), not by a server-assigned role. This deterministically avoids both sides of a pair
    sending simultaneous offers ("glare") without any extra signaling round trip.
  - **Connection membership is driven by the `inCall` flag already on `Participant`**, not by a
    separate call-membership socket event. `startCall()` only broadcasts `inCall:true` (via
    `participant:update`) *after* `getUserMedia` has actually resolved, which guarantees that by
    the time any peer reacts to that flag and sends us an offer, our local tracks already exist to
    add to the answer — no readiness race between "I said I'm in the call" and "my camera is
    actually ready."
  - A `wasActiveRef` guards the join/leave effect so mounting with `active=false` doesn't fire a
    spurious `inCall:false` broadcast on first render.
- `components/video/VideoOverlay.tsx` (new): floating bottom-right panel (not another right-side
  drawer like Presence/Versions — deliberately a floating overlay per the master prompt's "Video
  call overlay" wording). Shows a 2-column grid of video tiles (self + each remote peer, falling
  back to an initials avatar when camera is off or stream isn't ready yet), mic/camera toggle
  buttons, and a Leave button. Closing the panel (✕) does **not** end the call — it minimizes to a
  small pulsing "Call · N" pill in the same corner, so audio/video keeps flowing while the user
  works on the canvas; clicking the pill reopens the full panel. This required decoupling "is the
  panel visible" (owned by `RoomClient`, mirrors `versionsOpen`) from "is media flowing"
  (owned internally by `VideoOverlay`'s own `active` state) — the two were kept as separate booleans
  on purpose rather than collapsing them into one.
- `components/toolbar/Toolbar.tsx` / `components/room/RoomClient.tsx`: added a 🎥 button next to
  the existing 🕐 version-history button; `RoomClient` owns `videoOpen` and always mounts
  `<VideoOverlay>` (same always-mounted-but-conditionally-visible pattern `VersionHistoryPanel`
  already uses), so `isOpen=false` never tears down an in-progress call.
- `components/presence/PresencePanel.tsx`: added a small 🎥 indicator next to any participant whose
  `inCall` is true — a low-cost way to see who's in the call without opening the video panel.
- `components/canvas/Canvas.tsx`: `handleParticipantUpdate` now merges only the fields present in
  the incoming payload (spread + conditional field assignment) instead of assuming `isEditing` is
  always sent — needed once `participant:update` started carrying `inCall`-only updates too.

### Design decisions
- **Reused the existing `Participant`/`participant:update` plumbing for call membership instead of
  inventing `video:join`/`video:leave` events.** `inCall` is presence data in exactly the same
  sense `isEditing` already was (Phase 5) — persisted to Redis so late joiners see who's currently
  in the call via the normal `room:state` snapshot, broadcast the same way, no new server-side
  concept needed.
- **Signaling relay is room-wide with client-side `to` filtering, not targeted by socket id.** The
  server has never tracked per-user socket ids (Socket.io rooms are enough for every other
  feature); adding that just for WebRTC felt like scope creep for a project this size. The
  bandwidth cost is broadcasting offer/answer/ICE payloads to everyone in the room instead of just
  the intended peer, which is negligible at the room sizes this project targets.
- **No call size cap enforced.** Mesh cost grows O(N²) in peer connections; not a problem worth
  solving preemptively without evidence real rooms need more than a handful of simultaneous video
  participants — flagged here rather than guessed at.
- **Camera/mic toggle mutes `MediaStreamTrack.enabled` rather than stopping/removing tracks.**
  Keeps the peer connection and negotiated media sections stable (no renegotiation needed to
  toggle back on), at the cost of the muted track still technically transmitting silence/black
  frames rather than freeing the hardware — an acceptable tradeoff for a toggle that's expected to
  be flipped frequently mid-call.

### Known limitation: real peer-to-peer media flow not exercised live
This sandbox has no way to run two real browser tabs with camera/microphone access, so the actual
audio/video negotiation and media flow was **not** verified end-to-end here — same category of gap
as Phase 6's MongoDB happy path. What WAS verified live (`scripts/test-phase7.mjs`, Redis running,
two real Socket.io clients): (a) `participant:update` correctly relays an `inCall:true` patch
without touching `isEditing`, and a later `isEditing`-only patch doesn't clobber `inCall` in the
emitted payload; (b) `webrtc:signal` correctly relays offer, answer, and ICE-candidate payloads
with `from`/`to`/`kind`/`sdp`/`candidate` intact; (c) pre-existing `canvas:operation` relay is
unaffected by this phase's changes. **First thing to do in an environment with two real browsers
available:** open the same room in two tabs (ideally two different machines/networks, since same-
machine-two-tabs can behave differently for camera access and NAT traversal), click "Join call" on
both, and confirm video/audio actually appears in both directions — flagging this rather than
asserting it works is the point of this note, exactly as Phase 6 did for MongoDB.

### Next Phase Roadmap (Phase 8 — AI Shape Recognition)
1. Master prompt scope: let users draw a rough shape (circle, rectangle, arrow) and have it
   snapped to a clean version. Master prompt explicitly says to prefer a solution that doesn't
   require an expensive paid AI API — this points toward a geometric/heuristic classifier (analyze
   the drawn point path's shape: closed vs open, aspect ratio, corner count via angle changes,
   etc.) rather than calling out to a vision model, consistent with this project's "avoid paid
   third-party services" pattern in Phases 3 and 7.
2. Natural integration point: `Canvas.tsx`'s pen tool already collects a raw point path per stroke
   (see the `pen` case in the drawing handlers) before committing it as a `CanvasObject` of type
   `'pen'`/freehand. Recognition should run at commit time (mouseup), not live during the stroke —
   classify the finished path, and if it confidently matches a known shape, replace the committed
   object with the corresponding clean shape type (`rectangle`/`circle`/`arrow`) instead of the raw
   point cloud, before it's broadcast via `canvas:operation`. This keeps recognition entirely
   client-side and pre-broadcast, so remote peers just see a normal `add` op for a clean shape —
   no new server or wire-format work needed.
3. Needs a clear confidence threshold and a fallback: if the drawn path doesn't confidently match
   any known shape, leave it as freehand rather than forcing a bad match — this should be a
   deliberate, stated threshold choice, not silently baked in.
4. Consider a toggle (toolbar button or pen-tool submode) rather than always-on recognition, since
   always-on could surprise users who genuinely want freehand strokes to stay freehand.
5. Performance-conscious per the master prompt: this needs to run synchronously (or fast enough to
   feel synchronous) on stroke completion — a heuristic geometric classifier should comfortably
   meet this without needing a worker thread, but confirm with a rough timing check once built
   rather than assuming.

## HOW TO CONTINUE (Phase 8)
1. Read PROJECT_HANDOFF.md (this file), README.md, DAILY_PROGRESS.md
2. Start Redis locally (required). MongoDB optional (Phase 6 version history). No new env vars
   from Phase 7 — WebRTC uses only public STUN servers, nothing to configure.
3. Run: `npm install && npm run dev`
4. Re-verify Phase 7: open a room in two tabs, click the 🎥 button, click "Join call" in both —
   confirm the panel shows both video tiles (or initials avatars if camera permission is denied)
   and that closing the panel (✕) leaves a reopenable "Call · N" pill rather than ending the call.
   This is also the first real opportunity to confirm actual media flow, which this session could
   not verify (see the Known Limitation note above).
5. Run `node scripts/test-phase7.mjs` against a running dev server (`PORT` matching the script's
   `URL`, currently 4301 — adjust either to match) to re-confirm the signaling relay and inCall
   presence patch logic before making further changes there.
6. Begin Phase 8 using the roadmap above
7. Do NOT restart the project — Phase 0-7 architecture is in place and tested (modulo the two
   flagged live-verification gaps: MongoDB happy path from Phase 6, real WebRTC media flow from
   Phase 7)

---
## PHASE 8 ADDITIONS

### What changed in Phase 8
- `lib/canvas/shapeRecognizer.ts` (new): pure-geometry classifier, no dependencies, no React/DOM
  reference — takes a flat `[x0,y0,x1,y1,...]` point array and returns a `RecognizedShape`
  (`rectangle` / `circle` / `triangle` / `arrow`) or `null`. Algorithm:
  1. Compute bounding box + diagonal; reject strokes under 12px diagonal (accidental click-drags).
  2. Decide open vs. closed by whether the stroke's start and end points are within 28% of the
     bbox diagonal of each other.
  3. **Closed**: smooth the path (moving-average, window 3) to absorb hand tremor, then run
     Ramer-Douglas-Peucker simplification (epsilon = 6% of diagonal) to find corners, deduping
     points closer than 5% of the diagonal. Exactly 3 corners → triangle; exactly 4 → rectangle.
     Anything else falls back to an isoperimetric-quotient circularity check
     (`4·π·area / perimeter²`, shoelace-formula area) — above 0.75 → circle/ellipse (bbox-centered,
     radii from bbox half-width/half-height); otherwise `null` (left as freehand — tested against a
     5-pointed star to confirm it doesn't force-match).
  4. **Open**: reject if start-to-end span is under 50% of the bbox diagonal (a curl that
     happens to end near its own extent, not a deliberate stroke) or if any point deviates more
     than 12% of the span from the straight start-end chord (too wavy). Otherwise → arrow,
     using just the stroke's first and last point as its two endpoints.
- `components/canvas/Canvas.tsx`: added `aiRecognition: boolean` prop and a `maybeRecognizeShape`
  helper called from `handleMouseUp` right before a valid pen stroke is committed. Only ever
  transforms the object being committed (id/stroke/strokeWidth/fill preserved, geometry replaced)
  or returns it unchanged — never drops a stroke. Runs client-side, pre-broadcast: remote peers
  just receive a normal `add` operation for whatever shape type was decided locally, so no
  `types/index.ts`, `server/socket.ts`, or `roomManager.ts` changes were needed at all this phase.
- `components/toolbar/Toolbar.tsx`: added a ✨ toggle button (near the tool list, since it only
  affects the Pen tool) with `aiRecognition`/`onToggleAiRecognition` props, active-state styling
  matching the existing tool-selection buttons.
- `components/room/RoomClient.tsx`: owns the `aiRecognition` boolean (default `false`), passed to
  both `Toolbar` and `Canvas`.
- `scripts/test-shape-recognizer.mjs` (new): synthetic-stroke unit tests for the classifier —
  generates jittered point paths for rectangles/triangles/circles/ellipses/straight-strokes (with
  a seeded PRNG for reproducibility) plus negative cases (random scribble, tiny click-drag, wavy
  sine-wave stroke, 5-pointed star), and asserts each classifies correctly. Run with
  `npx tsx scripts/test-shape-recognizer.mjs`. No browser, server, Redis, or MongoDB needed — this
  phase's core logic is pure and testable in complete isolation, unlike every prior phase.

### Design decisions
- **Geometric heuristic, not an ML/vision model.** The master prompt explicitly calls for an
  architecture that doesn't require an expensive paid AI API; a small, fast, fully-offline
  classifier meets the "rough circle → clean circle" style requirement without any external
  dependency, consistent with this project's STUN-only (Phase 7) and no-paid-services pattern.
- **Recognition happens once, at stroke completion (mouseup), not live during the stroke.** Live
  reclassification on every `mousemove` would flicker the in-progress shape and cost CPU for no
  real benefit — the master prompt's "performance-conscious" requirement is trivially satisfied by
  running a synchronous, sub-millisecond classifier a single time per stroke instead.
- **Off by default, toolbar toggle, pen-tool-only.** Always-on recognition would silently mutate
  strokes from users who want genuine freehand drawing (a sketch, handwriting-adjacent squiggle,
  etc.) with no way to opt out short of undo. The dedicated rectangle/circle/line/arrow/triangle
  tools are untouched by this phase — they already produce clean shapes directly and have no
  reason to run through a recognizer.
- **Corner detection takes priority over the circularity check**, not the reverse. An earlier
  version checked roundness (centroid-distance variance) first and it misclassified rectangles as
  circles at low jitter (a distance-based roundness metric is misleadingly low for a rectangle
  sampled with the same point density per edge regardless of edge length). Ordering corner
  detection first — trusting a clean 3- or 4-corner result outright, and only falling back to a
  circularity check when no clean polygon is found — fixed this and is more specific/robust in
  general: a real polygon reliably produces a stable small corner count, while "roundness" is a
  fuzzier signal that a genuinely round shape and a sampling artifact can both satisfy. Caught by
  testing (`scripts/test-shape-recognizer.mjs`), not by inspection — documented here so a future
  change to this file doesn't reintroduce a roundness-first ordering.
- **Straight open strokes become arrows, not plain lines.** A deliberate, explicit call flagged
  rather than picked silently: on a whiteboard, a quick straight freehand gesture is overwhelmingly
  used to point at or connect something, and the dedicated Line tool remains available for anyone
  who wants an explicit plain line untouched by recognition. This directly fulfills the master
  prompt's own arrow example ("rough arrow → clean arrow") without needing arrowhead-specific
  stroke detection (e.g. a hook/barb at the stroke's end), which would need a much more complex
  heuristic for a small accuracy gain.
- **Moving-average smoothing (window 3) before corner detection, not before the circularity
  check.** Smoothing helps corner detection specifically (it blurs jitter without erasing real
  corners at this window size); applying it to the circularity check as well was tried and made no
  measurable difference in testing, so it was left out of that path to keep the circularity
  calculation working on the actual traced path.
- **Confidence thresholds are named constants at the top of `shapeRecognizer.ts`**, each with a
  one-line comment on what it controls and why that value — chosen by iterating against the test
  harness (e.g. the circularity cutoff of 0.75 sits deliberately between a triangle's ~0.60 and a
  square's ~0.785, so a clean square is still caught by the corner check first rather than ever
  reaching the circularity fallback). If recognition feels too eager or too reluctant once used
  with real strokes, these are the values to adjust — nothing else in the file should need to
  change.

### Known limitation: accuracy at high jitter, and untested against real human strokes
`scripts/test-shape-recognizer.mjs`'s core suite (rectangles, triangles, circles, ellipses,
straight-strokes, and four negative cases, all at a realistic ~3px jitter) is 29/29. A separate,
explicitly non-gating stress test at 10px jitter on a 250x150 rectangle (a genuinely hard case for
a pure-geometry approach) recognizes 3/5 — reported in the test output, not silently accepted or
hidden. Additionally: all test input here is *synthetic* (programmatically generated polylines with
random jitter), not captured from an actual human drawing with a mouse or touchscreen in a browser.
Real strokes have different noise characteristics (variable speed, pauses, overshoot at corners)
that synthetic jitter only approximates. **First thing to do in an environment with a real browser
available:** open the whiteboard, enable the ✨ toggle, and hand-draw a few rough shapes to see how
the thresholds feel in practice — flagging this rather than asserting the synthetic test results
generalize perfectly is the point of this note, same pattern as Phase 6's MongoDB and Phase 7's
WebRTC media-flow caveats.

### Next Phase Roadmap (Phase 9 — Security & Production Hardening)
1. Master prompt scope: input validation, auth/session security if auth is introduced, room
   access control, socket security, rate limiting, environment variables, error handling, MongoDB
   security, Redis security, WebRTC security considerations, XSS protection, production config.
2. This project currently has **no authentication at all** — `userId` is a client-generated,
   client-trusted value from `lib/canvas/userStore.ts` (localStorage), and `roomId` is an
   unguessable-but-unauthenticated slug from `lib/room/roomId.ts`. Decide explicitly whether Phase
   9 introduces real auth (a scope increase beyond "harden what exists") or hardens the current
   trust model as-is (rate limiting, input validation, socket payload validation) without adding
   accounts — flag this as a real decision point rather than picking silently, since it changes
   the shape of the phase significantly.
3. Concrete gaps to review: `server/socket.ts` handlers currently trust `roomId`/`userId` values
   from the client on every event with no server-side ownership check (e.g. nothing stops client A
   from emitting `history:undo` claiming to be `userId` B); no rate limiting on `canvas:operation`
   or `cursor:move` (a malicious/buggy client could flood the room); no payload size/shape
   validation on socket events beyond what TypeScript types suggest at compile time (types don't
   validate at runtime) — consider a schema validator (e.g. zod, not yet a dependency) at the
   socket entry points.
4. `app/api/rooms/route.ts` (REST room creation) — review for injection/validation gaps.
5. Review `.env.example` / `.gitignore` for anything that should be tightened before this is
   pushed to a real GitHub repo (this was already deliberately kept out of git from Phase 0, but
   worth a final pass).
6. XSS: canvas text objects (`type: 'text'`) store user-entered strings rendered via Konva's
   `<Text>` (canvas-drawn, not raw DOM `innerHTML`), which is inherently not an XSS vector the way
   raw HTML injection would be — confirm this reasoning holds rather than assuming, and check
   whether any other user-supplied string (room names, version labels, usernames) ever reaches
   real DOM `innerHTML`/`dangerouslySetInnerHTML` anywhere in the app (a quick grep first).

## HOW TO CONTINUE (Phase 9)
1. Read PROJECT_HANDOFF.md (this file), README.md, DAILY_PROGRESS.md
2. Start Redis locally (required). MongoDB optional. No new env vars from Phase 8.
3. Run: `npm install && npm run dev`
4. Re-verify Phase 8: open a room, click the ✨ toggle, draw a rough circle/rectangle/triangle/
   straight line with the Pen tool and confirm each snaps to the clean shape; draw a scribble and
   confirm it stays freehand. This is also the first real opportunity to test the classifier
   against actual human-drawn strokes, which this session could not do (see Known Limitation
   above).
5. Run `npx tsx scripts/test-shape-recognizer.mjs` to re-confirm the classifier logic before
   touching `lib/canvas/shapeRecognizer.ts` further — it needs no server/Redis/Mongo, unlike every
   other test script in this project.
6. Begin Phase 9 using the roadmap above — start by deciding the auth-scope question (point 2)
   before writing any code, since it changes what "harden" means for this phase.
7. Do NOT restart the project — Phase 0-8 architecture is in place and tested (modulo the three
   flagged live-verification gaps: MongoDB happy path from Phase 6, real WebRTC media flow from
   Phase 7, and real human-drawn-stroke accuracy from Phase 8)


## PHASE 9 ADDITIONS

### What changed in Phase 9
- Added `lib/security/validation.ts`: zod schemas for every `ClientToServerEvents` payload
  (`room:join`, `canvas:operation`, `cursor:move`, `participant:update`, `history:undo/redo`,
  `version:save/list/restore`, `webrtc:signal`, `room:leave`) and the `/api/rooms` POST body.
  `parseOr(schema, data)` returns the parsed value or `null` (never throws), so every socket
  handler stays a one-line early return on invalid input instead of a try/catch per call. Size
  caps live here too: `CanvasObject.data` (freeform per-tool fields) capped at 200KB serialized;
  WebRTC SDP/ICE payloads capped at 20KB.
- Added `lib/security/rateLimiter.ts`: `checkRateLimit(key, limit, windowSeconds)` is a Redis
  `INCR` + conditional `EXPIRE` fixed-window counter -- one round trip, no Lua script needed (unlike
  Phase 4's history operations, this has no multi-step race to close). `checkEventRateLimit(event,
  userId)` wraps it with the per-event limits in `RATE_LIMITS`. Redis-backed (not in-process) so
  the limit is per-user across the whole deployment, consistent with roomManager/Socket.io-adapter
  already being Redis-backed for the same multi-instance reason.
- `server/socket.ts` rewritten: every `socket.on(...)` handler now (a) rate-limits by the
  connection's own bound `currentUserId` (or by IP for `room:join`, before an identity exists),
  (b) validates the payload with the matching zod schema and drops silently (no error emitted --
  a malformed/hostile payload gets no signal back) on failure, (c) for anything
  security-relevant, uses `currentUserId`/`currentRoomId` (set once at `room:join`, never
  reassigned from a later payload) instead of the client-sent `userId`/`roomId`/`from` fields in
  that event. `version:restore` additionally checks the fetched version's `roomId` matches the
  requesting room (a version could otherwise be restored cross-room by guessing/enumerating a
  `versionId`).
- `app/api/rooms/route.ts`: zod-validated body, IP-scoped rate limit (20/min). Note: this route is
  not actually called by the current UI (`app/page.tsx` generates the room id client-side and
  navigates directly to `/room/[roomId]` -- unchanged since Phase 0/2) but was hardened anyway
  since it's still a reachable public endpoint.
- `next.config.ts`: added a `headers()` function applying CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a
  `Permissions-Policy` scoping camera/microphone to `self` (this app's own WebRTC call) and
  denying everything else, to every response.
- `lib/canvas/userStore.ts`: `updateUsername` now trims and caps at 40 chars client-side, mirroring
  the server-side `userSchema` bound -- UX only (fail fast, no round trip), the server never
  trusts this.
- No code change to `lib/db/mongoose.ts` / `lib/redis/client.ts` connection strings: both already
  read a full `MONGODB_URI`/`REDIS_URL` from env, which already supports credentials and TLS
  (`mongodb+srv://user:pass@host/db?tls=true`, `rediss://user:pass@host:port`) -- adding
  separate username/password/TLS env vars would just be redundant config surface for something
  the URL scheme already covers. This is a deployment-time responsibility (set the URL correctly
  in production), not something Phase 9 needed to add code for.

### Design decisions
- **Hardened the existing no-auth trust model; did not add authentication.** This was the
  explicit decision point flagged in Phase 8's `PROJECT_HANDOFF.md` roadmap (point 2), decided
  before writing any code rather than picked silently. Adding real accounts (signup/login,
  session tokens, per-room access control tied to an identity provider) is a scope increase well
  beyond "harden what exists" -- it changes the room-sharing model itself (currently: anyone with
  the unguessable room URL can join as any self-chosen username, by design, since the master
  prompt's own Phase 2 spec calls for shareable invite links with no mention of accounts). What
  Phase 9 does instead is make that existing model safe to run: a client can no longer forge
  another user's identity mid-session (the actual concrete risk in a no-auth design), flood the
  server, or send malformed data that reaches Redis/Mongo unchecked. If real authentication is
  wanted later, it's a new, larger phase, not a Phase 9 addendum.
- **Identity bound once at `room:join`, never re-trusted from later payloads** -- rather than,
  e.g., re-validating a signed token per event (which would require the auth system explicitly
  deferred above) or trusting the client-sent `userId` field on each event (the pre-Phase-9
  behavior, and the actual gap this closes). Binding at join and reading from the closure variable
  for every subsequent event is the smallest change that stops identity spoofing without
  introducing an auth system -- it doesn't prove a `userId` is really "owned" by anyone (there's
  still no login), but it does guarantee one socket connection can't act as two different
  identities in the same session, which is what made spoofing possible before.
- **Invalid/rate-limited events are dropped silently, not rejected with an `error` event.** An
  `error` emit back to a client that just sent a malformed or spoofed payload would (a) help an
  attacker iterate toward a payload that passes validation, and (b) has no legitimate use for a
  well-behaved client, since a well-behaved client only ever sends valid payloads under its own
  identity in the first place. This is different from the existing `version:*` error emits (kept
  unchanged), which report genuine backend failures (MongoDB down) to a legitimately-behaving
  client, not a validation/ownership rejection.
- **Fixed-window rate limiting (Redis `INCR`+`EXPIRE`), not a sliding window or token bucket.**
  One round trip, no Lua script. The burst-at-window-boundary imprecision fixed windows have (a
  client could in principle send ~2x the nominal limit right at a window edge) is an accepted
  tradeoff here -- this is anti-flood/anti-abuse protection, not billing-grade metering, and the
  limits themselves (e.g. 60 canvas ops/sec) are already well above legitimate single-user usage,
  so the imprecision doesn't meaningfully weaken the protection.
- **Size caps on `CanvasObject.data` and WebRTC signal payloads instead of a strict per-field
  schema for either.** Both are intentionally open-ended (different tools/browsers populate
  different fields), and schema-validating every field per shape type would need updating every
  time a tool gains a field -- exactly the coupling the master prompt's "avoid over-engineering"
  guidance warns against. A byte-size cap catches the actual risk (a client sending an absurdly
  large payload to bloat Redis/Mongo or blow up a broadcast) without that coupling.
- **CSP still allows `'unsafe-inline'`/`'unsafe-eval'` on `script-src`**, flagged rather than
  silently accepted: Next.js's own dev/runtime bootstrap needs them, and a nonce-based CSP tight
  enough to drop them would need a custom middleware layer generating a per-request nonce and
  threading it through `<Script>` tags -- real additional work, not a one-line header change, so
  it's called out here as a genuine follow-up rather than attempted incidentally in this phase.

### Known limitation: no rate-limit evasion via userId cycling is fully closed
Because there's still no authentication, a misbehaving client that disconnects and reconnects
with a freshly-generated `userId` (trivial -- `lib/canvas/userStore.ts` stores it in
`localStorage`, which a client fully controls) gets a fresh rate-limit quota, since limits are
keyed by `userId`. IP-based limiting on `room:join` slows this down somewhat (a new identity still
has to go through a fresh join) but doesn't eliminate it for an attacker with many IPs. This is an
inherent consequence of the no-auth decision above, not an oversight -- closing it fully would
require either per-connection (not per-claimed-identity) limiting in addition, or real
authentication. Flagged here rather than assumed solved.

### Next Phase Roadmap (Phase 10 — Testing & Finalization)
1. Master prompt scope: test multiple clients, multiple rooms, concurrent editing,
   disconnect/reconnect, undo/redo, export, version restore, video, AI recognition, responsive
   UI, error states; fix discovered issues; clean unused files/dependencies; prepare final
   GitHub-ready project.
2. This project has three explicitly-flagged live-verification gaps from earlier phases that
   Phase 10 is the natural point to close, given a real browser environment: MongoDB happy path
   (Phase 6), real two-browser WebRTC media flow (Phase 7), and shape-recognizer accuracy against
   actual human-drawn strokes rather than only synthetic point paths (Phase 8). None of these were
   fixable in this sandbox (no browser with camera access, no MongoDB binary available here); they
   remain the top verification priority once a full environment is available, not new work.
3. `app/api/rooms/route.ts` is dead code (unused by the current UI, confirmed again in Phase 9) --
   decide whether Phase 10 removes it or leaves it as a documented public API surface; either is
   reasonable, but leaving it unaddressed silently is not.
4. Sweep for unused dependencies/files per the master prompt's Phase 10 instructions --
   `lib/db/mongoose.ts`/`models.ts` are used (version history), but worth a final check that
   nothing else accumulated across 9 phases is now dead.
5. Pre-existing eslint warnings noticed during Phase 9 (not introduced by Phase 9, not fixed
   since out of that phase's scope): a `require()`-style import in `scripts/test-phase6.js`
   (1 error) and a couple of unused-variable warnings in `PresencePanel.tsx`. Worth cleaning up
   as part of Phase 10's "clean unused files" pass.
6. Fix discovered issues per the master prompt's rule -- don't hide errors by disabling
   functionality; document genuine blockers rather than silently dropping features.

## HOW TO CONTINUE (Phase 10)
1. Read PROJECT_HANDOFF.md (this file), README.md, DAILY_PROGRESS.md
2. Start Redis locally (required). MongoDB optional but strongly recommended for this phase
   specifically, since closing the Phase 6 MongoDB-happy-path gap is Phase 10's top item. No new
   env vars from Phase 9.
3. Run: `npm install && npm run dev`
4. Re-verify Phase 9 first: run `node scripts/test-phase9.mjs` against a running server (11/11
   expected) to confirm hardening still holds before testing anything else.
5. Work through the master prompt's Phase 10 checklist directly against a real browser: multiple
   tabs/clients, multiple rooms, concurrent editing, disconnect/reconnect, undo/redo, export,
   version save/restore (with MongoDB actually running this time), video call between two real
   tabs with camera/mic access, AI shape recognition with actual hand-drawn strokes, responsive
   layout, and error states (kill Redis mid-session, kill MongoDB mid-session, send malformed
   input via devtools console and confirm Phase 9's validation holds).
6. Address the roadmap items above, in particular the three flagged live-verification gaps --
   this is the first phase with a plausible real environment to close them in.
7. Do NOT restart the project — Phase 0-9 architecture is in place and tested (modulo the
   flagged live-verification gaps above, which are exactly what Phase 10 exists to close)
