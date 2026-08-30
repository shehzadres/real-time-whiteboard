'use client';

import dynamic from 'next/dynamic';

const RoomClient = dynamic(() => import('@/components/room/RoomClient'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-neutral-950">
      <div className="text-neutral-400 text-sm animate-pulse">Loading canvas…</div>
    </div>
  ),
});

export default function RoomPageClient({ roomId }: { roomId: string }) {
  return <RoomClient roomId={roomId} />;
}
