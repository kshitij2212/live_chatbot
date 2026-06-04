import { sanitise }                 from './PromptInjectionGuard.js';
import { GroqModerationAdapter }    from './GroqModerationAdapter.js';  
import logger                       from '../utils/logger.js';

const log = logger.child({ module: 'ModerationService' });

export class ModerationService {
  
  constructor({ groqKey } = {}) {
  groqKey ??= process.env.GROQ_API_KEY;

  this.adapter = groqKey?.trim()
    ? new GroqModerationAdapter(groqKey)
    : null;

  if (!this.adapter) {
    log.warn('No groqKey provided — ModerationService will only run PromptInjectionGuard');
  }
}

  async check(text) {
    if (!text?.trim()) {
      return { safe: true, reason: null };
    }

    const sanitised = sanitise(text);
    if (!sanitised) {
      log.warn({ text }, 'Reply fully stripped by PromptInjectionGuard — dropping');
      return { safe: false, reason: 'prompt_injection' };
    }

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
        
        log.error({ err }, 'Groq Moderation (Llama Guard) unavailable — failing open');
      }
    }

    return { safe: true, reason: null };
  }
}

export function createModerationService(config) {
  return new ModerationService(config);
}
