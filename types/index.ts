export type ToolType =
  | 'select'
  | 'pen'
  | 'rectangle'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'triangle'
  | 'text'
  | 'eraser';

export interface Point {
  x: number;
  y: number;
}

export interface CanvasObject {
  id: string;
  type: string;
  data: Record<string, unknown>;
  userId: string;
  timestamp: number;
}

export interface CanvasOperation {
  type: 'add' | 'update' | 'delete' | 'clear';
  object?: CanvasObject;
  objectId?: string;
  objects?: CanvasObject[];
  userId: string;
  roomId: string;
  timestamp: number;
  operationId: string;
  // All ops emitted from a single local commit (e.g. one group-drag or one
  // multi-delete) share the same groupId. The server uses this to snapshot
  // undo history once per commit instead of once per individual op.
  groupId: string;
}

export interface Participant {
  userId: string;
  username: string;
  color: string;
  cursor?: Point;
  isEditing: boolean;
  joinedAt: number;
}

export interface Room {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  participants: Participant[];
  objects: CanvasObject[];
}

export interface HistoryEntry {
  operationId: string;
  operation: CanvasOperation;
  inverse: CanvasOperation;
}

export interface Version {
  id: string;
  roomId: string;
  timestamp: number;
  label: string;
  snapshot: CanvasObject[];
  createdBy: string;
}

export interface User {
  userId: string;
  username: string;
  color: string;
}

// Socket event types
export interface ServerToClientEvents {
  'canvas:operation': (op: CanvasOperation) => void;
  'room:state': (room: { objects: CanvasObject[]; participants: Participant[] }) => void;
  'participant:join': (p: Participant) => void;
  'participant:leave': (userId: string) => void;
  'participant:cursor': (data: { userId: string; cursor: Point }) => void;
  // Server-authoritative undo/redo result: replaces the room's full object
  // state on every client (including whoever requested the undo/redo), since
  // history is a single shared stack, not per-client.
  'history:state': (data: { objects: CanvasObject[] }) => void;
  'version:saved': (version: Version) => void;
  error: (msg: string) => void;
}

export interface ClientToServerEvents {
  'room:join': (data: { roomId: string; user: User }) => void;
  'room:leave': (roomId: string) => void;
  'canvas:operation': (op: CanvasOperation) => void;
  'cursor:move': (data: { roomId: string; userId: string; cursor: Point }) => void;
  'history:undo': (data: { roomId: string; userId: string }) => void;
  'history:redo': (data: { roomId: string; userId: string }) => void;
  'version:save': (data: { roomId: string; userId: string; label: string }) => void;
  'version:restore': (data: { roomId: string; versionId: string; userId: string }) => void;
}
