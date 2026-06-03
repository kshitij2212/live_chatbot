/**
 * ContextMemoryService
 *
 * Per-room conversational context stored in Redis.
 * Pure storage layer — no token budgeting, no trimming for LLM.
 * That is ContextBuilder's job.
 *
 * Every write:
 *  1. LPUSH the new entry (most recent at index 0)
 *  2. LTRIM to enforce list size limit
 *  3. EXPIRE to refresh the TTL window
 *
 * All three are sent as a pipeline (single round trip).
 *
 * Reads return plain JS arrays/objects — no Redis types leak out.
 */

import { keys, limits, DEFAULT_TTL_SECONDS } from './ContextSchema.js';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'ContextMemoryService' });

/**
 * @param {import('ioredis').Redis} redis
 * @param {object} [config]
 * @param {number} [config.ttlSeconds]  - Key TTL in seconds (default 2h)
 */
export function createContextMemory(redis, config = {}) {
  const ttl = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * LPUSH one JSON-serialized entry, LTRIM to limit, EXPIRE to refresh TTL.
   * All three commands in a single pipeline — one round trip.
   */
  async function pushToList(key, entry, limit) {
    const serialized = JSON.stringify(entry);
    await redis
      .pipeline()
      .lpush(key, serialized)
      .ltrim(key, 0, limit - 1)
      .expire(key, ttl)
      .exec();
  }

  /**
   * Read all entries from a list, parse each from JSON.
   * Returns newest-first (LPUSH order).
   */
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

  // ─── Transcripts ───────────────────────────────────────────────────────────

  /**
   * @param {string} roomId
   * @param {string} text
   * @param {string} speakerId
   */
  async function addTranscript(roomId, text, speakerId) {
    await pushToList(
      keys.transcripts(roomId),
      { text, speakerId, ts: Date.now() },
      limits.transcripts
    );
  }

  /** @returns {Promise<import('./ContextSchema.js').TranscriptEntry[]>} */
  async function getTranscripts(roomId) {
    return readList(keys.transcripts(roomId));
  }

  // ─── Comments ──────────────────────────────────────────────────────────────

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {string} username
   * @param {string} text
   */
  async function addComment(roomId, userId, username, text) {
    await pushToList(
      keys.comments(roomId),
      { userId, username, text, ts: Date.now() },
      limits.comments
    );
  }

  /** @returns {Promise<import('./ContextSchema.js').CommentEntry[]>} */
  async function getComments(roomId) {
    return readList(keys.comments(roomId));
  }

  // ─── Bot replies ───────────────────────────────────────────────────────────

  /** @param {string} roomId @param {string} text */
  async function addBotReply(roomId, text) {
    await pushToList(
      keys.botReplies(roomId),
      { text, ts: Date.now() },
      limits.botReplies
    );
  }

  /** @returns {Promise<import('./ContextSchema.js').BotReplyEntry[]>} */
  async function getBotReplies(roomId) {
    return readList(keys.botReplies(roomId));
  }

  // ─── Room meta ─────────────────────────────────────────────────────────────

  /**
   * Merge fields into the room meta hash.
   * Existing fields not in `meta` are preserved.
   *
   * @param {string} roomId
   * @param {import('./ContextSchema.js').RoomMeta} meta
   */
  async function setMeta(roomId, meta) {
    const key = keys.meta(roomId);
    // HSET accepts flat key-value pairs — spread the meta object
    const pairs = Object.entries(meta).flat();
    await redis
      .pipeline()
      .hset(key, ...pairs)
      .expire(key, ttl)
      .exec();
  }

  /** @returns {Promise<import('./ContextSchema.js').RoomMeta|null>} */
  async function getMeta(roomId) {
    const data = await redis.hgetall(keys.meta(roomId));
    // hgetall returns {} for missing keys — treat as null
    return Object.keys(data).length ? data : null;
  }

  // ─── Cooldown ──────────────────────────────────────────────────────────────

  /**
   * Set cooldown for a room. Key expires automatically after durationMs.
   * @param {string} roomId
   * @param {number} durationMs
   */
  async function setCooldown(roomId, durationMs) {
    await redis.set(keys.cooldown(roomId), '1', 'PX', durationMs);
  }

  /**
   * @param {string} roomId
   * @returns {Promise<boolean>}
   */
  async function isOnCooldown(roomId) {
    const result = await redis.exists(keys.cooldown(roomId));
    return result === 1;
  }

  // ─── Bulk read (used by ContextBuilder) ────────────────────────────────────

  /**
   * Fetch all context for a room in parallel.
   * ContextBuilder calls this once and receives everything it needs.
   *
   * @param {string} roomId
   * @returns {Promise<{ transcripts, comments, botReplies, meta }>}
   */
  async function getAll(roomId) {
    const [transcripts, comments, botReplies, meta] = await Promise.all([
      getTranscripts(roomId),
      getComments(roomId),
      getBotReplies(roomId),
      getMeta(roomId),
    ]);
    return { transcripts, comments, botReplies, meta };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Delete all keys for a room. Called when the bot leaves.
   * @param {string} roomId
   */
  async function clearRoom(roomId) {
    await redis.del(
      keys.transcripts(roomId),
      keys.comments(roomId),
      keys.botReplies(roomId),
      keys.meta(roomId),
      keys.cooldown(roomId)
    );
    log.debug({ roomId }, 'Room context cleared');
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
  };
}