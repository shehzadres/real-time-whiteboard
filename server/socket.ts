import { Server as HTTPServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  addParticipant,
  applyOperation,
  getRoomObjects,
  getRoomParticipants,
  popRedo,
  popUndo,
  removeParticipant,
  restoreSnapshot,
  updateParticipant,
} from '@/lib/room/roomManager';
import { getVersion, listVersions, saveVersion } from '@/lib/db/versionManager';
import { getPublisher, getSubscriber } from '@/lib/redis/client';
import { CanvasOperation, Participant, Point } from '@/types';

let io: IOServer | null = null;

export function initSocket(httpServer: HTTPServer): IOServer {
  if (io) return io;

  io = new IOServer(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // Redis adapter: makes io.to()/socket.to() reach sockets connected to *other* server
  // instances, not just this process. This is the Socket.io-level piece of multi-instance
  // scaling; room state itself (objects/participants) is shared separately via roomManager,
  // which now reads/writes Redis directly instead of an in-process Map.
  io.adapter(createAdapter(getPublisher(), getSubscriber()));

  io.on('connection', (socket: Socket) => {
    let currentRoomId: string | null = null;
    let currentUserId: string | null = null;

    // Join room
    socket.on('room:join', async ({ roomId, user }) => {
      currentRoomId = roomId;
      currentUserId = user.userId;

      socket.join(roomId);

      const participant: Participant = {
        userId: user.userId,
        username: user.username,
        color: user.color,
        isEditing: false,
        joinedAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      await addParticipant(roomId, participant);

      // Send current state to new joiner (now the shared Redis state, so a joiner landing on
      // a different instance than the room's other participants still gets everything).
      const [objects, participants] = await Promise.all([
        getRoomObjects(roomId),
        getRoomParticipants(roomId),
      ]);
      socket.emit('room:state', { objects, participants });

      // Notify others (fanned out cross-instance by the Redis adapter)
      socket.to(roomId).emit('participant:join', participant);
    });

    // Canvas operation. applyOperation atomically snapshots undo history (if this op starts a
    // new commit) and applies the mutation in one Redis round trip -- see roomManager for why.
    socket.on('canvas:operation', async (op: CanvasOperation) => {
      if (!currentRoomId) return;
      await applyOperation(currentRoomId, op);
      socket.to(currentRoomId).emit('canvas:operation', op);
    });

    // Shared undo/redo: a single stack per room, not per client. The
    // resulting state is authoritative, so it's sent to *every* client in
    // the room (io.to, not socket.to) including whoever requested it.
    socket.on('history:undo', async ({ roomId }: { roomId: string; userId: string }) => {
      const snapshot = await popUndo(roomId);
      if (snapshot === null) return;
      io!.to(roomId).emit('history:state', { objects: snapshot });
    });

    socket.on('history:redo', async ({ roomId }: { roomId: string; userId: string }) => {
      const snapshot = await popRedo(roomId);
      if (snapshot === null) return;
      io!.to(roomId).emit('history:state', { objects: snapshot });
    });

    // Cursor move (ephemeral -- no Redis state, just relayed via the adapter)
    socket.on('cursor:move', ({ roomId, userId, cursor }: { roomId: string; userId: string; cursor: Point }) => {
      socket.to(roomId).emit('participant:cursor', { userId, cursor });
    });

    // Editing state update -- persisted to Redis so late joiners see current state
    socket.on('participant:update', async ({ roomId, userId, isEditing }: { roomId: string; userId: string; isEditing: boolean }) => {
      const lastActiveAt = Date.now();
      const updated = await updateParticipant(roomId, userId, { isEditing, lastActiveAt });
      if (!updated) return;
      socket.to(roomId).emit('participant:update', { userId, isEditing, lastActiveAt });
    });

    // Version history (Phase 6). Snapshots persist to MongoDB (separate from the Redis-backed
    // undo/redo stacks, which are ephemeral and capped much lower) so they survive a Redis
    // restart/flush. Restoring reuses the existing 'history:state' broadcast -- clients already
    // know how to wholesale-replace their canvas state from a Phase 4 undo/redo, so a version
    // restore is just that same replacement with a MongoDB-sourced snapshot instead of a popped
    // Redis one, and (via restoreSnapshot) it's pushed onto the undo stack first so it's itself
    // undoable with a normal Ctrl+Z.
    socket.on('version:save', async ({ roomId, userId, label }) => {
      try {
        const objects = await getRoomObjects(roomId);
        const version = await saveVersion(roomId, userId, label, objects);
        io!.to(roomId).emit('version:saved', version);
      } catch (err) {
        console.error('[version:save] failed:', (err as Error).message);
        socket.emit('error', 'Could not save version (MongoDB unavailable)');
      }
    });

    socket.on('version:list', async ({ roomId }) => {
      try {
        const versions = await listVersions(roomId);
        socket.emit('version:list', versions);
      } catch (err) {
        console.error('[version:list] failed:', (err as Error).message);
        socket.emit('version:list', []);
        socket.emit('error', 'Could not load versions (MongoDB unavailable)');
      }
    });

    socket.on('version:restore', async ({ roomId, versionId }) => {
      try {
        const version = await getVersion(versionId);
        if (!version) {
          socket.emit('error', 'Version not found');
          return;
        }
        await restoreSnapshot(roomId, version.snapshot);
        io!.to(roomId).emit('history:state', { objects: version.snapshot });
      } catch (err) {
        console.error('[version:restore] failed:', (err as Error).message);
        socket.emit('error', 'Could not restore version (MongoDB unavailable)');
      }
    });

    // Leave room
    socket.on('room:leave', async (roomId: string) => {
      if (currentUserId) {
        await removeParticipant(roomId, currentUserId);
        socket.to(roomId).emit('participant:leave', currentUserId);
      }
      socket.leave(roomId);
      currentRoomId = null;
    });

    // Disconnect
    socket.on('disconnect', async () => {
      if (currentRoomId && currentUserId) {
        await removeParticipant(currentRoomId, currentUserId);
        socket.to(currentRoomId).emit('participant:leave', currentUserId);
      }
    });
  });

  return io;
}

export function getIO(): IOServer | null {
  return io;
}
