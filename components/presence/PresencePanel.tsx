'use client';

import { Participant, User } from '@/types';
import { useEffect, useState } from 'react';

interface Props {
  user: User;
  participants: Participant[];
  roomId: string;
}

function Avatar({ color, name, isEditing }: { color: string; name: string; isEditing: boolean }) {
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="relative flex-shrink-0">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-semibold ring-2 transition-all duration-300"
        style={{ backgroundColor: color, boxShadow: isEditing ? `0 0 0 2px ${color}40, 0 0 8px ${color}60` : 'none' }}
      >
        {initials}
      </div>
      {/* Online dot */}
      <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-neutral-900" />
      {/* Editing pulse ring */}
      {isEditing && (
        <span
          className="absolute inset-0 rounded-full animate-ping opacity-30"
          style={{ backgroundColor: color }}
        />
      )}
    </div>
  );
}

function TimeAgo({ ts }: { ts: number }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    const update = () => {
      const s = Math.floor((Date.now() - ts) / 1000);
      if (s < 5) setLabel('just now');
      else if (s < 60) setLabel(`${s}s ago`);
      else if (s < 3600) setLabel(`${Math.floor(s / 60)}m ago`);
      else setLabel(`${Math.floor(s / 3600)}h ago`);
    };
    update();
    const id = setInterval(update, 5000);
    return () => clearInterval(id);
  }, [ts]);
  return <span className="text-[10px] text-neutral-600">{label}</span>;
}

export default function PresencePanel({ user, participants, roomId }: Props) {
  // `me` is a display-only stand-in for the local user's own presence row -- joinedAt/
  // lastActiveAt aren't read anywhere for "me" (see the isYou branches below), so a fixed
  // sentinel avoids calling Date.now() during render (impure) without changing behavior.
  const me: Participant = {
    userId: user.userId,
    username: user.username,
    color: user.color,
    isEditing: false,
    joinedAt: 0,
    lastActiveAt: 0,
  };

  const all = [me, ...participants.filter(p => p.userId !== user.userId)];
  const editingCount = participants.filter(p => p.isEditing).length;

  return (
    <aside className="w-52 flex flex-col bg-neutral-900/95 border-l border-neutral-800/60 flex-shrink-0 backdrop-blur-sm">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-neutral-800/60">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest">Participants</p>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[10px] text-neutral-500">{all.length}</span>
          </div>
        </div>
        {editingCount > 0 && (
          <p className="text-[10px] text-indigo-400 mt-1 font-medium">
            {editingCount} editing
          </p>
        )}
      </div>

      {/* Participant list */}
      <div className="flex-1 overflow-y-auto py-1.5 space-y-0.5">
        {all.map((p) => {
          const isYou = p.userId === user.userId;
          return (
            <div
              key={p.userId}
              className="group flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg transition-colors duration-150 hover:bg-neutral-800/50"
            >
              <Avatar color={p.color} name={p.username} isEditing={!isYou && p.isEditing} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-neutral-200 truncate font-medium leading-none">
                    {isYou ? 'You' : p.username}
                  </span>
                  {isYou && (
                    <span className="text-[9px] text-neutral-600 leading-none">(you)</span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  {!isYou && p.isEditing ? (
                    <span className="flex items-center gap-1">
                      <span className="flex gap-0.5">
                        {[0, 1, 2].map(d => (
                          <span
                            key={d}
                            className="w-0.5 h-2 rounded-full animate-bounce"
                            style={{ backgroundColor: p.color, animationDelay: `${d * 0.15}s` }}
                          />
                        ))}
                      </span>
                      <span className="text-[10px]" style={{ color: p.color }}>editing</span>
                    </span>
                  ) : isYou ? (
                    <span className="text-[10px] text-emerald-500">online</span>
                  ) : (
                    <TimeAgo ts={p.lastActiveAt || p.joinedAt} />
                  )}
                </div>
              </div>
              {/* In-call indicator */}
              {p.inCall && (
                <span className="text-[10px] flex-shrink-0" title="In video call">🎥</span>
              )}
              {/* Color dot */}
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
                style={{ backgroundColor: p.color }}
              />
            </div>
          );
        })}
      </div>

      {/* Room ID footer */}
      <div className="px-3 py-2 border-t border-neutral-800/60 space-y-1.5">
        <p className="text-[9px] text-neutral-600 uppercase tracking-widest">Room ID</p>
        <code className="text-[10px] text-neutral-500 font-mono truncate block">{roomId}</code>
      </div>
    </aside>
  );
}
