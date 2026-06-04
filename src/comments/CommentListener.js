import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'CommentListener' });

// CommentListener is a thin EventBus bridge — NOT a LiveKit listener.
// LiveKit events are already normalised into EventBus events by RoomEventEmitter:
//   Data channel path:
//     LiveKit DataReceived
//       → RoomEventEmitter.onDataReceived()
//         → bus.emit(COMMENT_RAW)            ← raw, unparsed
//           → CommentParser.onCommentRaw()
//             → bus.emit(COMMENT_RECEIVED)   ← parsed, normalised
//   Native chat path:
//     LiveKit ChatMessage
//       → RoomEventEmitter.onChatMessage()
//         → bus.emit(COMMENT_RECEIVED)       ← already normalised, skips parser
// CommentListener sits at the COMMENT_RECEIVED stage.
// Its job is to be the single observable point for "a comment arrived and
// is ready to be processed" — useful for logging, metrics, and as a hook
// for any future pre-filter logic before CommentFilter runs.
// Pipeline position:
//   COMMENT_RECEIVED → [CommentListener] → CommentFilter → COMMENT_ACCEPTED

/**
 * Creates a CommentListener instance.
 *
 * @param {object} [config]
 * @param {Set<string>} [config.ignoredUserIds]
 *   User IDs to silently drop before any other processing.
 *   This is a last-resort safety valve — primary filtering is in CommentFilter.
 *   Default: empty set.
 */
export function createCommentListener(config = {}) {
  const ignoredUserIds = new Set(
    (config.ignoredUserIds ?? []).map(id => String(id).toLowerCase())
  );

  // Simple in-memory counters — useful for health checks and test assertions.

  const stats = {
    received:   0,   // total COMMENT_RECEIVED events seen
    ignored:    0,   // dropped by ignoredUserIds
    forwarded:  0,   // passed downstream (re-emitted as COMMENT_ACCEPTED candidate)
  };

  /**
   * Handles every COMMENT_RECEIVED event from either path:
   *   - data_channel  (via CommentParser)
   *   - chat_message  (directly from RoomEventEmitter)
   *
   * Shape:
   * {
   *   roomId:   string,
   *   userId:   string,
   *   username: string,
   *   text:     string,
   *   ts:       string,   ← ISO-8601
   *   source:   'data_channel' | 'chat_message'
   * }
   */
  function onCommentReceived(comment) {
    stats.received++;

    const { roomId, userId, username, text, source } = comment;

    // Checked here rather than only in CommentFilter so ignored users never
    // appear in logs or metrics at all — they vanish silently.
    if (ignoredUserIds.has(String(userId).toLowerCase())) {
      stats.ignored++;
      log.debug({ roomId, userId }, 'Comment from ignored user — dropped');
      return;
    }

    log.debug(
      { roomId, userId, username, textLen: text?.length, source },
      'Comment received'
    );

    stats.forwarded++;

    // CommentListener does not re-emit — CommentFilter is already subscribed
    // to COMMENT_RECEIVED on the same bus. This handler is purely observational
    // unless you need to add pre-filter logic here in the future.
    // If you need to intercept and modify comments before CommentFilter sees
    // them, change this to emit a new internal event and update CommentFilter
    // to subscribe to that instead.
  }

  bus.on(Events.COMMENT_RECEIVED, onCommentReceived);
  log.debug('CommentListener registered');

  return {
    /**
     * Removes the COMMENT_RECEIVED bus listener.
     */
    destroy() {
      bus.off(Events.COMMENT_RECEIVED, onCommentReceived);
      log.debug('CommentListener destroyed');
    },

    /**
     * Add a userId to the ignore list at runtime.
     * Useful for muting a spammer without restarting the bot.
     *
     * @param {string} userId
     */
    ignoreUser(userId) {
      ignoredUserIds.add(String(userId).toLowerCase());
      log.info({ userId }, 'User added to CommentListener ignore list');
    },

    /**
     * Remove a userId from the ignore list.
     *
     * @param {string} userId
     */
    unignoreUser(userId) {
      ignoredUserIds.delete(String(userId).toLowerCase());
      log.info({ userId }, 'User removed from CommentListener ignore list');
    },

    /**
     * Returns a snapshot of current stats.
     * @returns {{ received: number, ignored: number, forwarded: number }}
     */
    getStats() {
      return { ...stats };
    },
  };
}