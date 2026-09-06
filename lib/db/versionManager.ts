import { v4 as uuidv4 } from 'uuid';
import { VersionModel } from './models';
import { CanvasObject, Version } from '@/types';

// Cap versions kept per room so a long session doesn't grow the collection forever -- same
// bounded-history idea as MAX_HISTORY for the Redis undo/redo stacks, just at the Mongo layer
// and with a larger budget since these are deliberate user-triggered saves, not per-op snapshots.
const MAX_VERSIONS_PER_ROOM = 30;

interface VersionDoc {
  _id: string;
  roomId: string;
  timestamp: number;
  label: string;
  snapshot: CanvasObject[];
  createdBy: string;
}

function toVersion(doc: VersionDoc): Version {
  return {
    id: doc._id,
    roomId: doc.roomId,
    timestamp: doc.timestamp,
    label: doc.label,
    snapshot: doc.snapshot,
    createdBy: doc.createdBy,
  };
}

export async function saveVersion(
  roomId: string,
  userId: string,
  label: string,
  snapshot: CanvasObject[]
): Promise<Version> {
  const doc = await VersionModel.create({
    _id: uuidv4(),
    roomId,
    timestamp: Date.now(),
    label: label?.trim() || 'Snapshot',
    snapshot,
    createdBy: userId,
  });

  // Trim oldest versions beyond the cap for this room.
  const count = await VersionModel.countDocuments({ roomId });
  if (count > MAX_VERSIONS_PER_ROOM) {
    const excess = await VersionModel
      .find({ roomId })
      .sort({ timestamp: 1 })
      .limit(count - MAX_VERSIONS_PER_ROOM)
      .select('_id')
      .lean();
    await VersionModel.deleteMany({ _id: { $in: excess.map((e) => e._id) } });
  }

  return toVersion(doc.toObject() as VersionDoc);
}

export async function listVersions(roomId: string): Promise<Version[]> {
  const docs = await VersionModel
    .find({ roomId })
    .sort({ timestamp: -1 })
    .limit(MAX_VERSIONS_PER_ROOM)
    .lean<VersionDoc[]>();
  return docs.map(toVersion);
}

export async function getVersion(versionId: string): Promise<Version | null> {
  const doc = await VersionModel.findById(versionId).lean<VersionDoc | null>();
  return doc ? toVersion(doc) : null;
}
