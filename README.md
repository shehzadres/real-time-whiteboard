# Collaborative Whiteboard

A production-grade real-time collaborative whiteboard where multiple users can join a shared room and draw together simultaneously. All actions are synchronized instantly over WebSockets and persisted using an event-sourcing architecture.

**Live Demo:** [collaborative-whiteboard-zeta-nine.vercel.app](https://collaborative-whiteboard-zeta-nine.vercel.app)

---

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, React-Konva |
| Real-Time | Socket.IO (client + server) |
| Backend | Node.js, Express |
| Database | MongoDB, Mongoose |
| Deployment | Vercel (frontend), Railway (backend), MongoDB Atlas |

---

## Architecture

The system uses an **event-sourcing** model. Rather than storing a snapshot of the canvas, every user action is appended to an event log:

```
draw → move → undo → redo → delete
```

Board state is reconstructed by replaying the log from the beginning. This gives:

- Complete action history
- Reliable per-user undo/redo
- Consistent state across all connected clients
- A foundation for version history in the future

---

## Features

### Real-Time Collaboration
- Join any room by URL — share the link to invite others
- All drawing operations broadcast instantly over WebSockets
- Live cursor tracking for every connected user (throttled to 30ms)
- Online user count updates automatically on join/leave

### Drawing Tools
| Tool | Behaviour |
|---|---|
| Pen | Freehand drawing with tension smoothing |
| Rectangle | Drag to draw, click to select |
| Circle | Drag to draw as ellipse, click to select |
| Eraser | Click any shape to delete it |
| Select | Click or marquee-drag to select shapes |

### Selection & Movement
- Click a shape to select it; click again to deselect
- Drag a marquee box to select multiple shapes at once
- Drag any selected shape to move the entire group
- Group movement preserves relative positions
- Movement synchronized in real time across all participants

### Undo / Redo
- `Ctrl + Z` — undo your last stroke
- `Ctrl + Y` — redo
- Per-user: undoing only affects your own strokes, not collaborators'
- Implemented as events in the log, not destructive state mutation

### Delete
- **Eraser tool:** click a shape to delete it
- **Keyboard:** select shape(s) then press `Delete`
- Deletions are persisted and broadcast to all room participants

### Export
- **PNG** — high-resolution (2× pixel ratio)
- **JPG** — full quality

### Routing
- Visiting `/` auto-generates a unique room ID and redirects to `/board/<id>`
- Share the `/board/<id>` URL to invite collaborators to the same room

### UI
- Floating left rail toolbar (desktop/tablet)
- Bottom dock toolbar (mobile)
- Responsive across desktop, tablet, and mobile
- Dark glassmorphism aesthetic

---

## Project Structure

```
collaborative-whiteboard/
├── app/
│   ├── page.tsx                  # Root redirect → /board/<random-id>
│   └── board/
│       └── [id]/
│           └── page.tsx          # Board route — owns stageRef + export logic
├── components/
│   ├── Canvas.tsx                # Konva stage, socket events, drawing logic
│   ├── Navbar.tsx                # Room ID + online user count display
│   ├── Toolbar.tsx               # Tool selection, color, stroke width, export
│   └── ExportMenu.tsx            # PNG / JPG export dropdown
├── lib/
│   ├── socket.ts                 # Socket.IO singleton (autoConnect: false)
│   └── user.ts                   # Stable per-session userId
├── types/
│   └── whiteboard.ts             # Shared TypeScript types
└── backend/
    ├── server.mjs                # Express + Socket.IO server
    ├── db/
    │   └── connect.js            # MongoDB connection
    └── models/
        └── Board.js              # Mongoose schema (roomId + eventLog)
```

---

## Running Locally

### Prerequisites
- Node.js 18+
- A MongoDB Atlas cluster (or local MongoDB)

### 1. Clone the repo

```bash
git clone https://github.com/shehzadres/collaborative-whiteboard.git
cd collaborative-whiteboard
```

### 2. Backend setup

```bash
cd backend
cp .env.example .env
```

Fill in `.env`:

```
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/whiteboard?retryWrites=true&w=majority
PORT=3001
```

> **Note:** If your MongoDB password contains special characters (`@`, `#`, `!`, etc.), URL-encode them. Example: `p@ss!` → `p%40ss%21`

```bash
npm install
node server.mjs
```

Backend runs on `http://localhost:3001`.

### 3. Frontend setup

In the project root:

```bash
cp .env.local.example .env.local
```

Fill in `.env.local`:

```
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
```

```bash
npm install
npm run dev
```

Frontend runs on `http://localhost:3000`.

### 4. Open a board

Navigate to `http://localhost:3000` — it will redirect you to a unique room. Open the same URL in a second tab or browser to test collaboration.

---

## Deployment

### Frontend — Vercel

1. Push the repo to GitHub
2. Import into [vercel.com](https://vercel.com)
3. Add environment variable:
   ```
   NEXT_PUBLIC_BACKEND_URL=https://your-railway-backend-url.up.railway.app
   ```
4. Deploy — Vercel builds and serves the Next.js app automatically

### Backend — Railway

1. Create a new Railway project and connect your GitHub repo
2. Set the root directory to `backend/`
3. Add environment variables:
   ```
   MONGO_URI=your-mongodb-atlas-uri
   PORT=3001
   ```
4. Railway injects `PORT` automatically — ensure `server.mjs` binds to `0.0.0.0`:
   ```js
   server.listen(PORT, "0.0.0.0", () => { ... });
   ```
5. Add your Vercel domain to the CORS `origin` array in `server.mjs`

### Database — MongoDB Atlas

1. Create a free cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Under **Database Access** — create a user with read/write permissions
3. Under **Network Access** — add `0.0.0.0/0` to allow connections from Railway and local
4. Copy the connection string into your `MONGO_URI` environment variable

---

## Database Schema

Each room maps to one `Board` document:

```js
{
  roomId: String,       // matches the URL param
  eventLog: [
    // draw
    { type: "draw", stroke: { id, userId, tool, color, strokeWidth, points, x, y } },
    // move
    { type: "move", strokeId, x, y, userId },
    // delete
    { type: "delete", strokeId, userId },
    // undo
    { type: "undo", strokeId, userId },
    // redo
    { type: "redo", stroke: { ... }, userId },
  ]
}
```

Board state is derived by replaying `eventLog` — never stored as a flat snapshot.

---

## Socket.IO Events

| Direction | Event | Payload |
|---|---|---|
| client → server | `join-room` | `roomId` |
| server → client | `board-history` | `Stroke[]` |
| client → server | `draw` | `{ roomId, stroke }` |
| server → client | `draw` | `Stroke` |
| client → server | `move-stroke` | `{ roomId, strokeId, x, y, userId }` |
| server → client | `stroke-moved` | `{ strokeId, x, y }` |
| client → server | `delete-stroke` | `{ roomId, strokeId, userId }` |
| client → server | `undo-stroke` | `{ roomId, userId }` |
| client → server | `redo-stroke` | `{ roomId, userId }` |
| server → client | `undo-history` / `redo-history` | `Stroke[]` |
| client → server | `cursor-move` | `{ roomId, userId, x, y }` |
| server → client | `cursor-update` | `{ userId, x, y }` |
| server → client | `online-users` | `number` |

---

## Roadmap

- [ ] Zoom and pan (infinite canvas)
- [ ] Resize and rotate handles
- [ ] Copy / paste / duplicate
- [ ] Snap to grid and alignment guides
- [ ] User display names and avatar colors
- [ ] Follow presenter mode
- [ ] Board thumbnails and saved boards dashboard
- [ ] Board version history
- [ ] Authentication and permissions

---

## Skills Demonstrated

Full-Stack Development · Real-Time Systems · WebSockets · Event Sourcing · React · Next.js · TypeScript · Node.js · MongoDB · Interactive Canvas · Collaborative Software Design · System Architecture · Responsive UI/UX
