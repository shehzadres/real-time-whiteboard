'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateRoomId } from '@/lib/room/roomId';

export default function HomePage() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);

  function handleCreate() {
    setCreating(true);
    const id = generateRoomId();
    router.push(`/room/${id}`);
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const code = joinCode.trim();
    if (code) router.push(`/room/${code}`);
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 px-4">
      {/* Logo / Brand */}
      <div className="mb-12 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="10" fill="#6366F1"/>
            <path d="M8 28 L18 8 L28 28" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <circle cx="18" cy="20" r="3" fill="white"/>
          </svg>
          <h1 className="text-2xl font-bold tracking-tight text-white">Whiteboard</h1>
        </div>
        <p className="text-neutral-400 text-sm max-w-xs">
          Real-time collaborative canvas. Draw, design, and think together.
        </p>
      </div>

      {/* Actions */}
      <div className="w-full max-w-sm space-y-4">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-lg transition-colors text-sm"
        >
          {creating ? 'Creating room…' : 'Create new room'}
        </button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-neutral-800" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-neutral-950 px-3 text-neutral-500 text-xs">or join existing</span>
          </div>
        </div>

        <form onSubmit={handleJoin} className="flex gap-2">
          <input
            type="text"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value)}
            placeholder="Room code or link"
            className="flex-1 px-3 py-2.5 bg-neutral-900 border border-neutral-800 text-white placeholder-neutral-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!joinCode.trim()}
            className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-white rounded-lg text-sm transition-colors"
          >
            Join
          </button>
        </form>
      </div>

      {/* Feature pills */}
      <div className="mt-16 flex flex-wrap justify-center gap-2">
        {['Real-time sync', 'Video calls', 'Undo / Redo', 'Export PNG/PDF', 'Version history', 'AI shapes'].map(f => (
          <span key={f} className="px-3 py-1 bg-neutral-900 border border-neutral-800 text-neutral-400 text-xs rounded-full">
            {f}
          </span>
        ))}
      </div>
    </main>
  );
}
