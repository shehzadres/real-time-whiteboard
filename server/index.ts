import { createServer } from 'http';
import next from 'next';
import { initSocket } from './socket';
import { connectRedisClients } from '../lib/redis/client';

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
