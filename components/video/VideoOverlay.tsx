'use client';

import { useEffect, useRef, useState } from 'react';
import { Participant } from '@/types';
import { useWebRTC } from '@/lib/webrtc/useWebRTC';

interface Props {
  roomId: string;
  userId: string;
  participants: Participant[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

function nameFor(participants: Participant[], id: string): string {
  return participants.find((p) => p.userId === id)?.username ?? 'Guest';
}
function colorFor(participants: Participant[], id: string): string {
  return participants.find((p) => p.userId === id)?.color ?? '#6366F1';
}
function initialsOf(name: string): string {
  return name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
}

function VideoTile({
  stream, label, color, mirrored, cameraOff,
}: {
  stream: MediaStream | null; label: string; color: string; mirrored?: boolean; cameraOff?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative aspect-video w-full rounded-lg overflow-hidden bg-neutral-800 border border-neutral-700/60 flex-shrink-0">
      {stream && !cameraOff ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={mirrored}
          className={`w-full h-full object-cover ${mirrored ? '[transform:scaleX(-1)]' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold"
            style={{ backgroundColor: color }}
          >
            {initialsOf(label)}
          </div>
        </div>
      )}
      <span className="absolute bottom-1 left-1.5 text-[10px] text-white/90 bg-black/50 px-1.5 py-0.5 rounded leading-none">
        {label}
      </span>
    </div>
  );
}

export default function VideoOverlay({ roomId, userId, participants, isOpen, onOpenChange }: Props) {
  const [active, setActive] = useState(false);
  const {
    localStream, remoteStreams, cameraOn, micOn, error, toggleCamera, toggleMic,
  } = useWebRTC({ roomId, userId, participants, active });

  const remoteEntries = Array.from(remoteStreams.entries());
  const callSize = remoteEntries.length + (active ? 1 : 0);

  // Panel is closed but the call is still running -- show a small reopen pill instead of
  // unmounting anything, so audio/video keeps flowing while the user works on the canvas.
  if (!isOpen) {
    if (!active) return null;
    return (
      <button
        onClick={() => onOpenChange(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 pl-2 pr-3 py-2 rounded-full bg-neutral-900/95 border border-neutral-700 shadow-lg shadow-black/40 hover:border-indigo-500 transition-colors"
        title="Reopen video call"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span className="text-xs text-neutral-200 font-medium">Call · {callSize}</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-30 w-72 rounded-xl bg-neutral-900/95 border border-neutral-800 shadow-xl shadow-black/50 backdrop-blur-sm flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800/60">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'}`} />
          <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest">
            {active ? `Video call · ${callSize}` : 'Video call'}
          </p>
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="text-neutral-500 hover:text-neutral-300 text-xs leading-none px-1"
          title="Minimize (call keeps running)"
        >
          ✕
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-[10px] text-red-400">
          {error}
        </div>
      )}

      {/* Tiles */}
      {active ? (
        <div className="p-3 grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
          <VideoTile
            stream={localStream}
            label="You"
            color={colorFor(participants, userId)}
            mirrored
            cameraOff={!cameraOn}
          />
          {remoteEntries.map(([peerId, stream]) => (
            <VideoTile
              key={peerId}
              stream={stream}
              label={nameFor(participants, peerId)}
              color={colorFor(participants, peerId)}
            />
          ))}
        </div>
      ) : (
        <p className="px-3 py-4 text-xs text-neutral-500 text-center">
          Join to share your camera and mic with everyone in this room.
        </p>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-neutral-800/60">
        {active ? (
          <>
            <button
              onClick={toggleMic}
              title={micOn ? 'Mute microphone' : 'Unmute microphone'}
              className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                micOn ? 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {micOn ? '🎤' : '🔇'}
            </button>
            <button
              onClick={toggleCamera}
              title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
              className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                cameraOn ? 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {cameraOn ? '📷' : '📷🚫'}
            </button>
            <button
              onClick={() => setActive(false)}
              title="Leave call"
              className="flex-1 h-8 rounded-md text-xs font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              Leave
            </button>
          </>
        ) : (
          <button
            onClick={() => setActive(true)}
            className="w-full h-8 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Join call
          </button>
        )}
      </div>
    </div>
  );
}
