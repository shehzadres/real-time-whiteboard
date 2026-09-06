'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSocket } from '@/lib/socket/client';
import { Version } from '@/types';

interface Props {
  roomId: string;
  userId: string;
  isOpen: boolean;
  onClose: () => void;
}

const REPLAY_STEP_MS = 900;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export default function VersionHistoryPanel({ roomId, userId, isOpen, onClose }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [everLoaded, setEverLoaded] = useState(false);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayLabel, setReplayLabel] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load the list whenever the panel opens, and keep it live: a version saved by any
  // participant (including us) arrives via 'version:saved' and gets prepended -- no need to
  // re-fetch the whole list for that.
  useEffect(() => {
    const socket = getSocket();

    const handleList = (list: Version[]) => {
      setVersions(list);
      setEverLoaded(true);
    };
    const handleSaved = (v: Version) => {
      if (v.roomId !== roomId) return;
      setVersions((prev) => [v, ...prev]);
      setSaving(false);
    };
    // Server-side failures (e.g. MongoDB unreachable) surface here rather than hanging silently
    // -- version:save/list/restore are the only handlers in the app that emit this event.
    const handleError = (msg: string) => {
      setSaving(false);
      setErrorMsg(msg);
    };

    socket.on('version:list', handleList);
    socket.on('version:saved', handleSaved);
    socket.on('error', handleError);

    // Request the current list every time the panel opens -- a pure external-system call, no
    // local state write here (that happens in handleList above, in response to the server's
    // reply, which is the pattern React's set-state-in-effect rule wants).
    if (isOpen) {
      socket.emit('version:list', { roomId });
    }
    return () => {
      socket.off('version:list', handleList);
      socket.off('version:saved', handleSaved);
      socket.off('error', handleError);
    };
  }, [isOpen, roomId]);

  const handleSave = useCallback(() => {
    setSaving(true);
    getSocket().emit('version:save', { roomId, userId, label: label.trim() || 'Snapshot' });
    setLabel('');
  }, [roomId, userId, label]);

  const handleRestore = useCallback((versionId: string) => {
    setRestoringId(versionId);
    getSocket().emit('version:restore', { roomId, versionId, userId });
    setTimeout(() => setRestoringId(null), 500);
  }, [roomId, userId]);

  // Client-driven replay: step through every saved version oldest -> newest, restoring each in
  // turn with a short pause. This is deliberately simple (no server-side replay state) -- each
  // step is just a normal version:restore, so every participant sees the same replay live via the
  // existing history:state broadcast, and it's fully undoable afterwards like any other restore.
  const handleReplay = useCallback(async () => {
    if (versions.length === 0 || replaying) return;
    setReplaying(true);
    const ordered = [...versions].reverse(); // oldest first
    for (const v of ordered) {
      setReplayLabel(v.label);
      getSocket().emit('version:restore', { roomId, versionId: v.id, userId });
      await new Promise((r) => setTimeout(r, REPLAY_STEP_MS));
    }
    setReplayLabel(null);
    setReplaying(false);
  }, [versions, replaying, roomId, userId]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-30"
        onClick={onClose}
      />
      {/* Drawer */}
      <aside className="fixed top-0 right-0 h-full w-80 bg-neutral-900 border-l border-neutral-800 z-40 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Version History</h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-lg leading-none"
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Save new version */}
        <div className="px-4 py-3 border-b border-neutral-800 space-y-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Snapshot label (optional)"
            className="w-full bg-neutral-800 text-neutral-200 text-xs rounded-md px-2.5 py-1.5 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-indigo-500"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium rounded-md py-1.5 transition-colors"
          >
            {saving ? 'Saving…' : 'Save current state'}
          </button>
        </div>

        {/* Error banner (e.g. MongoDB unreachable) */}
        {errorMsg && (
          <div className="px-4 py-2 bg-red-950/40 border-b border-red-900/40 flex items-center justify-between gap-2">
            <p className="text-[11px] text-red-400">{errorMsg}</p>
            <button
              onClick={() => setErrorMsg(null)}
              className="text-red-500 hover:text-red-300 text-xs leading-none flex-shrink-0"
            >
              ×
            </button>
          </div>
        )}

        {/* Replay */}
        {versions.length > 1 && (
          <div className="px-4 py-2 border-b border-neutral-800">
            <button
              onClick={handleReplay}
              disabled={replaying}
              className="w-full text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700 hover:border-neutral-600 rounded-md py-1.5 transition-colors disabled:opacity-50"
            >
              {replaying ? `Replaying: ${replayLabel ?? ''}` : `▶ Replay ${versions.length} versions`}
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto py-1">
          {!everLoaded && (
            <p className="text-xs text-neutral-600 px-4 py-4 text-center">Loading versions…</p>
          )}
          {everLoaded && versions.length === 0 && (
            <p className="text-xs text-neutral-600 px-4 py-4 text-center">
              No versions saved yet. Save the current canvas state to create one.
            </p>
          )}
          {versions.map((v) => (
            <div
              key={v.id}
              className="group flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-neutral-800/50 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-xs text-neutral-200 font-medium truncate">{v.label}</p>
                <p className="text-[10px] text-neutral-500">{formatTimestamp(v.timestamp)}</p>
              </div>
              <button
                onClick={() => handleRestore(v.id)}
                disabled={restoringId === v.id || replaying}
                className="flex-shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-400/50 rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
              >
                {restoringId === v.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
