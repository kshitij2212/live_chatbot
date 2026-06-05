import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';
import { sleep }       from '../utils/sleep.js';

const log = logger.child({ module: 'ReplyProcessor' });

export function createReplyProcessor(config) {
  const { context, moderation } = config;

  if (!context)    throw new Error('ReplyProcessor: context is required');
  if (!moderation) throw new Error('ReplyProcessor: moderation is required');

  async function onReplyReady({ roomId, text, trigger, usage }) {
    const delayMs = trigger?.delayMs ?? 0;
    if (delayMs > 0) {
      log.debug({ roomId, delayMs }, '⌨️  Simulating typing delay');
      await sleep(delayMs);
    }

    try {
      const modResult = await moderation.check(text);
      if (!modResult.safe) {
        log.warn({ roomId, reason: modResult.reason }, 'Moderation flagged reply — dropping');
        return;
      }

      await context.addBotReply(roomId, text);

      bus.emit(Events.REPLY_SEND, { roomId, trigger, text, usage });

    } catch (err) {
      log.error({ err, roomId }, 'Error in reply handler');
    }
  }

  function init() {
    bus.on(Events.REPLY_READY, onReplyReady);
    log.info('ReplyProcessor initialised');
  }

  function destroy() {
    bus.off(Events.REPLY_READY, onReplyReady);
    log.debug('ReplyProcessor destroyed');
  }

  return { init, destroy };
}
