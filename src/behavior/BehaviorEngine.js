import { CooldownManager }        from './CooldownManager.js';
import { computeReplyProbability } from './ReplyProbability.js';
import { computeTypingDelay }      from './TypingSimulator.js';
import logger                      from '../utils/logger.js';

const log = logger.child({ module: 'BehaviorEngine' });

/**
 * BehaviorEngine
 *
 * The gatekeeper between incoming events and the AI pipeline.
 * For every TRANSCRIPT_READY / COMMENT_RECEIVED trigger, BotRunner calls
 * evaluate() to get a yes/no reply decision and (if yes) a typing delay.
 *
 * Decision pipeline:
 *  1. Cooldown check  — has the bot replied in this room recently?
 *  2. Probability roll — should we reply to this type of content?
 *  3. Set cooldown    — commit to replying; arm silence window
 *  4. Compute delay   — how long should the bot appear to "type"?
 */
export class BehaviorEngine {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {object} [config]
   * @param {number} [config.cooldownSeconds]      - Post-reply silence window (default 10)
   * @param {number} [config.baseReplyProbability] - Base probability of replying (default 0.4)
   * @param {number} [config.maxRepliesPerMinute]  - Unused; reserved for rate-limit logic
   */
  constructor(redis, {
    cooldownSeconds      = 10,
    baseReplyProbability = 0.4,
    maxRepliesPerMinute  = 6,
  } = {}) {
    this.cooldown            = new CooldownManager(redis, { cooldownSeconds });
    this.baseProb            = baseReplyProbability;
    this.maxRepliesPerMinute = maxRepliesPerMinute;  // reserved
  }

  /**
   * Decide whether the bot should reply to this trigger.
   *
   * @param {object}  params
   * @param {string}  params.roomId - Room context (for cooldown key)
   * @param {string}  params.type   - 'comment' | 'transcript'
   * @param {string}  params.text   - Trigger text (for probability calculation)
   * @returns {Promise<{ shouldReply: boolean, delayMs: number }>}
   */
  async evaluate({ roomId, type, text }) {
    // 1. Cooldown gate — stays silent after each reply
    const onCooldown = await this.cooldown.isOnCooldown(roomId);
    if (onCooldown) {
      log.debug({ roomId, type }, 'On cooldown — skipping');
      return { shouldReply: false, delayMs: 0 };
    }

    // 2. Probability roll — accounts for trigger type and content signals
    const prob = computeReplyProbability(this.baseProb, { type, text });
    if (Math.random() > prob) {
      log.debug({ roomId, type, prob: prob.toFixed(2) }, 'Probability roll failed — skipping');
      return { shouldReply: false, delayMs: 0 };
    }

    // 3. Arm cooldown immediately so concurrent triggers don't sneak through
    await this.cooldown.setCooldown(roomId);

    // 4. Compute realistic typing delay based on trigger length
    const delayMs = computeTypingDelay(text);

    log.debug({ roomId, type, prob: prob.toFixed(2), delayMs }, 'Reply approved');
    return { shouldReply: true, delayMs };
  }
}

export function createBehaviorEngine(redis, config) {
  return new BehaviorEngine(redis, config);
}
