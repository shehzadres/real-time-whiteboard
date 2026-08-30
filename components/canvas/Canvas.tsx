'use client';

import {
  forwardRef, useImperativeHandle, useEffect, useRef, useState, useCallback,
} from 'react';
import { Stage, Layer, Line, Rect, Ellipse, Arrow, Text, Transformer } from 'react-konva';
import KonvaType from 'konva';
import { v4 as uuidv4 } from 'uuid';
import jsPDF from 'jspdf';
import { ToolType, Participant, User, CanvasObject, CanvasOperation, Point } from '@/types';
import { connectSocket } from '@/lib/socket/client';

interface Props {
  roomId: string;
  user: User;
  tool: ToolType;
  strokeColor: string;
  strokeWidth: number;
  fillColor: string;
  zoom: number;
  onZoomChange: (z: number) => void;
  onParticipantsChange: (ps: Participant[]) => void;
}

export interface CanvasHandle {
  undo: () => void;
  redo: () => void;
  clear: () => void;
  duplicate: () => void;
  deleteSelected: () => void;
  exportPNG: () => void;
  exportPDF: () => void;
}

type KonvaObjectData = {
  id: string;
  type: string;
  points?: number[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radiusX?: number;
  radiusY?: number;
  text?: string;
  fontSize?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  stroke: string;
  strokeWidth: number;
  fill?: string;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const CURSOR_THROTTLE_MS = 40;

// Wire format <-> local shape conversion. The network model (CanvasObject)
// wraps a flat `data` bag plus metadata; the local model (KonvaObjectData)
// is flat for easier Konva prop spreading. Keep both in sync at the edges
// only, so the rest of the component never has to think about the wrapper.
function toCanvasObject(o: KonvaObjectData, userId: string): CanvasObject {
  const { id, type, ...data } = o;
  return { id, type, data, userId, timestamp: Date.now() };
}

function fromCanvasObject(c: CanvasObject): KonvaObjectData {
  return { id: c.id, type: c.type, ...(c.data as Partial<KonvaObjectData>) } as KonvaObjectData;
}

function diffObjects(prev: KonvaObjectData[], next: KonvaObjectData[]) {
  const prevMap = new Map(prev.map(o => [o.id, o]));
  const nextMap = new Map(next.map(o => [o.id, o]));
  const adds: KonvaObjectData[] = [];
  const updates: KonvaObjectData[] = [];
  const deletes: string[] = [];
  nextMap.forEach((obj, id) => {
    const before = prevMap.get(id);
    if (!before) adds.push(obj);
    else if (JSON.stringify(before) !== JSON.stringify(obj)) updates.push(obj);
  });
  prevMap.forEach((_obj, id) => {
    if (!nextMap.has(id)) deletes.push(id);
  });
  return { adds, updates, deletes };
}

const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { roomId, user, tool, strokeColor, strokeWidth, fillColor, zoom, onZoomChange, onParticipantsChange },
  ref
) {
  const stageRef = useRef<KonvaType.Stage>(null);
  const transformerRef = useRef<KonvaType.Transformer>(null);
  const shapeRefs = useRef<Map<string, KonvaType.Node>>(new Map());

  const [objects, setObjects] = useState<KonvaObjectData[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentObj, setCurrentObj] = useState<KonvaObjectData | null>(null);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const isErasing = useRef(false);
  const isMarqueeSelecting = useRef(false);
  const groupDragOrigin = useRef<{ id: string; positions: Map<string, { x: number; y: number }> } | null>(null);

  // --- Real-time collaboration state ---
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null);
  const objectsRef = useRef<KonvaObjectData[]>([]);
  useEffect(() => { objectsRef.current = objects; }, [objects]);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const participantsRef = useRef<Participant[]>([]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);

  const [remoteCursors, setRemoteCursors] = useState<Map<string, Point>>(new Map());
  const lastCursorEmit = useRef(0);
  const [connected, setConnected] = useState(false);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Diff the outgoing snapshot against the last known state and emit one
  // CanvasOperation per changed object (rather than the whole canvas) so
  // the wire stays cheap regardless of board size. All ops from one call
  // share a groupId so the server snapshots undo history once per commit,
  // not once per changed object (see roomManager.applyOperation / applyCanvasOp).
  const broadcastDiff = useCallback((newObjects: KonvaObjectData[]) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;
    const prev = objectsRef.current;
    const groupId = uuidv4();

    if (newObjects.length === 0 && prev.length > 0) {
      const op: CanvasOperation = {
        type: 'clear', userId: user.userId, roomId, timestamp: Date.now(), operationId: uuidv4(), groupId,
      };
      socket.emit('canvas:operation', op);
      return;
    }

    const { adds, updates, deletes } = diffObjects(prev, newObjects);
    adds.forEach(o => {
      const op: CanvasOperation = {
        type: 'add', object: toCanvasObject(o, user.userId),
        userId: user.userId, roomId, timestamp: Date.now(), operationId: uuidv4(), groupId,
      };
      socket.emit('canvas:operation', op);
    });
    updates.forEach(o => {
      const op: CanvasOperation = {
        type: 'update', object: toCanvasObject(o, user.userId),
        userId: user.userId, roomId, timestamp: Date.now(), operationId: uuidv4(), groupId,
      };
      socket.emit('canvas:operation', op);
    });
    deletes.forEach(id => {
      const op: CanvasOperation = {
        type: 'delete', objectId: id,
        userId: user.userId, roomId, timestamp: Date.now(), operationId: uuidv4(), groupId,
      };
      socket.emit('canvas:operation', op);
    });
  }, [roomId, user.userId]);

  // Local edit -> broadcast to the room. Undo/redo history is now shared and
  // server-authoritative (see doUndo/doRedo + the history:state listener),
  // so there is no local history stack to maintain here anymore.
  const commitAndSync = useCallback((newObjects: KonvaObjectData[]) => {
    broadcastDiff(newObjects);
    setObjects(newObjects);
  }, [broadcastDiff]);

  const clearSelectionIfMissing = useCallback((newObjects: KonvaObjectData[]) => {
    setSelectedIds(ids => ids.filter(id => newObjects.some(o => o.id === id)));
  }, []);

  // Apply an operation that arrived from another client. Never re-broadcasts.
  const applyRemoteOperation = useCallback((op: CanvasOperation) => {
    setObjects(prev => {
      let next: KonvaObjectData[];
      switch (op.type) {
        case 'add':
        case 'update': {
          if (!op.object) return prev;
          const incoming = fromCanvasObject(op.object);
          const exists = prev.some(o => o.id === incoming.id);
          next = exists ? prev.map(o => (o.id === incoming.id ? incoming : o)) : [...prev, incoming];
          break;
        }
        case 'delete':
          if (!op.objectId) return prev;
          next = prev.filter(o => o.id !== op.objectId);
          break;
        case 'clear':
          next = [];
          break;
        default:
          return prev;
      }
      clearSelectionIfMissing(next);
      return next;
    });
  }, [clearSelectionIfMissing]);

  const getRelativePos = (stage: KonvaType.Stage) => {
    const pos = stage.getPointerPosition();
    if (!pos) return null;
    return {
      x: (pos.x - stagePos.x) / zoom,
      y: (pos.y - stagePos.y) / zoom,
    };
  };

  // Keep the Transformer attached to whatever is currently selected.
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const nodes = selectedIds
      .map(id => shapeRefs.current.get(id))
      .filter((n): n is KonvaType.Node => !!n);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, objects]);

  const handleMouseDown = (e: KonvaType.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;

    if (tool === 'eraser') {
      isErasing.current = true;
      eraseAtPointer();
      return;
    }

    if (tool === 'select') {
      const clickedOnEmpty = e.target === stage;
      if (clickedOnEmpty) {
        const pos = stage.getPointerPosition();
        if (!pos) return;
        isMarqueeSelecting.current = true;
        setMarquee({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
        if (!e.evt.shiftKey) setSelectedIds([]);
      }
      return;
    }

    const pos = getRelativePos(stage);
    if (!pos) return;

    setIsDrawing(true);

    const id = uuidv4();
    const base = {
      id,
      stroke: strokeColor,
      strokeWidth,
      fill: fillColor === 'transparent' ? '' : fillColor,
    };

    let obj: KonvaObjectData | null = null;

    switch (tool) {
      case 'pen':
        obj = { ...base, type: 'pen', points: [pos.x, pos.y] };
        break;
      case 'rectangle':
        obj = { ...base, type: 'rectangle', x: pos.x, y: pos.y, width: 0, height: 0 };
        break;
      case 'circle':
        obj = { ...base, type: 'circle', x: pos.x, y: pos.y, radiusX: 0, radiusY: 0 };
        break;
      case 'line':
        obj = { ...base, type: 'line', points: [pos.x, pos.y, pos.x, pos.y] };
        break;
      case 'arrow':
        obj = { ...base, type: 'arrow', points: [pos.x, pos.y, pos.x, pos.y] };
        break;
      case 'triangle':
        obj = { ...base, type: 'triangle', x: pos.x, y: pos.y, points: [0, 0, 0, 0, 0, 0] };
        break;
      case 'text':
        obj = { ...base, type: 'text', x: pos.x, y: pos.y, text: 'Double-click to edit', width: 200, fontSize: 16 };
        setIsDrawing(false);
        break;
    }

    if (obj) {
      setCurrentObj(obj);
      if (tool === 'text') {
        const newObjects = [...objects, obj];
        commitAndSync(newObjects);
        setCurrentObj(null);
      }
    }
  };

  const eraseAtPointer = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const shape = stage.getIntersection(pos);
    if (!shape) return;
    // Walk up to find a node we tagged with an object id.
    let node: KonvaType.Node | null = shape;
    let hitId: string | null = null;
    while (node) {
      const id = node.id();
      if (id && objects.some(o => o.id === id)) {
        hitId = id;
        break;
      }
      node = node.getParent();
    }
    if (!hitId) return;
    const next = objects.filter(o => o.id !== hitId);
    if (next.length !== objects.length) {
      commitAndSync(next);
      clearSelectionIfMissing(next);
    }
  };

  const handleMouseMove = (e: KonvaType.KonvaEventObject<MouseEvent>) => {
    // Broadcast cursor position (throttled), independent of active tool.
    const now = Date.now();
    if (now - lastCursorEmit.current > CURSOR_THROTTLE_MS) {
      const stage = stageRef.current;
      const socket = socketRef.current;
      if (stage && socket && socket.connected) {
        const relPos = getRelativePos(stage);
        if (relPos) {
          lastCursorEmit.current = now;
          socket.emit('cursor:move', { roomId, userId: user.userId, cursor: relPos });
        }
      }
    }

    if (tool === 'eraser' && isErasing.current) {
      eraseAtPointer();
      return;
    }

    if (isMarqueeSelecting.current) {
      const stage = stageRef.current;
      if (!stage) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;
      setMarquee(m => (m ? { ...m, x2: pos.x, y2: pos.y } : m));
      return;
    }

    if (!isDrawing || !currentObj) return;
    const stage = stageRef.current;
    if (!stage) return;
    const pos = getRelativePos(stage);
    if (!pos) return;

    const updated = { ...currentObj };

    switch (currentObj.type) {
      case 'pen': {
        const pts = currentObj.points || [];
        updated.points = [...pts, pos.x, pos.y];
        break;
      }
      case 'rectangle': {
        updated.width = pos.x - (currentObj.x || 0);
        updated.height = pos.y - (currentObj.y || 0);
        break;
      }
      case 'circle': {
        const dx = pos.x - (currentObj.x || 0);
        const dy = pos.y - (currentObj.y || 0);
        updated.radiusX = Math.abs(dx);
        updated.radiusY = Math.abs(dy);
        break;
      }
      case 'line':
      case 'arrow': {
        const pts = currentObj.points || [];
        updated.points = [pts[0], pts[1], pos.x, pos.y];
        break;
      }
      case 'triangle': {
        const ox = currentObj.x || 0;
        const oy = currentObj.y || 0;
        const w = pos.x - ox;
        const h = pos.y - oy;
        updated.points = [w / 2, 0, w, h, 0, h];
        break;
      }
    }

    setCurrentObj(updated);
    void e;
  };

  const handleMouseUp = () => {
    if (tool === 'eraser') {
      isErasing.current = false;
      return;
    }

    if (isMarqueeSelecting.current) {
      isMarqueeSelecting.current = false;
      const box = marquee;
      setMarquee(null);
      if (box) {
        const x1 = Math.min(box.x1, box.x2);
        const y1 = Math.min(box.y1, box.y2);
        const x2 = Math.max(box.x1, box.x2);
        const y2 = Math.max(box.y1, box.y2);
        // Treat a near-zero-area marquee as a plain click (already deselected on mousedown).
        if (Math.abs(x2 - x1) > 3 || Math.abs(y2 - y1) > 3) {
          const hits: string[] = [];
          shapeRefs.current.forEach((node, id) => {
            const r = node.getClientRect({ relativeTo: stageRef.current ?? undefined });
            const intersects = r.x < x2 && r.x + r.width > x1 && r.y < y2 && r.y + r.height > y1;
            if (intersects) hits.push(id);
          });
          setSelectedIds(ids => Array.from(new Set([...ids, ...hits])));
        }
      }
      return;
    }

    if (!isDrawing || !currentObj) return;
    setIsDrawing(false);

    const isValid = (() => {
      if (currentObj.type === 'pen') return (currentObj.points?.length || 0) > 4;
      if (currentObj.type === 'rectangle') return Math.abs(currentObj.width || 0) > 3 || Math.abs(currentObj.height || 0) > 3;
      if (currentObj.type === 'circle') return (currentObj.radiusX || 0) > 3;
      if (currentObj.type === 'line' || currentObj.type === 'arrow') {
        const pts = currentObj.points || [];
        return Math.abs((pts[2] || 0) - (pts[0] || 0)) > 3 || Math.abs((pts[3] || 0) - (pts[1] || 0)) > 3;
      }
      return true;
    })();

    if (isValid) {
      const newObjects = [...objects, currentObj];
      commitAndSync(newObjects);
    }
    setCurrentObj(null);
  };

  const handleWheel = (e: KonvaType.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = zoom;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.05;
    const newScale = e.evt.deltaY < 0
      ? Math.min(oldScale * scaleBy, MAX_ZOOM)
      : Math.max(oldScale / scaleBy, MIN_ZOOM);

    onZoomChange(newScale);

    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };

    setStagePos({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  };

  const handleStageDragEnd = (e: KonvaType.KonvaEventObject<DragEvent>) => {
    setStagePos({ x: e.target.x(), y: e.target.y() });
  };

  // Undo/redo are now server round trips against the room's single shared
  // history stack: the server pops a snapshot and broadcasts the resulting
  // state to everyone (including us) via 'history:state'. No local
  // optimistic update here -- the round trip is fast (same socket path as
  // every other op) and avoids a local guess that could diverge from the
  // shared stack if another client undoes/redoes in the same instant.
  const doUndo = useCallback(() => {
    socketRef.current?.emit('history:undo', { roomId, userId: user.userId });
  }, [roomId, user.userId]);

  const doRedo = useCallback(() => {
    socketRef.current?.emit('history:redo', { roomId, userId: user.userId });
  }, [roomId, user.userId]);

  const doDuplicate = useCallback(() => {
    if (selectedIds.length === 0) return;
    const originals = objects.filter(o => selectedIds.includes(o.id));
    if (originals.length === 0) return;
    const offset = 20;
    const clones: KonvaObjectData[] = originals.map(o => {
      const clone: KonvaObjectData = { ...o, id: uuidv4() };
      if (clone.x !== undefined) clone.x = clone.x + offset;
      if (clone.y !== undefined) clone.y = clone.y + offset;
      if (clone.points) {
        clone.points = clone.points.map((v, i) => (i % 2 === 0 ? v + offset : v + offset));
      }
      return clone;
    });
    const newObjects = [...objects, ...clones];
    commitAndSync(newObjects);
    setSelectedIds(clones.map(c => c.id));
  }, [objects, selectedIds, commitAndSync]);

  const doDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const newObjects = objects.filter(o => !selectedIds.includes(o.id));
    commitAndSync(newObjects);
    setSelectedIds([]);
  }, [objects, selectedIds, commitAndSync]);

  // Imperative handle
  useImperativeHandle(ref, () => ({
    undo: doUndo,
    redo: doRedo,
    duplicate: doDuplicate,
    deleteSelected: doDeleteSelected,
    clear() {
      commitAndSync([]);
      setSelectedIds([]);
    },
    exportPNG() {
      const stage = stageRef.current;
      if (!stage) return;
      const uri = stage.toDataURL({ pixelRatio: 2 });
      const a = document.createElement('a');
      a.href = uri;
      a.download = `whiteboard-${Date.now()}.png`;
      a.click();
    },
    exportPDF() {
      const stage = stageRef.current;
      if (!stage) return;
      const uri = stage.toDataURL({ pixelRatio: 2 });
      const w = stage.width();
      const h = stage.height();
      const orientation = w >= h ? 'landscape' : 'portrait';
      const doc = new jsPDF({ orientation, unit: 'px', format: [w, h] });
      doc.addImage(uri, 'PNG', 0, 0, w, h);
      doc.save(`whiteboard-${Date.now()}.pdf`);
    },
  }), [doUndo, doRedo, doDuplicate, doDeleteSelected, commitAndSync]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        doDuplicate();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        doDeleteSelected();
      }

      if (e.key === 'Escape') {
        setSelectedIds([]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [doUndo, doRedo, doDuplicate, doDeleteSelected]);

  // Socket lifecycle: connect, join the room, sync state, and react to
  // remote operations / presence changes. Re-runs if roomId or the local
  // user identity changes; reconnects re-join automatically via 'connect'.
  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    const join = () => {
      setConnected(true);
      socket.emit('room:join', { roomId, user });
    };

    const handleRoomState = (data: { objects: CanvasObject[]; participants: Participant[] }) => {
      const objs = data.objects.map(fromCanvasObject);
      setObjects(objs);
      setSelectedIds([]);
      const others = data.participants.filter(p => p.userId !== user.userId);
      setParticipants(others);
      onParticipantsChange(others);
    };

    // Shared undo/redo result -- authoritative for the whole room, so we
    // just replace local state rather than diffing/merging.
    const handleHistoryState = (data: { objects: CanvasObject[] }) => {
      const objs = data.objects.map(fromCanvasObject);
      setObjects(objs);
      clearSelectionIfMissing(objs);
    };

    const handleParticipantJoin = (p: Participant) => {
      if (p.userId === user.userId) return;
      setParticipants(prev => {
        const next = [...prev.filter(x => x.userId !== p.userId), p];
        onParticipantsChange(next);
        return next;
      });
    };

    const handleParticipantLeave = (userId: string) => {
      setParticipants(prev => {
        const next = prev.filter(x => x.userId !== userId);
        onParticipantsChange(next);
        return next;
      });
      setRemoteCursors(prev => {
        if (!prev.has(userId)) return prev;
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
    };

    const handleCursor = ({ userId, cursor }: { userId: string; cursor: Point }) => {
      if (userId === user.userId) return;
      setRemoteCursors(prev => {
        const next = new Map(prev);
        next.set(userId, cursor);
        return next;
      });
    };

    const handleDisconnect = () => setConnected(false);

    socket.on('connect', join);
    socket.on('room:state', handleRoomState);
    socket.on('canvas:operation', applyRemoteOperation);
    socket.on('history:state', handleHistoryState);
    socket.on('participant:join', handleParticipantJoin);
    socket.on('participant:leave', handleParticipantLeave);
    socket.on('participant:cursor', handleCursor);
    socket.on('disconnect', handleDisconnect);

    if (socket.connected) join();

    return () => {
      socket.emit('room:leave', roomId);
      socket.off('connect', join);
      socket.off('room:state', handleRoomState);
      socket.off('canvas:operation', applyRemoteOperation);
      socket.off('history:state', handleHistoryState);
      socket.off('participant:join', handleParticipantJoin);
      socket.off('participant:leave', handleParticipantLeave);
      socket.off('participant:cursor', handleCursor);
      socket.off('disconnect', handleDisconnect);
    };
  }, [roomId, user, applyRemoteOperation, onParticipantsChange, clearSelectionIfMissing]);

  const updateObject = useCallback((id: string, patch: Partial<KonvaObjectData>) => {
    const next = objects.map(o => (o.id === id ? { ...o, ...patch } : o));
    commitAndSync(next);
  }, [objects, commitAndSync]);

  const handleSelectClick = (id: string, evt: KonvaType.KonvaEventObject<MouseEvent>) => {
    if (tool !== 'select') return;
    evt.cancelBubble = true;
    const shift = evt.evt.shiftKey;
    setSelectedIds(prev => {
      if (shift) {
        return prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      }
      return [id];
    });
  };

  const handleGroupDragStart = (id: string) => {
    if (selectedIds.length > 1 && selectedIds.includes(id)) {
      const positions = new Map<string, { x: number; y: number }>();
      selectedIds.forEach(sid => {
        const node = shapeRefs.current.get(sid);
        if (node) positions.set(sid, { x: node.x(), y: node.y() });
      });
      groupDragOrigin.current = { id, positions };
    } else {
      groupDragOrigin.current = null;
    }
  };

  const handleGroupDragMove = (id: string, e: KonvaType.KonvaEventObject<DragEvent>) => {
    const origin = groupDragOrigin.current;
    if (!origin || origin.id !== id) return;
    const leaderStart = origin.positions.get(id);
    if (!leaderStart) return;
    const dx = e.target.x() - leaderStart.x;
    const dy = e.target.y() - leaderStart.y;
    origin.positions.forEach((startPos, sid) => {
      if (sid === id) return;
      const node = shapeRefs.current.get(sid);
      if (node) node.position({ x: startPos.x + dx, y: startPos.y + dy });
    });
  };

  const handleDragEndFor = (obj: KonvaObjectData) => (e: KonvaType.KonvaEventObject<DragEvent>) => {
    const origin = groupDragOrigin.current;
    if (origin && origin.id === obj.id && selectedIds.length > 1) {
      const leaderStart = origin.positions.get(obj.id)!;
      const dx = e.target.x() - leaderStart.x;
      const dy = e.target.y() - leaderStart.y;
      const next = objects.map(o => {
        const start = origin.positions.get(o.id);
        if (!start) return o;
        return { ...o, x: start.x + dx, y: start.y + dy };
      });
      commitAndSync(next);
      groupDragOrigin.current = null;
      return;
    }
    updateObject(obj.id, { x: e.target.x(), y: e.target.y() });
  };

  const handleTransformEnd = (obj: KonvaObjectData) => () => {
    const node = shapeRefs.current.get(obj.id);
    if (!node) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const rotation = node.rotation();
    const x = node.x();
    const y = node.y();

    const patch: Partial<KonvaObjectData> = { x, y, rotation };

    if (obj.type === 'rectangle') {
      patch.width = (obj.width || 0) * scaleX;
      patch.height = (obj.height || 0) * scaleY;
      node.scaleX(1);
      node.scaleY(1);
    } else if (obj.type === 'circle') {
      patch.radiusX = (obj.radiusX || 0) * scaleX;
      patch.radiusY = (obj.radiusY || 0) * scaleY;
      node.scaleX(1);
      node.scaleY(1);
    } else if (obj.type === 'text') {
      patch.width = (obj.width || 200) * scaleX;
      patch.fontSize = (obj.fontSize || 16) * scaleY;
      node.scaleX(1);
      node.scaleY(1);
    } else {
      // pen / line / arrow / triangle: keep the scale baked into the shape's transform.
      patch.scaleX = scaleX;
      patch.scaleY = scaleY;
    }

    updateObject(obj.id, patch);
  };

  const openTextEditor = (obj: KonvaObjectData) => {
    if (tool !== 'select') return;
    setEditingTextId(obj.id);
    setEditingValue(obj.text || '');
  };

  const commitTextEdit = () => {
    if (!editingTextId) return;
    updateObject(editingTextId, { text: editingValue });
    setEditingTextId(null);
  };

  const cancelTextEdit = () => setEditingTextId(null);

  const registerRef = (id: string) => (node: KonvaType.Node | null) => {
    if (node) shapeRefs.current.set(id, node);
    else shapeRefs.current.delete(id);
  };

  const renderObject = (obj: KonvaObjectData) => {
    const isSelectable = tool === 'select';
    const common = {
      id: obj.id,
      ref: registerRef(obj.id),
      rotation: obj.rotation || 0,
      onClick: (e: KonvaType.KonvaEventObject<MouseEvent>) => handleSelectClick(obj.id, e),
      draggable: isSelectable,
      onDragStart: () => handleGroupDragStart(obj.id),
      onDragMove: (e: KonvaType.KonvaEventObject<DragEvent>) => handleGroupDragMove(obj.id, e),
      onDragEnd: handleDragEndFor(obj),
      onTransformEnd: handleTransformEnd(obj),
    };

    switch (obj.type) {
      case 'pen':
        return (
          <Line
            key={obj.id}
            {...common}
            x={obj.x || 0}
            y={obj.y || 0}
            scaleX={obj.scaleX || 1}
            scaleY={obj.scaleY || 1}
            points={obj.points || []}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            tension={0.5}
            lineCap="round"
            lineJoin="round"
          />
        );
      case 'rectangle':
        return (
          <Rect
            key={obj.id}
            {...common}
            x={obj.x}
            y={obj.y}
            width={obj.width}
            height={obj.height}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            fill={obj.fill || 'transparent'}
          />
        );
      case 'circle':
        return (
          <Ellipse
            key={obj.id}
            {...common}
            x={obj.x}
            y={obj.y}
            radiusX={obj.radiusX || 0}
            radiusY={obj.radiusY || 0}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            fill={obj.fill || 'transparent'}
          />
        );
      case 'line':
        return (
          <Line
            key={obj.id}
            {...common}
            x={obj.x || 0}
            y={obj.y || 0}
            scaleX={obj.scaleX || 1}
            scaleY={obj.scaleY || 1}
            points={obj.points || []}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            lineCap="round"
          />
        );
      case 'arrow':
        return (
          <Arrow
            key={obj.id}
            {...common}
            x={obj.x || 0}
            y={obj.y || 0}
            scaleX={obj.scaleX || 1}
            scaleY={obj.scaleY || 1}
            points={obj.points || []}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            fill={obj.stroke}
          />
        );
      case 'triangle':
        return (
          <Line
            key={obj.id}
            {...common}
            x={obj.x}
            y={obj.y}
            scaleX={obj.scaleX || 1}
            scaleY={obj.scaleY || 1}
            points={obj.points || []}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            fill={obj.fill || 'transparent'}
            closed
          />
        );
      case 'text':
        return (
          <Text
            key={obj.id}
            {...common}
            x={obj.x}
            y={obj.y}
            text={editingTextId === obj.id ? '' : (obj.text || '')}
            fill={obj.stroke}
            fontSize={obj.fontSize || 16}
            width={obj.width}
            onDblClick={() => openTextEditor(obj)}
            onDblTap={() => openTextEditor(obj)}
          />
        );
      default:
        return null;
    }
  };

  const cursor = (() => {
    if (tool === 'select') return 'default';
    if (tool === 'text') return 'text';
    if (tool === 'eraser') return 'cell';
    return 'crosshair';
  })();

  const editingNode = editingTextId ? objects.find(o => o.id === editingTextId) : null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 top-10"
      style={{ cursor, background: '#111113' }}
    >
      {/* Grid background */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ opacity: 0.08 }}
        width="100%"
        height="100%"
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"
            patternTransform={`translate(${stagePos.x % 40},${stagePos.y % 40}) scale(${zoom})`}
          >
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>

      <Stage
        ref={stageRef}
        width={dimensions.width}
        height={dimensions.height}
        scaleX={zoom}
        scaleY={zoom}
        x={stagePos.x}
        y={stagePos.y}
        draggable={tool === 'select' && selectedIds.length === 0}
        onDragEnd={handleStageDragEnd}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      >
        <Layer>
          {objects.map(obj => (editingTextId === obj.id ? null : renderObject(obj)) )}
          {objects.filter(o => editingTextId === o.id).map(renderObject)}
          {currentObj && renderObject(currentObj)}
          <Transformer
            ref={transformerRef}
            rotateEnabled
            flipEnabled={false}
            boundBoxFunc={(oldBox, newBox) => {
              if (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4) return oldBox;
              return newBox;
            }}
          />
        </Layer>
      </Stage>

      {/* Connection status banner */}
      {!connected && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-full bg-amber-500/90 text-neutral-950 text-xs font-medium shadow">
          Connecting…
        </div>
      )}

      {/* Remote cursors (world-space positions, projected to current screen space) */}
      {Array.from(remoteCursors.entries()).map(([userId, cursor]) => {
        const participant = participants.find(p => p.userId === userId);
        if (!participant) return null;
        const screenX = cursor.x * zoom + stagePos.x;
        const screenY = cursor.y * zoom + stagePos.y;
        return (
          <div
            key={userId}
            className="absolute pointer-events-none z-20 transition-transform duration-75"
            style={{ left: 0, top: 0, transform: `translate(${screenX}px, ${screenY}px)` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ display: 'block' }}>
              <path d="M2 1 L2 15 L6 11.5 L8.5 16.5 L10.5 15.5 L8 10.5 L13 10.5 Z" fill={participant.color} stroke="#111113" strokeWidth="1" />
            </svg>
            <span
              className="absolute left-4 top-3.5 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded text-white"
              style={{ backgroundColor: participant.color }}
            >
              {participant.username}
            </span>
          </div>
        );
      })}

      {/* Marquee selection box (screen space, un-scaled overlay) */}
      {marquee && (
        <div
          className="absolute border border-indigo-400 bg-indigo-400/10 pointer-events-none"
          style={{
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
          }}
        />
      )}

      {/* Inline text editor overlay */}
      {editingNode && (() => {
        const node = shapeRefs.current.get(editingNode.id);
        const rect = node
          ? node.getClientRect({ relativeTo: stageRef.current ?? undefined })
          : { x: 0, y: 0, width: 200, height: 30 };
        return (
          <textarea
            autoFocus
            value={editingValue}
            onChange={e => setEditingValue(e.target.value)}
            onBlur={commitTextEdit}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitTextEdit();
              } else if (e.key === 'Escape') {
                cancelTextEdit();
              }
              e.stopPropagation();
            }}
            className="absolute bg-transparent outline outline-1 outline-indigo-400 resize-none p-0 leading-none"
            style={{
              left: rect.x,
              top: rect.y,
              width: Math.max(rect.width, 100),
              minHeight: (editingNode.fontSize || 16) * 1.3,
              color: editingNode.stroke,
              fontSize: (editingNode.fontSize || 16) * zoom,
              fontFamily: 'sans-serif',
            }}
          />
        );
      })()}
    </div>
  );
});

export default Canvas;
