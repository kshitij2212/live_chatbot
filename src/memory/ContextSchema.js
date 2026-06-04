/**
 * ContextSchema
 *
 * Single source of truth for:
 *  - Redis key patterns used by ContextMemoryService
 *  - Data shapes stored at each key
 *  - List size limits per key type
 *
 * Nothing outside memory/ should construct Redis keys manually.
 * Import keys() from here wherever a key is needed.
 */

export const keys = {
  transcripts: (roomId) => `context:${roomId}:transcripts`,
  comments:    (roomId) => `context:${roomId}:comments`,
  botReplies:  (roomId) => `context:${roomId}:bot_replies`,
  meta:        (roomId) => `context:${roomId}:meta`,
  cooldown:    (roomId) => `context:${roomId}:cooldown`,
};

// LPUSH + LTRIM enforces these on every write.
// ContextBuilder will further trim to token budget when building prompts.

export const limits = {
  transcripts: 15,   // ~5 minutes of speech at 6s chunks
  comments:    30,   // last 30 user comments
  botReplies:  10,   // last 10 bot replies (anti-repetition)
};

// Refreshed on every write. Streams that end naturally expire after this.
// Override via config.redis.contextTtlSeconds.

export const DEFAULT_TTL_SECONDS = 2 * 60 * 60; // 2 hours

// These are not enforced at runtime — they document what each list entry
// looks like so ContextBuilder knows what to expect when it reads them.

/**
 * Transcript entry — stored in context:{roomId}:transcripts
 * @typedef {object} TranscriptEntry
 * @property {string} text        - Normalized transcript text
 * @property {string} speakerId   - Participant identity
 * @property {number} ts          - Unix ms timestamp
 */

/**
 * Comment entry — stored in context:{roomId}:comments
 * @typedef {object} CommentEntry
 * @property {string} userId    - Participant identity
 * @property {string} username  - Display name
 * @property {string} text      - Comment text
 * @property {number} ts        - Unix ms timestamp
 */

/**
 * Bot reply entry — stored in context:{roomId}:bot_replies
 * @typedef {object} BotReplyEntry
 * @property {string} text  - What the bot said
 * @property {number} ts    - Unix ms timestamp
 */

/**
 * Room meta — stored as a Redis Hash at context:{roomId}:meta
 * @typedef {object} RoomMeta
 * @property {string} roomName   - Human-readable room name
 * @property {string} botUserId  - Bot's participant identity
 * @property {string} startedAt  - ISO timestamp when bot joined
 * @property {string} [language] - Detected language (set later)
 * @property {string} [topic]    - Detected topic keyword (set later)
 */