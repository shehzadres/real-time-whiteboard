import { io } from 'socket.io-client';

const URL = 'http://localhost:4301';
const roomId = 'test-room-phase7';

function mkUser(n) {
  return { userId: `u${n}`, username: `User${n}`, color: '#6366F1' };
}

async function main() {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });

  await new Promise((res) => a.on('connect', res));
  await new Promise((res) => b.on('connect', res));
  console.log('[ok] both clients connected');

  a.emit('room:join', { roomId, user: mkUser(1) });
  b.emit('room:join', { roomId, user: mkUser(2) });
  await new Promise((r) => setTimeout(r, 300));
  console.log('[ok] both joined room');

  // 1. inCall presence: a joins the call, b should see participant:update with inCall:true,
  //    without isEditing being clobbered to false/undefined.
  const bGotInCall = new Promise((res) => {
    b.once('participant:update', (data) => res(data));
  });
  a.emit('participant:update', { roomId, userId: 'u1', inCall: true });
  const inCallUpdate = await Promise.race([bGotInCall, new Promise((res) => setTimeout(() => res(null), 1500))]);
  const pass1 = inCallUpdate && inCallUpdate.userId === 'u1' && inCallUpdate.inCall === true && inCallUpdate.isEditing === undefined;
  console.log(pass1 ? '[ok] participant:update relays inCall:true without touching isEditing' : `[FAIL] inCall update: ${JSON.stringify(inCallUpdate)}`);

  // 2. isEditing update afterwards should not silently clear inCall (server doesn't echo back
  //    the merged Participant, just the patch -- client-side merge is what's under test on the
  //    consuming end, but here we confirm the server emits *only* the patched field, isEditing,
  //    leaving inCall untouched in the payload so a spread-merge on the client is correct).
  const bGotEditing = new Promise((res) => {
    b.once('participant:update', (data) => res(data));
  });
  a.emit('participant:update', { roomId, userId: 'u1', isEditing: true });
  const editingUpdate = await Promise.race([bGotEditing, new Promise((res) => setTimeout(() => res(null), 1500))]);
  const pass2 = editingUpdate && editingUpdate.isEditing === true && editingUpdate.inCall === undefined;
  console.log(pass2 ? '[ok] participant:update patch omits untouched fields (inCall) on a later isEditing-only update' : `[FAIL] editing update: ${JSON.stringify(editingUpdate)}`);

  // 3. WebRTC signaling relay: offer from u1 -> u2, addressed via `to`. u2 should receive it;
  //    a third listener (none here) should NOT need to filter server-side -- confirms relay is
  //    room-wide and client-side `to` filtering is required (by design, see roomManager notes).
  const bGotOffer = new Promise((res) => {
    b.once('webrtc:signal', (data) => res(data));
  });
  const fakeSdp = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  a.emit('webrtc:signal', { roomId, from: 'u1', to: 'u2', signal: { kind: 'offer', sdp: fakeSdp } });
  const offer = await Promise.race([bGotOffer, new Promise((res) => setTimeout(() => res(null), 1500))]);
  const pass3 = offer && offer.from === 'u1' && offer.to === 'u2' && offer.signal.kind === 'offer' && offer.signal.sdp.sdp === fakeSdp.sdp;
  console.log(pass3 ? '[ok] webrtc:signal relays an offer with kind/from/to/sdp intact' : `[FAIL] offer: ${JSON.stringify(offer)}`);

  // 4. Answer relay back the other direction
  const aGotAnswer = new Promise((res) => {
    a.once('webrtc:signal', (data) => res(data));
  });
  b.emit('webrtc:signal', { roomId, from: 'u2', to: 'u1', signal: { kind: 'answer', sdp: fakeSdp } });
  const answer = await Promise.race([aGotAnswer, new Promise((res) => setTimeout(() => res(null), 1500))]);
  const pass4 = answer && answer.from === 'u2' && answer.to === 'u1' && answer.signal.kind === 'answer';
  console.log(pass4 ? '[ok] webrtc:signal relays an answer back to the original offerer' : `[FAIL] answer: ${JSON.stringify(answer)}`);

  // 5. ICE candidate relay
  const bGotCandidate = new Promise((res) => {
    b.once('webrtc:signal', (data) => res(data));
  });
  const fakeCandidate = { candidate: 'candidate:1 1 UDP 2122260223 10.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  a.emit('webrtc:signal', { roomId, from: 'u1', to: 'u2', signal: { kind: 'ice-candidate', candidate: fakeCandidate } });
  const candidate = await Promise.race([bGotCandidate, new Promise((res) => setTimeout(() => res(null), 1500))]);
  const pass5 = candidate && candidate.signal.kind === 'ice-candidate' && candidate.signal.candidate.candidate === fakeCandidate.candidate;
  console.log(pass5 ? '[ok] webrtc:signal relays ICE candidates' : `[FAIL] candidate: ${JSON.stringify(candidate)}`);

  // 6. Sanity: a pre-existing Phase 2-4 path (canvas:operation relay) is unaffected by this phase
  const bGotOp = new Promise((res) => b.once('canvas:operation', res));
  a.emit('canvas:operation', {
    type: 'add',
    object: { id: 'obj1', type: 'rectangle', data: { x: 1, y: 1, width: 10, height: 10, stroke: '#fff', strokeWidth: 2 }, userId: 'u1', timestamp: Date.now() },
    userId: 'u1', roomId, timestamp: Date.now(), operationId: 'op1', groupId: 'g1',
  });
  const receivedOp = await Promise.race([bGotOp, new Promise((res) => setTimeout(() => res(null), 1500))]);
  console.log(receivedOp ? '[ok] canvas:operation relay still works (unaffected by Phase 7)' : '[FAIL] canvas:operation relay broken');

  const allPass = pass1 && pass2 && pass3 && pass4 && pass5 && !!receivedOp;
  console.log(allPass ? '\n[PASS] Phase 7 signaling tests all passed' : '\n[FAIL] one or more Phase 7 tests failed');

  a.disconnect();
  b.disconnect();
  process.exit(allPass ? 0 : 1);
}

main();
