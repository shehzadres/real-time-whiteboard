import { io } from 'socket.io-client';

const URL = 'http://localhost:4302';
const roomId = 'test-room-phase9';

function mkUser(n) {
  return { userId: `u${n}`, username: `User${n}`, color: '#6366F1' };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function raceEvent(socket, event, timeoutMs = 800) {
  return Promise.race([
    new Promise((res) => socket.once(event, res)),
    wait(timeoutMs).then(() => null),
  ]);
}

async function main() {
  const results = [];
  const record = (label, pass, detail) => {
    results.push(pass);
    console.log(pass ? `[ok] ${label}` : `[FAIL] ${label}${detail ? `: ${detail}` : ''}`);
  };

  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });
  await new Promise((res) => a.on('connect', res));
  await new Promise((res) => b.on('connect', res));

  a.emit('room:join', { roomId, user: mkUser(1) });
  b.emit('room:join', { roomId, user: mkUser(2) });
  await wait(400);
  console.log('[ok] both clients joined room');

  // 1. Malformed room:join is silently dropped, not crashing the server -- confirmed by a
  //    subsequent well-formed operation from the same connection still working below.
  const c = io(URL, { transports: ['websocket'] });
  await new Promise((res) => c.on('connect', res));
  c.emit('room:join', { roomId: 123, user: { userId: 'u3' /* missing username/color */ } });
  await wait(300);

  // 2. Oversized username is rejected by the schema (>40 chars) -- room:state should never arrive.
  const gotState = new Promise((res) => c.once('room:state', () => res(true)));
  c.emit('room:join', { roomId, user: { userId: 'u3', username: 'x'.repeat(500), color: '#123456' } });
  const stateAfterBadJoin = await Promise.race([gotState, wait(500).then(() => false)]);
  record('oversized username rejected (no room:state)', stateAfterBadJoin === false);

  // 3. Valid join for c now succeeds
  const validState = raceEvent(c, 'room:state');
  c.emit('room:join', { roomId, user: mkUser(3) });
  const stateOk = await validState;
  record('valid room:join after a rejected one still works', !!stateOk);

  // 4. Ownership spoofing: a tries to emit canvas:operation claiming userId u3's identity.
  //    Should be silently dropped (b never sees it broadcast).
  const bGotSpoofedOp = raceEvent(b, 'canvas:operation', 600);
  a.emit('canvas:operation', {
    type: 'add',
    object: { id: 'spoof1', type: 'rectangle', data: { x: 1, y: 1 }, userId: 'u3', timestamp: Date.now() },
    userId: 'u3', // claims to be u3, but this socket authenticated as u1 at room:join
    roomId, timestamp: Date.now(), operationId: 'op-spoof', groupId: 'g-spoof',
  });
  const spoofResult = await bGotSpoofedOp;
  record('spoofed userId on canvas:operation is dropped', spoofResult === null, JSON.stringify(spoofResult));

  // 5. Legit op from a (correct userId u1) still relays fine.
  const bGotRealOp = raceEvent(b, 'canvas:operation');
  a.emit('canvas:operation', {
    type: 'add',
    object: { id: 'real1', type: 'rectangle', data: { x: 1, y: 1 }, userId: 'u1', timestamp: Date.now() },
    userId: 'u1', roomId, timestamp: Date.now(), operationId: 'op-real', groupId: 'g-real',
  });
  const realResult = await bGotRealOp;
  record('legit canvas:operation still relays', !!realResult && realResult.object.id === 'real1');

  // 6. webrtc:signal identity spoofing: a claims `from: u3` while authenticated as u1 -- b must
  //    not see this signal relayed at all.
  const bGotSpoofedSignal = raceEvent(b, 'webrtc:signal', 600);
  a.emit('webrtc:signal', { roomId, from: 'u3', to: 'u2', signal: { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
  const spoofSignal = await bGotSpoofedSignal;
  record('spoofed `from` on webrtc:signal is dropped', spoofSignal === null, JSON.stringify(spoofSignal));

  // 7. Legit webrtc:signal (from matches join identity) still relays.
  const bGotRealSignal = raceEvent(b, 'webrtc:signal');
  a.emit('webrtc:signal', { roomId, from: 'u1', to: 'u2', signal: { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
  const realSignal = await bGotRealSignal;
  record('legit webrtc:signal still relays', !!realSignal && realSignal.from === 'u1');

  // 8. Oversized canvas object data (> validation cap) is rejected -- b never sees it.
  const bGotHuge = raceEvent(b, 'canvas:operation', 600);
  a.emit('canvas:operation', {
    type: 'add',
    object: { id: 'huge1', type: 'pen', data: { points: 'x'.repeat(300_000) }, userId: 'u1', timestamp: Date.now() },
    userId: 'u1', roomId, timestamp: Date.now(), operationId: 'op-huge', groupId: 'g-huge',
  });
  const hugeResult = await bGotHuge;
  record('oversized object data is rejected', hugeResult === null, JSON.stringify(hugeResult && hugeResult.object.id));

  // 9. Rate limiting: flood canvas:operation past the 60/sec limit from a single client and
  //    confirm some fraction gets dropped (b receives fewer than sent).
  let bReceivedCount = 0;
  const counter = (op) => { if (op.operationId?.startsWith('flood')) bReceivedCount++; };
  b.on('canvas:operation', counter);
  const FLOOD_COUNT = 150;
  for (let i = 0; i < FLOOD_COUNT; i++) {
    a.emit('canvas:operation', {
      type: 'add',
      object: { id: `flood${i}`, type: 'rectangle', data: { x: i }, userId: 'u1', timestamp: Date.now() },
      userId: 'u1', roomId, timestamp: Date.now(), operationId: `flood${i}`, groupId: `flood${i}`,
    });
  }
  await wait(1200);
  b.off('canvas:operation', counter);
  record(
    `rate limiting drops flood traffic (${bReceivedCount}/${FLOOD_COUNT} relayed, expect < ${FLOOD_COUNT})`,
    bReceivedCount < FLOOD_COUNT && bReceivedCount > 0,
    `received ${bReceivedCount}`
  );

  // 10. REST API validation + rate limit smoke test
  const badBody = await fetch('http://localhost:4302/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 123 }),
  });
  record('REST /api/rooms rejects invalid body shape', badBody.status === 400, `status ${badBody.status}`);

  const goodBody = await fetch('http://localhost:4302/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'My Room' }),
  });
  const goodJson = await goodBody.json();
  record('REST /api/rooms accepts valid body', goodBody.status === 201 && !!goodJson.roomId, JSON.stringify(goodJson));

  // 11. Security headers present on a normal page response
  const pageRes = await fetch('http://localhost:4302/');
  const csp = pageRes.headers.get('content-security-policy');
  const xfo = pageRes.headers.get('x-frame-options');
  record('security headers present on page response', !!csp && xfo === 'DENY', `csp=${csp ? 'set' : 'missing'} xfo=${xfo}`);

  const allPass = results.every(Boolean);
  console.log(allPass ? `\n[PASS] Phase 9 hardening tests all passed (${results.length}/${results.length})` : `\n[FAIL] ${results.filter((r) => !r).length}/${results.length} Phase 9 tests failed`);

  a.disconnect();
  b.disconnect();
  c.disconnect();
  process.exit(allPass ? 0 : 1);
}

main();
