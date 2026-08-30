import { CanvasObject, CanvasOperation, Participant } from '@/types';
import { getDataClient } from '@/lib/redis/client';

// Room state lives in Redis (hashes), not process memory, so every server instance behind a
// load balancer sees the same objects/participants for a given room. Socket.io's own
// io.to()/socket.to() cross-instance fan-out is handled separately by the Redis adapter in
// server/socket.ts -- this module is only responsible for the shared *data*, not delivery.
const objectsKey = (roomId: string) => `room:${roomId}:objects`;
const participantsKey = (roomId: string) => `room:${roomId}:participants`;
const undoKey = (roomId: string) => `room:${roomId}:undo`;
const redoKey = (roomId: string) => `room:${roomId}:redo`;
const lastGroupKey = (roomId: string) => `room:${roomId}:lastGroupId`;

// Shared history is a single stack of full-canvas snapshots per room (same
// snapshot-per-commit model the client used locally pre-Phase-4), now stored
// in Redis so undo/redo is one room-wide stack instead of per-client. This
// intentionally has no OT/vector-clock layer -- Redis serializes concurrent
// RPOP/RPUSH on the same key, so simultaneous undo requests from different
// clients still resolve deterministically (last pushed, first popped),
// same as any single-writer LIFO stack.
const MAX_HISTORY = 50;

export async function getRoomObjects(roomId: string): Promise<CanvasObject[]> {
  const raw = await getDataClient().hgetall(objectsKey(roomId));
  return Object.values(raw).map((v) => JSON.parse(v) as CanvasObject);
}

// Applies one canvas:operation AND (if it starts a new commit) snapshots the pre-op state onto
// the undo stack, atomically -- see applyCanvasOp in lib/redis/client.ts for why this can't be
// two separate calls. Ops sharing a groupId (e.g. a group-drag's per-object updates) undo as one
// step; any new commit invalidates the redo stack, standard undo/redo semantics.
export async function applyOperation(roomId: string, op: CanvasOperation): Promise<void> {
  const objectId = op.type === 'delete' ? (op.objectId ?? '') : (op.object?.id ?? '');
  const objectJson = op.object ? JSON.stringify(op.object) : '';
  await getDataClient().applyCanvasOp(
    objectsKey(roomId),
    lastGroupKey(roomId),
    undoKey(roomId),
    redoKey(roomId),
    op.groupId,
    MAX_HISTORY,
    op.type,
    objectId,
    objectJson
  );
}

// Pops the most recent snapshot off the undo stack, pushes the current state onto redo, restores
// the popped snapshot as the room's live state, and returns it (null if there's nothing to undo).
export async function popUndo(roomId: string): Promise<CanvasObject[] | null> {
  const popped = await getDataClient().popHistory(
    objectsKey(roomId), undoKey(roomId), redoKey(roomId), lastGroupKey(roomId), MAX_HISTORY
  );
  return popped ? (JSON.parse(popped) as CanvasObject[]) : null;
}

// Mirror of popUndo for redo: pops from redo, pushes current onto undo.
export async function popRedo(roomId: string): Promise<CanvasObject[] | null> {
  const popped = await getDataClient().popHistory(
    objectsKey(roomId), redoKey(roomId), undoKey(roomId), lastGroupKey(roomId), MAX_HISTORY
  );
  return popped ? (JSON.parse(popped) as CanvasObject[]) : null;
}

export async function addParticipant(roomId: string, participant: Participant): Promise<void> {
  await getDataClient().hset(participantsKey(roomId), participant.userId, JSON.stringify(participant));
}

export async function removeParticipant(roomId: string, userId: string): Promise<void> {
  await getDataClient().hdel(participantsKey(roomId), userId);
}

export async function getRoomParticipants(roomId: string): Promise<Participant[]> {
  const raw = await getDataClient().hgetall(participantsKey(roomId));
  return Object.values(raw).map((v) => JSON.parse(v) as Participant);
}
