import { CooldownManager }        from './CooldownManager.js';
import { computeReplyProbability } from './ReplyProbability.js';
import { computeTypingDelay }      from './TypingSimulator.js';
import logger                      from '../utils/logger.js';

const log = logger.child({ module: 'BehaviorEngine' });

export class BehaviorEngine {

  constructor(redis, {
    cooldownSeconds      = 10,
    baseReplyProbability = 0.4,
    maxRepliesPerMinute  = 6,
    botId                = 'default-bot',
  } = {}) {
    this.cooldown            = new CooldownManager(redis, { cooldownSeconds, botId });
    this.baseProb            = baseReplyProbability;
    this.maxRepliesPerMinute = maxRepliesPerMinute;
  }

  async evaluate({ roomId, type, text }) {

    const onCooldown = await this.cooldown.isOnCooldown(roomId, type);
    if (onCooldown) {
      log.debug({ roomId, type }, 'On cooldown — skipping');
      return { shouldReply: false, delayMs: 0 };
    }

    const prob = computeReplyProbability(this.baseProb, { type, text });
    if (Math.random() > prob) {
      log.debug({ roomId, type, prob: prob.toFixed(2) }, 'Probability roll failed — skipping');
      return { shouldReply: false, delayMs: 0 };
    }

    await this.cooldown.setCooldown(roomId, type);

    const delayMs = computeTypingDelay(text);

    log.debug({ roomId, type, prob: prob.toFixed(2), delayMs }, 'Reply approved');
    return { shouldReply: true, delayMs };
  }
}

export function createBehaviorEngine(redis, config) {
  return new BehaviorEngine(redis, config);
}
