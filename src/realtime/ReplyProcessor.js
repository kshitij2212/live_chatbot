import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';
import { sleep }       from '../utils/sleep.js';
import { getRejectQueueModel } from '../memory/models/ModerationQueue.js';
import { Blacklist }       from '../memory/models/Blacklist.js';

const log = logger.child({ module: 'ReplyProcessor' });

export function createReplyProcessor(config) {
  const { context, moderation, botId, redis } = config;

  if (!context)    throw new Error('ReplyProcessor: context is required');
  if (!moderation) throw new Error('ReplyProcessor: moderation is required');
  if (!botId)      throw new Error('ReplyProcessor: botId is required');

  async function onReplyReady({ roomId, text, trigger, usage, contextPayload }) {
    if (!text?.trim()) return;

    try {
      const cleanText = text.trim();
      const RejectQueue = getRejectQueueModel(botId);

      // Check if response text is blacklisted (case-insensitive exact match)
      const isBlacklisted = await Blacklist.findOne({
        phrase: { $regex: new RegExp('^' + cleanText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i') }
      });

      if (isBlacklisted) {
        log.warn({ roomId, botId, text: cleanText }, 'Generated response matches blacklisted phrase — blocking automatically');
        await RejectQueue.create({
          botId,
          roomId,
          question: typeof trigger === 'string' ? trigger : (trigger?.text || trigger?.prompt || ''),
          answer: cleanText,
          status: 'blacklisted',
          trigger,
          usage,
          contextPayload,
        });
        return;
      }

      // Save to ModerationQueue as 'pending'
      const queueItem = await RejectQueue.create({
        botId,
        roomId,
        question: typeof trigger === 'string' ? trigger : (trigger?.text || trigger?.prompt || ''),
        answer: cleanText,
        status: 'pending',
        trigger,
        usage,
        contextPayload,
      });

      log.info({ roomId, botId, queueId: queueItem._id }, 'Saved response to RejectQueue (pending)');

      // Publish new item event to Redis pub/sub
      if (redis) {
        await redis.publish('moderation:channel', JSON.stringify({
          type: 'new_item',
          data: {
            _id: queueItem._id,
            botId,
            roomId,
            question: queueItem.question,
            answer: queueItem.answer,
            status: queueItem.status,
            timestamp: queueItem.timestamp,
          }
        }));
      }
    } catch (err) {
      log.error({ err, roomId }, 'Error in reply handler queueing');
    }
  }

  async function publishApprovedReply({ text, trigger, usage, roomId }) {
    const delayMs = trigger?.delayMs ?? 0;
    if (delayMs > 0) {
      log.debug({ roomId, delayMs }, 'Simulating typing delay');
      await sleep(delayMs);
    }

    try {
      await context.addBotReply(roomId, text, trigger);
      bus.emit(Events.REPLY_SEND, { roomId, trigger, text, usage });
    } catch (err) {
      log.error({ err, roomId }, 'Error sending approved reply');
    }
  }

  function init() {
    bus.on(Events.REPLY_READY, onReplyReady);
    log.info('ReplyProcessor initialised with moderation flow');
  }

  function destroy() {
    bus.off(Events.REPLY_READY, onReplyReady);
    log.debug('ReplyProcessor destroyed');
  }

  return { init, destroy, publishApprovedReply };
}

