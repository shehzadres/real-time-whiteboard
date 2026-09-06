import { createServer } from 'http';
import next from 'next';
import { initSocket } from './socket';
import { connectRedisClients } from '../lib/redis/client';
import { connectDB } from '../lib/db/mongoose';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare()
  .then(async () => {
    // Connect the pub/sub + data Redis clients before wiring the adapter/room state so nothing
    // races an unopened connection. Required from Phase 3 onward -- Redis is no longer optional.
    await connectRedisClients();

    // MongoDB connects in the background (Phase 6, for version snapshots only). Deliberately NOT
    // awaited here: room state, canvas sync, undo/redo, and presence all still live entirely in
    // Redis and must keep working with no MongoDB running at all, exactly as before this phase
    // (see README's "MONGODB_URI is still not required to run" note, still true for everything
    // except Save/Restore Version). If Mongo is unreachable, that feature fails gracefully --
    // socket.ts catches and emits 'error' -- rather than blocking the whole server's startup.
    connectDB().catch((err) => console.error('[MongoDB] connection failed (version history disabled):', err.message));

    const httpServer = createServer((req, res) => handle(req, res));
    initSocket(httpServer);

    httpServer.listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
