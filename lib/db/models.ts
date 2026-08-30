import mongoose, { Schema } from 'mongoose';

// Room model
const RoomSchema = new Schema({
  _id: { type: String },
  name: { type: String, required: true },
  createdAt: { type: Number, default: Date.now },
  createdBy: { type: String, required: true },
  objects: { type: Array, default: [] },
  settings: { type: Object, default: {} },
}, { _id: false });

export const RoomModel = mongoose.models.Room || mongoose.model('Room', RoomSchema);

// Version/snapshot model
const VersionSchema = new Schema({
  _id: { type: String },
  roomId: { type: String, required: true, index: true },
  timestamp: { type: Number, default: Date.now },
  label: { type: String, default: 'Snapshot' },
  snapshot: { type: Array, default: [] },
  createdBy: { type: String },
}, { _id: false });

export const VersionModel = mongoose.models.Version || mongoose.model('Version', VersionSchema);
