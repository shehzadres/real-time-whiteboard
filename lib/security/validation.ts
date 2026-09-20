import { z } from 'zod';

// Central input-validation layer for everything that arrives from a client -- REST bodies and
// every Socket.io event payload. TypeScript types (types/index.ts) only constrain what our OWN
// code emits; they do nothing at runtime against a client that sends arbitrary JSON (a modified
// browser client, curl against the socket transport, etc). These schemas are the runtime
// boundary. Kept deliberately permissive within each bound (no business-rule validation here,
// just shape/size/type limits) so legitimate use is never blocked -- see PROJECT_HANDOFF.md
// Phase 9 for the specific gaps this closes.

// Room/user identifiers are uuid-derived hex strings (see lib/room/roomId.ts,
// lib/canvas/userStore.ts) -- bounding their length/charset stops absurdly large or malformed
// keys from ever reaching Redis key names or Mongo queries built from them.
const idString = z.string().min(1).max(64);

export const userSchema = z.object({
  userId: idString,
  username: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a 6-digit hex color'),
});

export const roomJoinSchema = z.object({
  roomId: idString,
  user: userSchema,
});

// CanvasObject.data is intentionally open-ended (different shape/pen/text tools store different
// fields), so it's bounded by serialized size rather than a strict per-key schema -- a full
// per-shape schema would need updating every time a tool gains a field, which is exactly the kind
// of coupling the master prompt's "avoid over-engineering" guidance warns against. 200KB comfortably
// covers a freehand pen stroke with thousands of points; anything past that is not a legitimate
// single object and is rejected rather than silently truncated.
const MAX_OBJECT_DATA_BYTES = 200_000;
const canvasObjectSchema = z.object({
  id: idString,
  type: z.string().min(1).max(32),
  data: z.record(z.string(), z.unknown()).refine(
    (d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MAX_OBJECT_DATA_BYTES,
    { message: `object data exceeds ${MAX_OBJECT_DATA_BYTES} bytes` }
  ),
  userId: idString,
  timestamp: z.number(),
});

export const canvasOperationSchema = z.object({
  type: z.enum(['add', 'update', 'delete', 'clear']),
  object: canvasObjectSchema.optional(),
  objectId: idString.optional(),
  objects: z.array(canvasObjectSchema).optional(),
  userId: idString,
  roomId: idString,
  timestamp: z.number(),
  operationId: idString,
  groupId: idString,
});

export const cursorMoveSchema = z.object({
  roomId: idString,
  userId: idString,
  cursor: z.object({ x: z.number(), y: z.number() }),
});

export const participantUpdateSchema = z.object({
  roomId: idString,
  userId: idString,
  isEditing: z.boolean().optional(),
  inCall: z.boolean().optional(),
});

export const historyNavSchema = z.object({
  roomId: idString,
  userId: idString,
});

export const versionSaveSchema = z.object({
  roomId: idString,
  userId: idString,
  label: z.string().trim().min(1).max(120),
});

export const versionListSchema = z.object({
  roomId: idString,
});

export const versionRestoreSchema = z.object({
  roomId: idString,
  versionId: idString,
  userId: idString,
});

// WebRTC SDP/ICE payloads are opaque strings from the browser's own RTCPeerConnection --
// re-parsing SDP server-side would be a project of its own, so this is a size cap (a legitimate
// SDP blob is a few KB; ICE candidates are a single short line) rather than structural
// validation, consistent with the canvas object `data` field above.
const MAX_SIGNAL_BYTES = 20_000;
const webrtcSignalSchema = z.object({
  kind: z.enum(['offer', 'answer', 'ice-candidate']),
  sdp: z.record(z.string(), z.unknown()).optional(),
  candidate: z.record(z.string(), z.unknown()).optional(),
}).refine((s) => Buffer.byteLength(JSON.stringify(s), 'utf8') <= MAX_SIGNAL_BYTES, {
  message: `signal exceeds ${MAX_SIGNAL_BYTES} bytes`,
});

export const webrtcSignalEventSchema = z.object({
  roomId: idString,
  from: idString,
  to: idString,
  signal: webrtcSignalSchema,
});

export const roomLeaveSchema = idString;

export const createRoomBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

// Safe parse helper -- returns the parsed value or null (never throws), so every call site can
// stay a one-line early return instead of a try/catch around each zod call.
export function parseOr<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
