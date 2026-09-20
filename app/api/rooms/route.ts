import { NextRequest, NextResponse } from 'next/server';
import { generateRoomId } from '@/lib/room/roomId';
import { createRoomBodySchema, parseOr } from '@/lib/security/validation';
import { checkRateLimit } from '@/lib/security/rateLimiter';

// Phase 9: IP-scoped rate limit on room creation. This route isn't currently called by the UI
// (app/page.tsx generates the room id client-side and navigates directly -- see
// PROJECT_HANDOFF.md), but it's a public unauthenticated endpoint either way, so it gets the same
// hardening as everything else rather than being left as an easy target.
function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const allowed = await checkRateLimit(`api:rooms:create:${ip}`, 20, 60);
    if (!allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = parseOr(createRoomBodySchema, body);
    if (parsed === null) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const roomId = generateRoomId();
    const name = parsed.name || `Room ${roomId.substring(0, 6)}`;

    // In Phase 0 we just return the generated ID
    // Phase 2+ will persist to MongoDB
    return NextResponse.json({ roomId, name }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Failed to create room' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: 'Whiteboard API v1' });
}
