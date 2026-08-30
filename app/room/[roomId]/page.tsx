import { Metadata } from 'next';
import RoomPageClient from './RoomPageClient';

export async function generateMetadata({ params }: { params: Promise<{ roomId: string }> }): Promise<Metadata> {
  const { roomId } = await params;
  return { title: `Room ${roomId} — Whiteboard` };
}

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomPageClient roomId={roomId} />;
}
