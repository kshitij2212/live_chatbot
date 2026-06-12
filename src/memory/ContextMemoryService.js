import { keys, limits, DEFAULT_TTL_SECONDS, INSIGHTS_TTL_SECONDS } from './ContextSchema.js';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'ContextMemoryService' });

export function createContextMemory(redis, config = {}) {
  const ttl = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const unifiedRoomId = config.unifiedRoomId;

  function getRoomKey(roomId) {
    return unifiedRoomId || roomId;
  }

  async function pushToList(key, entry, limit) {
    const serialized = JSON.stringify(entry);
    await redis
      .pipeline()
      .lpush(key, serialized)
      .ltrim(key, 0, limit - 1)
      .expire(key, ttl)
      .exec();
  }

  async function readList(key) {
    const raw = await redis.lrange(key, 0, -1);
    return raw.map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        log.warn({ key, item }, 'Failed to parse Redis list entry — skipping');
        return null;
      }
    }).filter(Boolean);
  }

  async function addTranscript(roomId, text, speakerId) {
    await pushToList(
      keys.transcripts(getRoomKey(roomId)),
      { text, speakerId, ts: Date.now() },
      limits.transcripts
    );
  }

  async function getTranscripts(roomId) {
    return readList(keys.transcripts(getRoomKey(roomId)));
  }

  async function addComment(roomId, userId, username, text) {
    await pushToList(
      keys.comments(getRoomKey(roomId)),
      { userId, username, text, ts: Date.now() },
      limits.comments
    );
  }

  async function getComments(roomId) {
    return readList(keys.comments(getRoomKey(roomId)));
  }

  async function addBotReply(roomId, text) {
    await pushToList(
      keys.botReplies(getRoomKey(roomId)),
      { text, ts: Date.now() },
      limits.botReplies
    );
  }

  async function getBotReplies(roomId) {
    return readList(keys.botReplies(getRoomKey(roomId)));
  }

  async function setMeta(roomId, meta) {
    const key = keys.meta(getRoomKey(roomId));

    const pairs = Object.entries(meta).flat();
    await redis
      .pipeline()
      .hset(key, ...pairs)
      .expire(key, ttl)
      .exec();
  }

  async function getMeta(roomId) {
    const data = await redis.hgetall(keys.meta(getRoomKey(roomId)));

    return Object.keys(data).length ? data : null;
  }

  async function setCooldown(roomId, durationMs) {
    await redis.set(keys.cooldown(getRoomKey(roomId)), '1', 'PX', durationMs);
  }

  async function isOnCooldown(roomId) {
    const result = await redis.exists(keys.cooldown(getRoomKey(roomId)));
    return result === 1;
  }

  async function getAll(roomId) {
    const [transcripts, comments, botReplies, meta] = await Promise.all([
      getTranscripts(roomId),
      getComments(roomId),
      getBotReplies(roomId),
      getMeta(roomId),
    ]);
    return { transcripts, comments, botReplies, meta };
  }

  async function setInsights(roomId, insights) {
    const key = keys.insights(getRoomKey(roomId));
    const pairs = Object.entries(insights).map(([k, v]) => [
      k, 
      typeof v === 'object' ? JSON.stringify(v) : String(v)
    ]).flat();
    if (pairs.length === 0) return;
    await redis
      .pipeline()
      .hset(key, ...pairs)
      .expire(key, INSIGHTS_TTL_SECONDS)
      .exec();
    log.debug({ roomId: getRoomKey(roomId) }, 'Room insights updated');
  }

  async function getInsights(roomId) {
    const data = await redis.hgetall(keys.insights(getRoomKey(roomId)));
    const parsed = {};
    for (const [k, v] of Object.entries(data)) {
      try {
        parsed[k] = JSON.parse(v);
      } catch {
        parsed[k] = v;
      }
    }
    return Object.keys(parsed).length ? parsed : null;
  }

  async function clearRoom(roomId) {
    await redis.del(
      keys.transcripts(getRoomKey(roomId)),
      keys.comments(getRoomKey(roomId)),
      keys.botReplies(getRoomKey(roomId)),
      keys.meta(getRoomKey(roomId)),
      keys.cooldown(getRoomKey(roomId))
    );
    log.debug({ roomId: getRoomKey(roomId) }, 'Room context cleared (insights preserved)');
  }

  return {
    addTranscript,
    getTranscripts,
    addComment,
    getComments,
    addBotReply,
    getBotReplies,
    setMeta,
    getMeta,
    setCooldown,
    isOnCooldown,
    getAll,
    clearRoom,
    setInsights,
    getInsights,
  };
}
