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
  lastActiveAt: number;
  // Phase 7: whether this participant currently has the video call panel open
  // (camera/mic may still be individually muted -- this only tracks call membership,
  // used by other clients to decide who to open an RTCPeerConnection with).
  inCall?: boolean;
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

// Phase 7: WebRTC signaling payloads. These are relayed verbatim through the server
// (no interpretation, no persistence -- same "ephemeral relay" treatment as cursor:move)
// so browsers can negotiate a direct peer connection with each other.
export type WebRTCSignal =
  | { kind: 'offer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice-candidate'; candidate: RTCIceCandidateInit };

// Socket event types
export interface ServerToClientEvents {
  'canvas:operation': (op: CanvasOperation) => void;
  'room:state': (room: { objects: CanvasObject[]; participants: Participant[] }) => void;
  'participant:join': (p: Participant) => void;
  'participant:leave': (userId: string) => void;
  'participant:cursor': (data: { userId: string; cursor: Point }) => void;
  // isEditing/inCall are both optional here: a given participant:update broadcast may only
  // be patching one of the two (e.g. joining a video call doesn't touch isEditing).
  'participant:update': (data: { userId: string; isEditing?: boolean; inCall?: boolean; lastActiveAt: number }) => void;
  // Server-authoritative undo/redo result: replaces the room's full object
  // state on every client (including whoever requested the undo/redo), since
  // history is a single shared stack, not per-client.
  'history:state': (data: { objects: CanvasObject[] }) => void;
  'version:saved': (version: Version) => void;
  'version:list': (versions: Version[]) => void;
  'webrtc:signal': (data: { from: string; to: string; signal: WebRTCSignal }) => void;
  error: (msg: string) => void;
}

export interface ClientToServerEvents {
  'room:join': (data: { roomId: string; user: User }) => void;
  'room:leave': (roomId: string) => void;
  'canvas:operation': (op: CanvasOperation) => void;
  'cursor:move': (data: { roomId: string; userId: string; cursor: Point }) => void;
  'participant:update': (data: { roomId: string; userId: string; isEditing?: boolean; inCall?: boolean }) => void;
  'history:undo': (data: { roomId: string; userId: string }) => void;
  'history:redo': (data: { roomId: string; userId: string }) => void;
  'version:save': (data: { roomId: string; userId: string; label: string }) => void;
  'version:restore': (data: { roomId: string; versionId: string; userId: string }) => void;
  'version:list': (data: { roomId: string }) => void;
  'webrtc:signal': (data: { roomId: string; from: string; to: string; signal: WebRTCSignal }) => void;
}
