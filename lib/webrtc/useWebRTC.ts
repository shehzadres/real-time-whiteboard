'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket } from '@/lib/socket/client';
import { Participant, WebRTCSignal } from '@/types';

// Public STUN-only config -- no TURN, no paid media server. This is a deliberate scope choice
// (see PROJECT_HANDOFF): direct mesh P2P works for the small-room scale this project targets,
// but will fail to connect two peers both behind symmetric NATs with no relay fallback. That
// tradeoff is documented as a known limitation rather than solved with a TURN/SFU deployment,
// which would reintroduce the "no paid third-party service" and "don't over-engineer" concerns
// the master prompt calls out.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

interface PeerEntry {
  connection: RTCPeerConnection;
  stream: MediaStream;
}

interface UseWebRTCOptions {
  roomId: string;
  userId: string;
  participants: Participant[];
  active: boolean;
}

export interface UseWebRTCResult {
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  cameraOn: boolean;
  micOn: boolean;
  error: string | null;
  toggleCamera: () => void;
  toggleMic: () => void;
}

// Mesh topology: every participant who has joined the call opens a direct RTCPeerConnection to
// every other participant who has joined. Who sends the initial offer for a given pair is
// decided purely by comparing userIds (`userId < peerId` initiates) -- this avoids a "glare"
// scenario where both sides simultaneously send offers, without needing a server-assigned
// initiator role. Connection lifecycle is driven entirely by the `inCall` flag on each
// Participant (persisted via participant:update, same mechanism Phase 5 uses for isEditing), so
// this hook stays a pure reaction to the participants prop plus its own local join/leave calls.
export function useWebRTC({ roomId, userId, participants, active }: UseWebRTCOptions): UseWebRTCResult {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const wasActiveRef = useRef(false);
  const cameraOnRef = useRef(true);
  const micOnRef = useRef(true);

  const closePeer = useCallback((peerId: string) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    entry.connection.close();
    peersRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }, []);

  const getOrCreatePeer = useCallback((peerId: string): RTCPeerConnection => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing.connection;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const remoteStream = new MediaStream();
    peersRef.current.set(peerId, { connection: pc, stream: remoteStream });

    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current!);
    });

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      setRemoteStreams((prev) => new Map(prev).set(peerId, remoteStream));
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      connectSocket().emit('webrtc:signal', {
        roomId,
        from: userId,
        to: peerId,
        signal: { kind: 'ice-candidate', candidate: event.candidate.toJSON() },
      });
    };

    return pc;
  }, [roomId, userId]);

  const createOfferTo = useCallback(async (peerId: string) => {
    const pc = getOrCreatePeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      connectSocket().emit('webrtc:signal', {
        roomId, from: userId, to: peerId, signal: { kind: 'offer', sdp: offer },
      });
    } catch (err) {
      console.error('[webrtc] createOfferTo failed:', (err as Error).message);
    }
  }, [getOrCreatePeer, roomId, userId]);

  const handleSignal = useCallback(async ({ from, to, signal }: { from: string; to: string; signal: WebRTCSignal }) => {
    if (to !== userId) return; // relay is room-wide; ignore anything not addressed to us
    if (signal.kind === 'offer') {
      const pc = getOrCreatePeer(from);
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      connectSocket().emit('webrtc:signal', {
        roomId, from: userId, to: from, signal: { kind: 'answer', sdp: answer },
      });
    } else if (signal.kind === 'answer') {
      const entry = peersRef.current.get(from);
      if (entry) await entry.connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.kind === 'ice-candidate') {
      const entry = peersRef.current.get(from);
      if (entry) {
        try {
          await entry.connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (err) {
          console.error('[webrtc] addIceCandidate failed:', (err as Error).message);
        }
      }
    }
  }, [userId, roomId, getOrCreatePeer]);

  const stopCall = useCallback(() => {
    peersRef.current.forEach((_entry, peerId) => closePeer(peerId));
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    connectSocket().emit('participant:update', { roomId, userId, inCall: false });
  }, [closePeer, roomId, userId]);

  const startCall = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      // Apply any toggle state chosen before joining (e.g. user pre-muted, then clicked join).
      stream.getVideoTracks().forEach((t) => { t.enabled = cameraOnRef.current; });
      stream.getAudioTracks().forEach((t) => { t.enabled = micOnRef.current; });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setError(null);
      // Broadcast inCall:true only after media is actually ready -- other participants react to
      // this flag by opening a peer connection to us, so by construction our local tracks already
      // exist by the time anyone tries to add them to an offer/answer.
      connectSocket().emit('participant:update', { roomId, userId, inCall: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not access camera or microphone');
    }
  }, [roomId, userId]);

  // Join/leave on `active` transitions only (not on every render) -- a ref tracks the previous
  // value so mounting with active=false doesn't fire a spurious "leave" broadcast.
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      startCall();
    } else if (!active && wasActiveRef.current) {
      stopCall();
    }
    wasActiveRef.current = active;
  }, [active, startCall, stopCall]);

  // Signaling listener -- only while joined. Safe to gate on `active` alone (not localStream
  // readiness): peers only send us an offer after seeing our inCall:true, which startCall only
  // broadcasts once getUserMedia has already resolved, so our local tracks are guaranteed ready
  // by the time any real offer for this session arrives.
  useEffect(() => {
    if (!active) return;
    const socket = connectSocket();
    socket.on('webrtc:signal', handleSignal);
    return () => { socket.off('webrtc:signal', handleSignal); };
  }, [active, handleSignal]);

  // React to who else is currently in the call. Connects to newly-joined peers (offering only
  // when our own userId sorts first, to avoid both sides racing to offer each other) and tears
  // down connections for anyone who left the call or the room.
  useEffect(() => {
    if (!active || !localStream) return;
    const inCallIds = participants.filter((p) => p.inCall && p.userId !== userId).map((p) => p.userId);
    const inCallSet = new Set(inCallIds);

    inCallIds.forEach((peerId) => {
      if (!peersRef.current.has(peerId) && userId < peerId) {
        createOfferTo(peerId);
      }
    });
    peersRef.current.forEach((_entry, peerId) => {
      if (!inCallSet.has(peerId)) closePeer(peerId);
    });
  }, [participants, active, localStream, userId, createOfferTo, closePeer]);

  // Hard cleanup on unmount (e.g. navigating away from the room mid-call) -- stop media and
  // close peer connections directly rather than relying on the `active` effect, which won't fire
  // during unmount.
  useEffect(() => {
    return () => {
      // Deliberately read the refs' current value at cleanup time, not a snapshot from mount --
      // we want whatever peers/stream exist when the component actually unmounts (e.g. the user
      // navigates away mid-call), not whatever existed at first render (almost always nothing).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      peersRef.current.forEach((entry) => entry.connection.close());
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !cameraOnRef.current;
    stream.getVideoTracks().forEach((t) => { t.enabled = next; });
    cameraOnRef.current = next;
    setCameraOn(next);
  }, []);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micOnRef.current;
    stream.getAudioTracks().forEach((t) => { t.enabled = next; });
    micOnRef.current = next;
    setMicOn(next);
  }, []);

  return { localStream, remoteStreams, cameraOn, micOn, error, toggleCamera, toggleMic };
}
