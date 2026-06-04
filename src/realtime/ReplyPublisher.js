import { DataPacketKind } from '@livekit/rtc-node';
import bus, { Events }   from '../core/EventBus.js';
import logger             from '../utils/logger.js';

const log = logger.child({ module: 'ReplyPublisher' });

// ReplyPublisher is the final step of the reply pipeline.
// It receives REPLY_SEND events from BehaviorEngine (after delays/cooldowns
// have been applied) and publishes the reply into the LiveKit room.
// Two send paths are supported:
//   1. Native chat  (default, recommended)
//      Uses room.localParticipant.sendChatMessage() — the LiveKit SDK's
//      built-in chat API. Messages appear as structured chat events on
//      all connected clients automatically.
//   2. Data channel  (fallback / custom clients)
//      Uses room.localParticipant.publishData() with topic 'chat'.
//      Sends a JSON-encoded payload matching the shape CommentParser expects.
//      Use this if your client listens on the data channel directly.
// The send path is set at construction time via config.sendMode.
// Default: 'chat' (native chat API).
// Pipeline position:
//   BehaviorEngine → REPLY_SEND → [ReplyPublisher] → LiveKit room

const SEND_MODES   = new Set(['chat', 'data_channel']);
const textEncoder  = new TextEncoder();

/**
 * Creates a ReplyPublisher instance.
 *
 * @param {object} config
 * @param {object} config.roomRef
 *   A live reference container: { room: Room | null }.
 *   Using a reference object (not the Room directly) lets LiveKitConnector
 *   swap the Room instance on reconnect without ReplyPublisher needing to
 *   know about it. BotRunner sets this up.
 *
 * @param {string} config.botIdentity
 *   The bot's participant identity. Included in data channel payloads.
 *
 * @param {string} [config.botDisplayName]
 *   Display name included in data channel payloads. Defaults to botIdentity.
 *
 * @param {'chat'|'data_channel'} [config.sendMode='chat']
 *   Which LiveKit API to use for sending replies.
 *
 * @param {string} [config.dataTopic='chat']
 *   Topic string used when sendMode is 'data_channel'.
 */
export function createReplyPublisher(config) {
  const {
    roomRef,
    botIdentity,
    botDisplayName = botIdentity,
    sendMode       = 'chat',
    dataTopic      = 'chat',
  } = config;

  if (!roomRef)      throw new Error('ReplyPublisher: roomRef is required');
  if (!botIdentity)  throw new Error('ReplyPublisher: botIdentity is required');

  if (!SEND_MODES.has(sendMode)) {
    throw new Error(`ReplyPublisher: sendMode must be one of ${[...SEND_MODES].join(', ')}`);
  }

  const stats = {
    sent:   0,
    failed: 0,
  };

  /**
   * Sends via the LiveKit native chat API.
   *
   * Modern LiveKit clients (meet.livekit.io, web SDK >= 2.x) consume chat
   * exclusively via the TextStream API on topic `lk.chat`. The legacy
   * `sendChatMessage()` path is not rendered by those clients, so we use
   * `sendText` with topic `lk.chat` instead. We also call `sendChatMessage`
   * as a best-effort fallback for older clients still listening on the
   * legacy ChatMessage event.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendViaChatAPI(text) {
    const participant = roomRef.room?.localParticipant || roomRef.room;

    if (typeof participant.sendText === 'function') {
      await participant.sendText(text, { topic: 'lk.chat' });
    }

    if (typeof participant.sendChatMessage === 'function') {
      try {
        await participant.sendChatMessage(text);
      } catch (err) {
        log.debug({ err }, 'Legacy sendChatMessage failed (non-fatal)');
      }
    }
  }

  /**
   * Sends via the LiveKit data channel as a JSON-encoded payload.
   * Topic is set to `dataTopic` (default: 'chat') so RoomEventEmitter
   * on other bots or clients can route it correctly.
   *
   * Payload shape matches what CommentParser expects:
   * {
   *   text:     string,
   *   userId:   string,
   *   username: string,
   *   ts:       number,   ← Unix ms
   * }
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendViaDataChannel(text) {
    const participant = roomRef.room?.localParticipant || roomRef.room;
    const payload = textEncoder.encode(
      JSON.stringify({
        text,
        userId:   botIdentity,
        username: botDisplayName,
        ts:       Date.now(),
      })
    );

    await participant.publishData(payload, {
      reliable: true,            // guaranteed delivery — replies must not be lost
      topic:    dataTopic,
      kind:     DataPacketKind.RELIABLE,
    });
  }

  /**
   * Handles REPLY_SEND events from BehaviorEngine.
   *
   * REPLY_SEND shape (emitted by BehaviorEngine after delays):
   * {
   *   roomId:  string,
   *   trigger: { userId, username, text, ts, source },
   *   text:    string,   ← the reply to send
   *   usage:   object,   ← token usage (forwarded for logging)
   * }
   */
  async function onReplySend({ roomId, trigger, text, usage }) {
    if (!roomRef.room) {
      log.warn({ roomId }, 'Cannot send reply — no active room instance');
      stats.failed++;
      bus.emit(Events.REPLY_FAILED, {
        roomId,
        trigger,
        errName:    'NoRoomInstance',
        errMessage: 'ReplyPublisher: room is not connected',
      });
      return;
    }

    if (!text?.trim()) {
      log.warn({ roomId }, 'onReplySend called with empty text — skipping');
      return;
    }

    log.debug(
      { roomId, userId: trigger?.userId, replyLen: text.length, sendMode },
      'Publishing reply'
    );

    try {
      if (sendMode === 'chat') {
        await sendViaChatAPI(text.trim());
      } else {
        await sendViaDataChannel(text.trim());
      }

      stats.sent++;

      log.info(
        {
          roomId,
          triggerUserId:   trigger?.userId,
          triggerUsername: trigger?.username,
          replyLen:        text.length,
          sendMode,
          promptTokens:    usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
        },
        'Reply sent'
      );

      // Notify the rest of the system that a reply was successfully published.
      // ContextMemoryService listens for this to append the exchange to Redis.
      bus.emit(Events.REPLY_SENT, {
        roomId,
        trigger,
        text:  text.trim(),
        usage,
        ts:    new Date().toISOString(),
      });

    } catch (err) {
      stats.failed++;
      log.error({ roomId, err }, 'Failed to publish reply');

      bus.emit(Events.REPLY_FAILED, {
        roomId,
        trigger,
        errName:    err.name,
        errMessage: err.message,
      });
    }
  }

  bus.on(Events.REPLY_SEND, onReplySend);
  log.debug({ sendMode }, 'ReplyPublisher registered');

  return {
    /**
     * Removes the REPLY_SEND bus listener.
     */
    destroy() {
      bus.off(Events.REPLY_SEND, onReplySend);
      log.debug('ReplyPublisher destroyed');
    },

    /**
     * Returns a snapshot of send stats.
     * @returns {{ sent: number, failed: number }}
     */
    getStats() {
      return { ...stats };
    },
  };
}