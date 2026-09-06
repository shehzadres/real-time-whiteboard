<div align="center">

<img src="./public/readme/hero-banner.svg" alt="Whiteboard — real-time collaborative canvas" width="100%" />

<br/>

[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Socket.io](https://img.shields.io/badge/Socket.io-real--time-010101?logo=socket.io&logoColor=white)](https://socket.io/)
[![Redis](https://img.shields.io/badge/Redis-pub%2Fsub%20%2B%20state-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![MongoDB](https://img.shields.io/badge/MongoDB-version%20history-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![CI](https://img.shields.io/github/actions/workflow/status/OWNER/REPO/ci.yml?branch=main&label=CI)](../../actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**A production-oriented real-time collaborative whiteboard.**
Draw together, see everyone's cursor, undo as a group, and roll back to any earlier version —
all synced live over Socket.io and Redis.

</div>

---

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Screenshots

| Canvas & Toolbar | Live Presence | Version History |
|:---:|:---:|:---:|
| ![Canvas](./public/readme/screenshot-canvas.svg) | ![Presence](./public/readme/screenshot-presence.svg) | ![Version History](./public/readme/screenshot-versions.svg) |
| Shapes, freehand drawing, text, and per-user live cursors | Who's viewing, who's editing, updated live | Save, browse, and restore labeled snapshots |

> These are illustrative mockups of the actual UI (built from the real component styling), not
> screen captures — this environment can't run a browser to grab live screenshots. Swap in real
> ones from `npm run dev` whenever convenient; the layout and colors already match.

## Features

**Canvas & Drawing**
- Freehand pen, rectangle, circle, line, arrow, triangle, and text tools
- Select (click, shift-click, marquee drag), move, resize + rotate (transformer), duplicate, delete
- Stroke/fill color swatches plus a custom color picker
- Zoom (wheel + toolbar) and pan; PNG and real PDF export (client-side, via `jsPDF`)

**Real-Time Collaboration**
- Room-based sessions with shareable invite links
- Every draw/move/resize/rotate/delete/duplicate syncs live as a per-object operation (not full
  canvas snapshots), fanned out via a Socket.io + Redis Pub/Sub adapter across multiple server
  instances
- Presence: live participant list, viewing vs. editing state, and named live cursors
- Reconnect handling — a dropped client rejoins and gets a fresh state snapshot

**Shared History**
- A single server-authoritative undo/redo stack per room, not per client — undo/redo is a server
  round trip whose result is broadcast to everyone
- Multi-object commits (group-drag, multi-delete) undo/redo as one step via a per-commit `groupId`
- Undo/redo apply + bookkeeping run as one atomic Redis Lua script per operation

**Version History**
- Save a labeled snapshot of the canvas at any time; browse past versions in a slide-out drawer
- Restore any version — reuses the same shared-state broadcast as undo/redo, and is itself
  undoable afterward with a normal Ctrl+Z
- Replay: step through every saved version live, visible to the whole room
- Snapshots persist in MongoDB, independent of Redis's ephemeral undo/redo stacks

See [Roadmap](#roadmap) for what's implemented vs. planned (video calls, AI shape recognition,
production hardening).

## Architecture

<img src="./public/readme/architecture.svg" alt="Architecture diagram" width="100%" />

```
Client ──▶ Socket.io ──▶ Server instance ──▶ Redis Pub/Sub ──▶ Other server instances ──▶ Clients
                                    │
                                    └──▶ MongoDB (version snapshots only — optional service)
```

- **Redis** is the source of truth for live room state (canvas objects, participants, undo/redo
  stacks) and is required at runtime from Phase 3 onward.
- **MongoDB** is used only for saved version snapshots (Phase 6). It connects in the background
  and is never awaited at startup — the rest of the app works with zero MongoDB running.
- Canvas operations are sent as small per-object ops, not full-canvas payloads, to keep
  broadcast size independent of canvas complexity.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (custom server for Socket.io), TypeScript, Tailwind CSS |
| Canvas | Konva.js / react-konva |
| Real-time | Socket.io + `@socket.io/redis-adapter` |
| Shared state | Redis (hashes for objects/participants, lists for undo/redo, atomic Lua scripts) |
| Persistence | MongoDB + Mongoose (version snapshots) |
| Export | `jsPDF`, Konva `toDataURL` |
| Video (planned) | WebRTC, no paid third-party service |

## Getting Started

```bash
npm install
cp .env.example .env.local
npm run dev
```

`npm run dev` runs the custom Socket.io + Next.js server (`server/index.ts`) via `tsx`, so
real-time collaboration works out of the box. Use `npm run dev:next-only` if you only need the
Next.js routes without the socket server (no real-time collaboration in that mode).

Open **http://localhost:3000**.

**Redis is required from Phase 3 onward.** Room state and the Socket.io adapter both depend on
it. Run one locally before starting the app:
```bash
redis-server
# or
docker run -p 6379:6379 redis
```

**MongoDB is optional**, used only for Save/Restore Version. If it's unreachable, the server logs
a warning and keeps running — only the version-history panel shows an error instead of hanging.
```bash
mongod
# or
docker run -p 27017:27017 mongo
```

### Running multiple server instances (to see the Redis fan-out work)

Next's dev server locks `.next/` per checkout, so two `npm run dev` processes can't share one. Use
a production build instead:
```bash
npm run build
PORT=4001 npm start   # terminal 1
PORT=4002 npm start   # terminal 2
```
Both point at the same `REDIS_URL`. Open the same room on `:4001` and `:4002` in different tabs —
cursors, presence, and canvas operations sync across the two processes exactly as they would
across two instances behind a real load balancer.

## Environment Variables

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
MONGODB_URI=mongodb://localhost:27017/whiteboard   # optional — version history only
REDIS_URL=redis://localhost:6379                    # required from Phase 3 onward
```

See [`.env.example`](./.env.example) for the full list.

## Project Structure

```
├── app/                  # Next.js routes (landing page, room page, room API)
├── components/
│   ├── canvas/           # Konva canvas engine + drawing/selection/transform logic
│   ├── toolbar/          # Tool selection, export, version-history trigger
│   ├── presence/         # Participant list + live cursor rendering
│   ├── room/             # Room shell wiring everything together
│   └── version/          # Version history drawer (save/list/restore/replay)
├── server/
│   ├── index.ts          # Custom Next.js + Socket.io server entrypoint
│   └── socket.ts         # All socket event handlers (canvas, rooms, presence, history, versions)
├── lib/
│   ├── canvas/           # Client-side canvas state helpers
│   ├── db/               # MongoDB models + version manager (Mongoose)
│   ├── redis/            # Redis client + atomic Lua scripts
│   ├── room/             # Room state management (objects, participants, history) over Redis
│   └── socket/           # Browser Socket.io client singleton
├── types/                # Shared TypeScript types, incl. Socket.io event contracts
├── scripts/              # Dev-only scripts (e.g. scripted multi-client Socket.io tests)
└── public/readme/        # README images (hero, screenshots, architecture diagram)
```

## Roadmap

- [x] Phase 0 — Architecture & Setup
- [x] Phase 1 — Whiteboard MVP
- [x] Phase 2 — Rooms & Real-Time Collaboration
- [x] Phase 3 — Redis Pub/Sub & Scalable Real-Time Architecture
- [x] Phase 4 — Shared History & Export
- [x] Phase 5 — Presence
- [x] Phase 6 — Version History
- [ ] Phase 7 — WebRTC Video Call
- [ ] Phase 8 — AI Shape Recognition
- [ ] Phase 9 — Security & Production Hardening
- [ ] Phase 10 — Testing & Finalization

Full per-phase implementation notes, design decisions, and known issues live in
[PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md); a dated work log is in
[DAILY_PROGRESS.md](./DAILY_PROGRESS.md).

## Known Limitations

- **No persistence for live room state.** Restarting Redis (or `FLUSHALL`) drops all room
  objects, participants, and undo/redo history. Only explicitly *saved versions* (Phase 6) survive
  in MongoDB — everything else is ephemeral by design so far.
- **Undo/redo is capped at 50 entries per room**, and **saved versions at 30 per room** (oldest
  trimmed); both are fixed constants, not yet configurable.
- **Last-write-wins at the object level** for concurrent non-undo edits — there's a shared history
  *stack*, not an OT/CRDT layer, so two simultaneous edits to the same object resolve by whichever
  update lands last in Redis.
- **Redis is a hard runtime dependency**; the server won't start without a reachable `REDIS_URL`.
- **No video calls or AI shape recognition yet** — planned for Phases 7–8.
- **Version history's MongoDB happy path** was verified by code review in the environment this
  was built in (no MongoDB available there); see PROJECT_HANDOFF.md for details and what to
  re-verify first in an environment with MongoDB.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and
the required checks (`tsc`, `eslint`, `next build`) before opening a PR.

## License

[MIT](./LICENSE)
