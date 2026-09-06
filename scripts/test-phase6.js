const { io } = require('socket.io-client');

const URL = 'http://localhost:4301';
const roomId = 'test-room-phase6';

function mkUser(n) {
  return { userId: `u${n}`, username: `User${n}`, color: '#6366F1' };
}

async function main() {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });

  const waits = [];

  await new Promise((res) => a.on('connect', res));
  await new Promise((res) => b.on('connect', res));
  console.log('[ok] both clients connected');

  a.emit('room:join', { roomId, user: mkUser(1) });
  b.emit('room:join', { roomId, user: mkUser(2) });
  await new Promise((r) => setTimeout(r, 300));
  console.log('[ok] both joined room');

  // Add a canvas object as a baseline (sanity check existing Phase 2-4 path still works)
  const op = {
    type: 'add',
    object: { id: 'obj1', type: 'rectangle', data: { x: 10, y: 10, width: 50, height: 50, stroke: '#fff', strokeWidth: 2 }, userId: 'u1', timestamp: Date.now() },
    userId: 'u1',
    roomId,
    timestamp: Date.now(),
    operationId: 'op1',
    groupId: 'g1',
  };
  const bGotOp = new Promise((res) => b.once('canvas:operation', res));
  a.emit('canvas:operation', op);
  const receivedOp = await Promise.race([bGotOp, new Promise((res) => setTimeout(() => res(null), 1500))]);
  console.log(receivedOp ? '[ok] canvas:operation relay still works' : '[FAIL] canvas:operation relay broken');

  // version:save (Mongo intentionally down in this test -- expect a graceful 'error', not a crash/hang)
  let sawSaveError = false;
  a.once('error', (msg) => { console.log('[ok] version:save failed gracefully:', msg); sawSaveError = true; });
  let sawSaved = false;
  a.once('version:saved', () => { sawSaved = true; });
  a.emit('version:save', { roomId, userId: 'u1', label: 'Test snapshot' });
  await new Promise((r) => setTimeout(r, 800));
  if (!sawSaveError && !sawSaved) console.log('[FAIL] version:save neither errored nor succeeded -- looks hung');
  else if (sawSaved) console.log('[ok] version:save actually succeeded (MongoDB must be reachable)');

  // version:list should never hang the client either way
  let sawList = false;
  a.once('version:list', (list) => { sawList = true; console.log('[ok] version:list responded with', list.length, 'versions'); });
  a.emit('version:list', { roomId });
  await new Promise((r) => setTimeout(r, 800));
  if (!sawList) console.log('[FAIL] version:list never responded');

  // version:restore with a bogus id should emit a clean "not found" error, not crash the server
  let sawRestoreErr = false;
  a.once('error', (msg) => { sawRestoreErr = true; console.log('[ok] version:restore(bad id) errored cleanly:', msg); });
  a.emit('version:restore', { roomId, versionId: 'does-not-exist', userId: 'u1' });
  await new Promise((r) => setTimeout(r, 800));
  if (!sawRestoreErr) console.log('[FAIL] version:restore(bad id) did not error');

  // Confirm the server process is still alive and responsive after all that (no crash)
  const pingRoom = 'ping-room';
  a.emit('room:join', { roomId: pingRoom, user: mkUser(1) });
  let sawState = false;
  a.once('room:state', () => { sawState = true; });
  await new Promise((r) => setTimeout(r, 500));
  console.log(sawState ? '[ok] server still responsive after version errors' : '[FAIL] server unresponsive');

  a.disconnect();
  b.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
