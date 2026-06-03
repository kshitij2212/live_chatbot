import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'CommentFilter' });

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULTS = {
  // Text length
  minLength:            3,     // drop comments shorter than this (chars)
  maxLength:            500,   // drop comments longer than this

  // Rate limiting — per userId
  rateLimitWindowMs:    10_000, // sliding window duration
  rateLimitMaxMessages: 5,      // max messages allowed within the window

  // Probability of replying even to valid comments (human-like selectivity).
  // 1.0 = always reply, 0.0 = never reply.
  // Fine-grained reply probability is handled later by BehaviorEngine;
  // this is a coarse first pass so obviously-not-reply-worthy comments
  // don't even reach the LLM pipeline.
  replyProbability:     1.0,

  // Lists
  blockedUserIds:       [],    // userId strings — always drop
  triggerKeywords:      [      // always accept if matched (overrides other rules)
    '?',
  ],
  blocklistPhrases:     [],    // drop if matched (case-insensitive substring)
};

// ─── Regexes ──────────────────────────────────────────────────────────────────

// A comment made entirely of emoji + punctuation + whitespace is low-signal.
// Unicode property escapes require Node 10+ — fine for our target environment.
const EMOJI_ONLY_RE = /^[\p{Emoji}\p{P}\s]+$/u;

// Bot-like usernames: all digits, or ending with common bot suffixes.
const BOT_USERNAME_RE = /^\d+$|bot$|_bot$|-bot$/i;

// ─── Per-user rate-limit state ────────────────────────────────────────────────
//
// Map<userId, number[]>  — array of message timestamps within the window.
// Cleaned up lazily on each access.

const rateLimitMap = new Map();

/**
 * Returns true if this userId has exceeded the rate limit.
 * Mutates rateLimitMap as a side effect.
 *
 * @param {string} userId
 * @param {number} windowMs
 * @param {number} maxMessages
 * @returns {boolean}
 */
function isRateLimited(userId, windowMs, maxMessages) {
  const now        = Date.now();
  const cutoff     = now - windowMs;
  const timestamps = (rateLimitMap.get(userId) ?? []).filter(t => t > cutoff);

  if (timestamps.length >= maxMessages) {
    rateLimitMap.set(userId, timestamps);
    return true;
  }

  timestamps.push(now);
  rateLimitMap.set(userId, timestamps);
  return false;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a CommentFilter instance and wires it to the EventBus.
 *
 * All config values are optional — DEFAULTS are used for anything not provided.
 *
 * @param {Partial<typeof DEFAULTS>} [config]
 * @returns {{ destroy: () => void }}
 */
export function createCommentFilter(config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  const blockedSet = new Set(cfg.blockedUserIds.map(id => String(id).toLowerCase()));

  // ── Rule helpers ─────────────────────────────────────────────────────────────

  /**
   * Returns the first failing rule name, or null if the comment passes all rules.
   *
   * Rules are evaluated cheapest-first to minimise work for spam.
   *
   * @param {{ roomId, userId, username, text, ts, source }} comment
   * @returns {string | null}  reason string if rejected, null if accepted
   */
  function evaluate(comment) {
    const { userId, username, text } = comment;
    const lowerText = text.toLowerCase();

    // ── Fast-pass: trigger keywords always win ──────────────────────────────
    // Checked before anything else — a question mark or mention should always
    // get through regardless of other heuristics.
    for (const kw of cfg.triggerKeywords) {
      if (text.includes(kw)) return null;  // accepted
    }

    // ── Hard drops ──────────────────────────────────────────────────────────

    if (blockedSet.has(String(userId).toLowerCase())) {
      return 'blocked_user';
    }

    if (text.length < cfg.minLength) {
      return 'too_short';
    }

    if (text.length > cfg.maxLength) {
      return 'too_long';
    }

    if (EMOJI_ONLY_RE.test(text)) {
      return 'emoji_only';
    }

    if (BOT_USERNAME_RE.test(username)) {
      return 'bot_username';
    }

    // ── Blocklist phrases ───────────────────────────────────────────────────
    for (const phrase of cfg.blocklistPhrases) {
      if (lowerText.includes(phrase.toLowerCase())) {
        return 'blocklist_phrase';
      }
    }

    // ── Rate limit ──────────────────────────────────────────────────────────
    if (isRateLimited(userId, cfg.rateLimitWindowMs, cfg.rateLimitMaxMessages)) {
      return 'rate_limited';
    }

    // ── Reply probability gate ──────────────────────────────────────────────
    // A random roll lets the bot feel selective even for clean comments.
    // BehaviorEngine applies its own finer-grained probability later.
    if (cfg.replyProbability < 1.0 && Math.random() > cfg.replyProbability) {
      return 'probability_skip';
    }

    return null;  // all rules passed
  }

  // ── Event handler ────────────────────────────────────────────────────────────

  function onCommentReceived(comment) {
    const rejectionReason = evaluate(comment);

    if (rejectionReason) {
      log.debug(
        { roomId: comment.roomId, userId: comment.userId, reason: rejectionReason },
        'Comment rejected'
      );

      bus.emit(Events.COMMENT_REJECTED, {
        ...comment,
        reason: rejectionReason,
      });
      return;
    }

    log.debug(
      { roomId: comment.roomId, userId: comment.userId, textLen: comment.text.length },
      'Comment accepted'
    );

    bus.emit(Events.COMMENT_ACCEPTED, comment);
  }

  bus.on(Events.COMMENT_RECEIVED, onCommentReceived);
  log.debug('CommentFilter registered');

  // ── Public API ───────────────────────────────────────────────────────────────

  return {
    /**
     * Removes the COMMENT_RECEIVED bus listener.
     * Call when tearing down the bot to prevent listener leaks.
     */
    destroy() {
      bus.off(Events.COMMENT_RECEIVED, onCommentReceived);
      rateLimitMap.clear();
      log.debug('CommentFilter destroyed');
    },

    /**
     * Runtime config update — replaces current config with new values.
     * Useful for hot-reloading blocklists without restarting the bot.
     *
     * @param {Partial<typeof DEFAULTS>} patch
     */
    updateConfig(patch) {
      Object.assign(cfg, patch);
      if (patch.blockedUserIds) {
        blockedSet.clear();
        for (const id of patch.blockedUserIds) blockedSet.add(String(id).toLowerCase());
      }
      log.info({ patch }, 'CommentFilter config updated');
    },
  };
}