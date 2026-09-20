import { getDataClient } from '@/lib/redis/client';

// Fixed-window rate limiter backed by Redis (not in-process memory) so the limit is per-user
// across the whole deployment, not per-server-instance -- consistent with the rest of this
// project's Redis-backed, horizontally-scalable design (roomManager, Socket.io adapter). A
// process-local limiter would let a client get a fresh quota just by landing on a different
// instance behind the load balancer.
//
// Fixed-window (INCR + EXPIRE-if-new) rather than a sliding window or token bucket: one Redis
// round trip per check, no Lua script needed, and the burst-at-window-boundary imprecision fixed
// windows are known for is an acceptable tradeoff at these limits (this is anti-flood protection,
// not billing-grade metering).
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const client = getDataClient();
  const fullKey = `rl:${key}`;
  const count = await client.incr(fullKey);
  if (count === 1) {
    await client.expire(fullKey, windowSeconds);
  }
  return count <= limit;
}

// Per-event-type limits. Deliberately generous for canvas:operation/cursor:move (drawing and
// live cursor broadcast are naturally high-frequency) and tight for the low-frequency,
// higher-cost operations (undo/redo touches Redis + a full-room broadcast; version:save hits
// MongoDB).
export const RATE_LIMITS = {
  'canvas:operation': { limit: 60, windowSeconds: 1 },
  'cursor:move': { limit: 30, windowSeconds: 1 },
  'history:undo': { limit: 10, windowSeconds: 1 },
  'history:redo': { limit: 10, windowSeconds: 1 },
  'webrtc:signal': { limit: 50, windowSeconds: 1 },
  'version:save': { limit: 5, windowSeconds: 10 },
  'version:list': { limit: 10, windowSeconds: 10 },
  'version:restore': { limit: 5, windowSeconds: 10 },
  'participant:update': { limit: 20, windowSeconds: 1 },
  'room:join': { limit: 10, windowSeconds: 10 },
} as const;

export type RateLimitedEvent = keyof typeof RATE_LIMITS;

// userId-scoped: identity is the socket's own authenticated-by-join userId (see server/socket.ts
// currentUserId), never a client-supplied field, so a flooding client can't dodge its limit by
// sending a different userId per message.
export async function checkEventRateLimit(event: RateLimitedEvent, userId: string): Promise<boolean> {
  const { limit, windowSeconds } = RATE_LIMITS[event];
  return checkRateLimit(`${event}:${userId}`, limit, windowSeconds);
}
