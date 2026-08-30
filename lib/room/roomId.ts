import { v4 as uuidv4 } from 'uuid';

// Kept in its own module (no Redis/ioredis import) so client components like app/page.tsx can
// generate a room id without pulling the Node-only roomManager (and thus ioredis) into the
// browser bundle.
export function generateRoomId(): string {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}
