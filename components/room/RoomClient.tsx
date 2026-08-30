'use client';

import { useRef, useState } from 'react';
import { getOrCreateUser } from '@/lib/canvas/userStore';
import { User, Participant, ToolType } from '@/types';
import Toolbar from '@/components/toolbar/Toolbar';
import Canvas from '@/components/canvas/Canvas';
import PresencePanel from '@/components/presence/PresencePanel';

interface Props {
  roomId: string;
}

export default function RoomClient({ roomId }: Props) {
  const [user] = useState<User | null>(() => (typeof window === 'undefined' ? null : getOrCreateUser()));
  const [tool, setTool] = useState<ToolType>('select');
  const [strokeColor, setStrokeColor] = useState('#6366F1');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [fillColor, setFillColor] = useState('transparent');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<{
    undo: () => void; redo: () => void; clear: () => void;
    duplicate: () => void; deleteSelected: () => void;
    exportPNG: () => void; exportPDF: () => void;
  } | null>(null);

  const handleZoomIn = () => setZoom(z => Math.min(z + 0.1, 4));
  const handleZoomOut = () => setZoom(z => Math.max(z - 0.1, 0.1));
  const handleZoomReset = () => setZoom(1);

  if (!user) return null;

  return (
    <div className="flex h-screen bg-neutral-950 overflow-hidden">
      {/* Toolbar */}
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        strokeColor={strokeColor}
        onStrokeColorChange={setStrokeColor}
        strokeWidth={strokeWidth}
        onStrokeWidthChange={setStrokeWidth}
        fillColor={fillColor}
        onFillColorChange={setFillColor}
        onUndo={() => canvasRef.current?.undo()}
        onRedo={() => canvasRef.current?.redo()}
        onDuplicate={() => canvasRef.current?.duplicate()}
        onDelete={() => canvasRef.current?.deleteSelected()}
        onClear={() => canvasRef.current?.clear()}
        onExportPNG={() => canvasRef.current?.exportPNG()}
        onExportPDF={() => canvasRef.current?.exportPDF()}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        zoom={zoom}
      />

      {/* Canvas area */}
      <div className="flex-1 relative">
        {/* Room info bar */}
        <div className="absolute top-0 left-0 right-0 h-10 flex items-center justify-between px-4 bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-800 z-10">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Room</span>
            <code className="text-xs text-indigo-400 font-mono">{roomId}</code>
            <button
              onClick={() => navigator.clipboard.writeText(window.location.href)}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors ml-1"
              title="Copy invite link"
            >
              Copy link
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-neutral-400">
              {participants.length + 1} online
            </span>
          </div>
        </div>

        <Canvas
          ref={canvasRef}
          roomId={roomId}
          user={user}
          tool={tool}
          strokeColor={strokeColor}
          strokeWidth={strokeWidth}
          fillColor={fillColor}
          zoom={zoom}
          onZoomChange={setZoom}
          onParticipantsChange={setParticipants}
        />
      </div>

      {/* Presence panel */}
      <PresencePanel user={user} participants={participants} roomId={roomId} />
    </div>
  );
}
