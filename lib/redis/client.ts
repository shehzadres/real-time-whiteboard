import Redis from 'ioredis';

// Type augmentation for the custom Lua command registered on the data client below
// (ioredis has no built-in typing for defineCommand-registered commands).
declare module 'ioredis' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RedisCommander<Context> {
    applyCanvasOp(
      objectsKey: string,
      lastGroupKey: string,
      undoKey: string,
      redoKey: string,
      groupId: string,
      maxHistory: number,
      opType: 'add' | 'update' | 'delete' | 'clear',
      objectId: string,
      objectJson: string
    ): Promise<number>;
    popHistory(
      objectsKey: string,
      sourceStackKey: string,
      targetStackKey: string,
      lastGroupKey: string,
      maxHistory: number
    ): Promise<string | null>;
  }
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let dataClient: Redis | null = null;

// Reserved for the Socket.io Redis adapter (io.adapter(createAdapter(publisher, subscriber))).
// Once `subscriber` is handed to the adapter it operates in Redis subscribe-mode, so it must
// never be reused to run plain commands (HSET/HGETALL/etc) -- use getDataClient() for those.
export function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
    publisher.on('error', (err) => console.error('[Redis Publisher]', err.message));
  }
  return publisher;
}

export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
    subscriber.on('error', (err) => console.error('[Redis Subscriber]', err.message));
  }
  return subscriber;
}

// Atomically (1) snapshots the room's current objects onto the undo stack -- but only if
// `groupId` differs from the last-seen group for this room, i.e. this op starts a new commit --
// and (2) applies the operation's actual mutation to the objects hash, all in one Redis round
// trip. This has to be ONE script, not "snapshot-then-separately-apply" from Node: two ops in a
// row each make two awaited Redis round trips (check-group, then mutate), and Node dispatches the
// next socket event's handler before the previous one's promise chain finishes, so those round
// trips from different ops interleave on the shared connection. That previously let a later op's
// snapshot step run before an earlier op's mutation had landed, corrupting the snapshot content
// (verified by a scripted two-independent-adds-in-a-row test). Bundling both steps into a single
// atomic EVAL fixes this: each op's full effect (snapshot decision + mutation) completes as one
// indivisible unit before Redis starts the next queued command, so ops apply in the same order
// they arrived, with no interleaving window.
// KEYS[1]=objects hash, KEYS[2]=lastGroupId key, KEYS[3]=undo list, KEYS[4]=redo list
// ARGV[1]=groupId, ARGV[2]=max history length, ARGV[3]=op type, ARGV[4]=objectId, ARGV[5]=object JSON
const APPLY_CANVAS_OP_LUA = `
local last = redis.call('GET', KEYS[2])
if last ~= ARGV[1] then
  local vals = redis.call('HVALS', KEYS[1])
  local snapshot = '[' .. table.concat(vals, ',') .. ']'
  redis.call('RPUSH', KEYS[3], snapshot)
  redis.call('LTRIM', KEYS[3], -tonumber(ARGV[2]), -1)
  redis.call('DEL', KEYS[4])
  redis.call('SET', KEYS[2], ARGV[1])
end

if ARGV[3] == 'add' or ARGV[3] == 'update' then
  redis.call('HSET', KEYS[1], ARGV[4], ARGV[5])
elseif ARGV[3] == 'delete' then
  redis.call('HDEL', KEYS[1], ARGV[4])
elseif ARGV[3] == 'clear' then
  redis.call('DEL', KEYS[1])
end
return 1
`;

// Pops the most recent entry off one history stack (undo or redo), pushes the room's *current*
// object state onto the other stack, and restores the popped snapshot as the live object hash --
// all atomically. This has to be one script for the same reason as applyCanvasOp above: "pop,
// read current, push, restore" is 4 logically-dependent steps, and if a second undo/redo request
// for the same room arrives while the first is still mid-flight, separate round trips could
// interleave (e.g. both reading the same "current" state before either restores). One EVAL means
// each undo/redo request is fully serialized against the others.
// Also handles JSON (de)serialization of the snapshot server-side via Redis's built-in cjson, so
// Node gets back the exact snapshot that was restored without a second round trip to re-read it.
// KEYS[1]=objects hash, KEYS[2]=source stack (pop from), KEYS[3]=target stack (push current onto),
// KEYS[4]=lastGroupId key (cleared so the next fresh edit always starts a new undo entry)
// ARGV[1]=max history length
// Returns the popped snapshot as a JSON string, or false if the source stack was empty.
const POP_HISTORY_LUA = `
local popped = redis.call('RPOP', KEYS[2])
if not popped then
  return false
end
local vals = redis.call('HVALS', KEYS[1])
local current = '[' .. table.concat(vals, ',') .. ']'
redis.call('RPUSH', KEYS[3], current)
redis.call('LTRIM', KEYS[3], -tonumber(ARGV[1]), -1)
redis.call('DEL', KEYS[4])
redis.call('DEL', KEYS[1])
local objs = cjson.decode(popped)
for _, obj in ipairs(objs) do
  redis.call('HSET', KEYS[1], obj.id, cjson.encode(obj))
end
return popped
`;

// Plain data client for room state (objects/participants), kept separate from the pub/sub
// pair above since a subscribed connection can't run regular commands.
export function getDataClient(): Redis {
  if (!dataClient) {
    dataClient = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
    dataClient.on('error', (err) => console.error('[Redis Data]', err.message));
    dataClient.defineCommand('applyCanvasOp', { numberOfKeys: 4, lua: APPLY_CANVAS_OP_LUA });
    dataClient.defineCommand('popHistory', { numberOfKeys: 4, lua: POP_HISTORY_LUA });
  }
  return dataClient;
}

// Connects all three clients up front so the Socket.io adapter and roomManager never race
// a lazy first command against an unopened connection.
export async function connectRedisClients(): Promise<void> {
  await Promise.all([getPublisher().connect(), getSubscriber().connect(), getDataClient().connect()]);
}

// Channel naming
export const channels = {
  room: (roomId: string) => `room:${roomId}`,
  presence: (roomId: string) => `presence:${roomId}`,
  history: (roomId: string) => `history:${roomId}`,
};
