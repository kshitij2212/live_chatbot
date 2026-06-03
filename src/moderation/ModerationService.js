import { sanitise }                 from './PromptInjectionGuard.js';
import { GroqModerationAdapter }    from './GroqModerationAdapter.js';  // ← swapped
import logger                       from '../utils/logger.js';

const log = logger.child({ module: 'ModerationService' });

export class ModerationService {
  /**
   * @param {object} [options]
   * @param {string} [options.groqKey] - Groq API key for Llama Guard moderation
   */
  constructor({ groqKey } = {}) {
  groqKey ??= process.env.GROQ_API_KEY;

  this.adapter = groqKey?.trim()
    ? new GroqModerationAdapter(groqKey)
    : null;

  if (!this.adapter) {
    log.warn('No groqKey provided — ModerationService will only run PromptInjectionGuard');
  }
}

  /**
   * @param {string} text - Bot reply text to inspect
   * @returns {Promise<{ safe: boolean, reason: string | null }>}
   */
  async check(text) {
    if (!text?.trim()) {
      return { safe: true, reason: null };
    }

    // ── Layer 1: prompt injection guard (sync) ───────────────────────────────
    const sanitised = sanitise(text);
    if (!sanitised) {
      log.warn({ text }, 'Reply fully stripped by PromptInjectionGuard — dropping');
      return { safe: false, reason: 'prompt_injection' };
    }

    // ── Layer 2: Llama Guard via Groq (async) ────────────────────────────────
    if (this.adapter) {
      try {
        const result = await this.adapter.check(sanitised);
        if (!result.safe) {
          log.warn({ flaggedCategories: result.flaggedCategories }, 'Reply flagged by Llama Guard — dropping');
          return {
            safe:   false,
            reason: result.flaggedCategories.join(', ') || 'policy_violation',
          };
        }
      } catch (err) {
        // Fail open — moderation outage should not silence the bot.
        log.error({ err }, 'Groq Moderation (Llama Guard) unavailable — failing open');
      }
    }

    return { safe: true, reason: null };
  }
}

export function createModerationService(config) {
  return new ModerationService(config);
}