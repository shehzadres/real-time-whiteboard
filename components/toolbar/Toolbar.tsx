'use client';

import { ToolType } from '@/types';

interface ToolbarProps {
  tool: ToolType;
  onToolChange: (t: ToolType) => void;
  strokeColor: string;
  onStrokeColorChange: (c: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (w: number) => void;
  fillColor: string;
  onFillColorChange: (c: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
  onExportPNG: () => void;
  onExportPDF: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  zoom: number;
}

const TOOLS: { id: ToolType; label: string; icon: string }[] = [
  { id: 'select', label: 'Select', icon: '↖' },
  { id: 'pen', label: 'Pen', icon: '✏' },
  { id: 'rectangle', label: 'Rectangle', icon: '▭' },
  { id: 'circle', label: 'Circle', icon: '○' },
  { id: 'line', label: 'Line', icon: '╱' },
  { id: 'arrow', label: 'Arrow', icon: '→' },
  { id: 'triangle', label: 'Triangle', icon: '△' },
  { id: 'text', label: 'Text', icon: 'T' },
  { id: 'eraser', label: 'Eraser (drag to erase)', icon: '⌫' },
];

const COLORS = ['#6366F1', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#FFFFFF', '#000000'];

export default function Toolbar({
  tool, onToolChange,
  strokeColor, onStrokeColorChange,
  strokeWidth, onStrokeWidthChange,
  fillColor, onFillColorChange,
  onUndo, onRedo, onDuplicate, onDelete, onClear,
  onExportPNG, onExportPDF,
  onZoomIn, onZoomOut, onZoomReset,
  zoom,
}: ToolbarProps) {
  return (
    <aside className="w-14 flex flex-col items-center gap-1 bg-neutral-900 border-r border-neutral-800 py-3 overflow-y-auto flex-shrink-0">
      {/* Tools */}
      <div className="flex flex-col gap-1 w-full px-1">
        {TOOLS.map(t => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => onToolChange(t.id)}
            className={`w-full aspect-square flex items-center justify-center rounded-md text-sm transition-colors
              ${tool === t.id
                ? 'bg-indigo-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Stroke color */}
      <p className="text-[9px] text-neutral-600 uppercase tracking-wider">Stroke</p>
      <div className="flex flex-col gap-1 px-1 w-full">
        {COLORS.map(c => (
          <button
            key={c}
            onClick={() => onStrokeColorChange(c)}
            title={c}
            className={`w-full h-5 rounded-sm border-2 transition-all ${strokeColor === c ? 'border-white scale-110' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          value={strokeColor}
          onChange={e => onStrokeColorChange(e.target.value)}
          title="Custom stroke color"
          className="w-full h-5 rounded-sm border border-neutral-700 bg-transparent cursor-pointer"
        />
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Fill color */}
      <p className="text-[9px] text-neutral-600 uppercase tracking-wider">Fill</p>
      <div className="flex flex-col gap-1 px-1 w-full">
        <button
          onClick={() => onFillColorChange('transparent')}
          title="No fill"
          className={`w-full h-5 rounded-sm border-2 transition-all bg-[repeating-conic-gradient(#4b5563_0%_25%,transparent_0%_50%)] bg-[length:6px_6px] ${fillColor === 'transparent' ? 'border-white scale-110' : 'border-transparent'}`}
        />
        {COLORS.map(c => (
          <button
            key={c}
            onClick={() => onFillColorChange(c)}
            title={c}
            className={`w-full h-5 rounded-sm border-2 transition-all ${fillColor === c ? 'border-white scale-110' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          value={fillColor === 'transparent' ? '#000000' : fillColor}
          onChange={e => onFillColorChange(e.target.value)}
          title="Custom fill color"
          className="w-full h-5 rounded-sm border border-neutral-700 bg-transparent cursor-pointer"
        />
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Stroke width */}
      <div className="flex flex-col gap-1 px-2 w-full">
        {[1, 2, 4, 6].map(w => (
          <button
            key={w}
            onClick={() => onStrokeWidthChange(w)}
            title={`Width ${w}`}
            className={`w-full flex items-center justify-center h-5 rounded transition-colors
              ${strokeWidth === w ? 'bg-indigo-600' : 'hover:bg-neutral-800'}`}
          >
            <div className="bg-white rounded-full" style={{ height: `${w}px`, width: '20px' }} />
          </button>
        ))}
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Actions */}
      <div className="flex flex-col gap-1 px-1 w-full">
        {[
          { label: 'Undo (Ctrl+Z)', icon: '↩', action: onUndo },
          { label: 'Redo (Ctrl+Shift+Z)', icon: '↪', action: onRedo },
          { label: 'Duplicate (Ctrl+D)', icon: '⧉', action: onDuplicate },
          { label: 'Delete (Del)', icon: '🗑', action: onDelete },
          { label: 'Clear all', icon: '✕', action: onClear },
        ].map(a => (
          <button
            key={a.label}
            title={a.label}
            onClick={a.action}
            className="w-full aspect-square flex items-center justify-center rounded-md text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
          >
            {a.icon}
          </button>
        ))}
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Zoom */}
      <div className="flex flex-col gap-1 px-1 w-full">
        {[
          { label: 'Zoom in', icon: '+', action: onZoomIn },
          { label: 'Reset zoom', icon: `${Math.round(zoom * 100)}%`, action: onZoomReset },
          { label: 'Zoom out', icon: '−', action: onZoomOut },
        ].map(a => (
          <button
            key={a.label}
            title={a.label}
            onClick={a.action}
            className="w-full aspect-square flex items-center justify-center rounded-md text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
          >
            {a.icon}
          </button>
        ))}
      </div>

      <div className="w-8 border-t border-neutral-800 my-1" />

      {/* Export */}
      <div className="flex flex-col gap-1 px-1 w-full">
        <button
          title="Export PNG"
          onClick={onExportPNG}
          className="w-full aspect-square flex items-center justify-center rounded-md text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
        >
          PNG
        </button>
        <button
          title="Export PDF"
          onClick={onExportPDF}
          className="w-full aspect-square flex items-center justify-center rounded-md text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
        >
          PDF
        </button>
      </div>
    </aside>
  );
}
