import { NextRequest, NextResponse } from 'next/server';
import { generateRoomId } from '@/lib/room/roomId';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const roomId = generateRoomId();
    const name = body.name || `Room ${roomId.substring(0, 6)}`;

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
