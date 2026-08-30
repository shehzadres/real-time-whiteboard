'use client';

import { Participant, User } from '@/types';

interface Props {
  user: User;
  participants: Participant[];
  roomId: string;
}

export default function PresencePanel({ user, participants, roomId }: Props) {
  const all = [
    { userId: user.userId, username: user.username + ' (you)', color: user.color, isEditing: false, joinedAt: 0 },
    ...participants.filter(p => p.userId !== user.userId),
  ];

  return (
    <aside className="w-48 flex flex-col bg-neutral-900 border-l border-neutral-800 flex-shrink-0">
      <div className="px-3 py-2.5 border-b border-neutral-800">
        <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Participants</p>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {all.map(p => (
          <div key={p.userId} className="flex items-center gap-2 px-3 py-1.5">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: p.color }}
            />
            <span className="text-xs text-neutral-300 truncate">{p.username}</span>
            {p.isEditing && (
              <span className="ml-auto text-xs text-indigo-400">editing</span>
            )}
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-neutral-800">
        <p className="text-xs text-neutral-600 truncate font-mono">{roomId}</p>
      </div>
    </aside>
  );
}
