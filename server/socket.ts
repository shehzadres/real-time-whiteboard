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
import { checkEventRateLimit, checkRateLimit } from '@/lib/security/rateLimiter';
import {
  canvasOperationSchema,
  cursorMoveSchema,
  historyNavSchema,
  parseOr,
  participantUpdateSchema,
  roomJoinSchema,
  roomLeaveSchema,
  versionListSchema,
  versionRestoreSchema,
  versionSaveSchema,
  webrtcSignalEventSchema,
} from '@/lib/security/validation';
import { CanvasOperation, Participant, Point } from '@/types';

let io: IOServer | null = null;

export function initSocket(httpServer: HTTPServer): IOServer {
  if (io) return io;

  // CORS: allow the Next.js frontend origin(s). In production the frontend is deployed to
  // Vercel (FRONTEND_URL) and is separate from this Socket.io server (Railway). Both envs
  // are accepted so local dev (NEXT_PUBLIC_APP_URL) keeps working unchanged.
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    'http://localhost:3000',
  ].filter(Boolean) as string[];

  io = new IOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
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
    // Phase 9: identity is bound ONCE at room:join and never trusted from a later payload again.
    // Every handler below uses these closure variables (not the userId/roomId fields a client
    // sends in an event's data) for anything security-relevant -- a socket can't claim to be a
    // different user or act on a room it never joined just by putting different values in a
    // message. Client-sent roomId/userId fields that still exist in the wire format (kept for
    // the shared ClientToServerEvents type and to avoid a breaking change this late) are
    // validated for shape but otherwise ignored where an authoritative value is available.
    let currentRoomId: string | null = null;
    let currentUserId: string | null = null;

    // IP for pre-identity rate limiting (room:join itself, before a userId is bound to this
    // socket). Socket.io's handshake.address respects a trusted X-Forwarded-For via Engine.IO's
    // own proxy handling when the app is run behind one; falls back to the raw connection address.
    const clientIp = socket.handshake.address || 'unknown';

    // Join room
    socket.on('room:join', async (payload) => {
      try {
        if (!(await checkRateLimit(`room:join:${clientIp}`, 10, 10))) return;
        const data = parseOr(roomJoinSchema, payload);
        if (!data) return;
        const { roomId, user } = data;

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
      } catch (err) {
        console.error('[room:join] failed:', (err as Error).message);
      }
    });

    // Canvas operation. applyOperation atomically snapshots undo history (if this op starts a
    // new commit) and applies the mutation in one Redis round trip -- see roomManager for why.
    socket.on('canvas:operation', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('canvas:operation', currentUserId))) return;
        const op = parseOr(canvasOperationSchema, payload);
        if (!op) return;
        // Ownership: an op is only applied to the room this socket actually joined, and only
        // attributed to the userId bound at join time -- a client can no longer forge ops into
        // another room or under another user's identity by editing the outgoing payload.
        if (op.roomId !== currentRoomId || op.userId !== currentUserId) return;
        await applyOperation(currentRoomId, op as CanvasOperation);
        socket.to(currentRoomId).emit('canvas:operation', op as CanvasOperation);
      } catch (err) {
        console.error('[canvas:operation] failed:', (err as Error).message);
      }
    });

    // Shared undo/redo: a single stack per room, not per client. The
    // resulting state is authoritative, so it's sent to *every* client in
    // the room (io.to, not socket.to) including whoever requested it.
    socket.on('history:undo', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('history:undo', currentUserId))) return;
        const data = parseOr(historyNavSchema, payload);
        if (!data || data.roomId !== currentRoomId) return;
        const snapshot = await popUndo(currentRoomId);
        if (snapshot === null) return;
        io!.to(currentRoomId).emit('history:state', { objects: snapshot });
      } catch (err) {
        console.error('[history:undo] failed:', (err as Error).message);
      }
    });

    socket.on('history:redo', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('history:redo', currentUserId))) return;
        const data = parseOr(historyNavSchema, payload);
        if (!data || data.roomId !== currentRoomId) return;
        const snapshot = await popRedo(currentRoomId);
        if (snapshot === null) return;
        io!.to(currentRoomId).emit('history:state', { objects: snapshot });
      } catch (err) {
        console.error('[history:redo] failed:', (err as Error).message);
      }
    });

    // Cursor move (ephemeral -- no Redis state, just relayed via the adapter)
    socket.on('cursor:move', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('cursor:move', currentUserId))) return;
        const data = parseOr(cursorMoveSchema, payload);
        if (!data || data.roomId !== currentRoomId || data.userId !== currentUserId) return;
        socket.to(currentRoomId).emit('participant:cursor', { userId: currentUserId, cursor: data.cursor as Point });
      } catch (err) {
        console.error('[cursor:move] failed:', (err as Error).message);
      }
    });

    // Editing/in-call state update -- persisted to Redis so late joiners see current state.
    // Only the fields actually provided are patched (e.g. toggling video call membership
    // doesn't overwrite isEditing, and vice versa).
    socket.on('participant:update', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('participant:update', currentUserId))) return;
        const data = parseOr(participantUpdateSchema, payload);
        if (!data || data.roomId !== currentRoomId || data.userId !== currentUserId) return;
        const lastActiveAt = Date.now();
        const patch: { isEditing?: boolean; inCall?: boolean; lastActiveAt: number } = { lastActiveAt };
        if (data.isEditing !== undefined) patch.isEditing = data.isEditing;
        if (data.inCall !== undefined) patch.inCall = data.inCall;
        const updated = await updateParticipant(currentRoomId, currentUserId, patch);
        if (!updated) return;
        socket.to(currentRoomId).emit('participant:update', { userId: currentUserId, isEditing: data.isEditing, inCall: data.inCall, lastActiveAt });
      } catch (err) {
        console.error('[participant:update] failed:', (err as Error).message);
      }
    });

    // WebRTC signaling (Phase 7) -- pure relay, no room state involved, same treatment as
    // cursor:move. Broadcast to the whole room (not a targeted socket id, since we don't track
    // per-user socket ids); each client ignores signals whose `to` isn't its own userId.
    // Phase 9: `from` must match the socket's own bound identity -- otherwise any participant
    // could impersonate another user's offer/answer/ICE traffic to a third party.
    socket.on('webrtc:signal', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('webrtc:signal', currentUserId))) return;
        const data = parseOr(webrtcSignalEventSchema, payload);
        if (!data || data.roomId !== currentRoomId || data.from !== currentUserId) return;
        socket.to(currentRoomId).emit('webrtc:signal', { from: data.from, to: data.to, signal: data.signal });
      } catch (err) {
        console.error('[webrtc:signal] failed:', (err as Error).message);
      }
    });

    // Version history (Phase 6). Snapshots persist to MongoDB (separate from the Redis-backed
    // undo/redo stacks, which are ephemeral and capped much lower) so they survive a Redis
    // restart/flush. Restoring reuses the existing 'history:state' broadcast -- clients already
    // know how to wholesale-replace their canvas state from a Phase 4 undo/redo, so a version
    // restore is just that same replacement with a MongoDB-sourced snapshot instead of a popped
    // Redis one, and (via restoreSnapshot) it's pushed onto the undo stack first so it's itself
    // undoable with a normal Ctrl+Z.
    socket.on('version:save', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('version:save', currentUserId))) return;
        const data = parseOr(versionSaveSchema, payload);
        if (!data || data.roomId !== currentRoomId) return;
        const objects = await getRoomObjects(currentRoomId);
        const version = await saveVersion(currentRoomId, currentUserId, data.label, objects);
        io!.to(currentRoomId).emit('version:saved', version);
      } catch (err) {
        console.error('[version:save] failed:', (err as Error).message);
        socket.emit('error', 'Could not save version (MongoDB unavailable)');
      }
    });

    socket.on('version:list', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('version:list', currentUserId))) return;
        const data = parseOr(versionListSchema, payload);
        if (!data || data.roomId !== currentRoomId) return;
        const versions = await listVersions(currentRoomId);
        socket.emit('version:list', versions);
      } catch (err) {
        console.error('[version:list] failed:', (err as Error).message);
        socket.emit('version:list', []);
        socket.emit('error', 'Could not load versions (MongoDB unavailable)');
      }
    });

    socket.on('version:restore', async (payload) => {
      try {
        if (!currentRoomId || !currentUserId) return;
        if (!(await checkEventRateLimit('version:restore', currentUserId))) return;
        const data = parseOr(versionRestoreSchema, payload);
        if (!data || data.roomId !== currentRoomId) return;
        const version = await getVersion(data.versionId);
        if (!version) {
          socket.emit('error', 'Version not found');
          return;
        }
        // Cross-room guard: a version restored must belong to the room it's being restored into.
        if (version.roomId !== currentRoomId) {
          socket.emit('error', 'Version does not belong to this room');
          return;
        }
        await restoreSnapshot(currentRoomId, version.snapshot);
        io!.to(currentRoomId).emit('history:state', { objects: version.snapshot });
      } catch (err) {
        console.error('[version:restore] failed:', (err as Error).message);
        socket.emit('error', 'Could not restore version (MongoDB unavailable)');
      }
    });

    // Leave room
    socket.on('room:leave', async (payload) => {
      try {
        const roomId = parseOr(roomLeaveSchema, payload);
        if (!roomId || roomId !== currentRoomId) return;
        if (currentUserId) {
          await removeParticipant(roomId, currentUserId);
          socket.to(roomId).emit('participant:leave', currentUserId);
        }
        socket.leave(roomId);
        currentRoomId = null;
      } catch (err) {
        console.error('[room:leave] failed:', (err as Error).message);
      }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      try {
        if (currentRoomId && currentUserId) {
          await removeParticipant(currentRoomId, currentUserId);
          socket.to(currentRoomId).emit('participant:leave', currentUserId);
        }
      } catch (err) {
        console.error('[disconnect] cleanup failed:', (err as Error).message);
      }
    });
  });

  return io;
}

export function getIO(): IOServer | null {
  return io;
}
