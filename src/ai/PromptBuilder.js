import logger from '../utils/logger.js';
import { countTokens } from '../utils/tokenCounter.js';

const log = logger.child({ module: 'PromptBuilder' });

// ─── Overview ─────────────────────────────────────────────────────────────────
//
// PromptBuilder is a pure, stateless module.
// Input:  contextPayload from ContextBuilder
// Output: OpenAI-compatible messages array  →  [{ role, content }, ...]
//
// Responsibilities:
//   1. Format the system prompt from persona config
//   2. Convert Redis history entries into messages array entries
//   3. Append the current trigger as the final user message
//   4. Trim history to stay within token budget (via TokenBudgetManager)
//
// PromptBuilder does NOT call any external service.
// It does NOT read from Redis.
// It does NOT emit events.
// It simply takes data in and returns a messages array.

// ─── Constants ────────────────────────────────────────────────────────────────

// Rough token budget for the history slice.
// System prompt + current message + reply headroom are reserved separately.
// This is a conservative default; TokenBudgetManager enforces the hard limit.
const DEFAULT_HISTORY_TOKEN_BUDGET = 1_500;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @param {object} [config]
 * @param {number} [config.historyTokenBudget] - Max tokens to spend on history
 * @param {import('../memory/TokenBudgetManager.js').TokenBudgetManager} [config.tokenBudgetManager]
 *   Optional — if provided, its `trim()` is used instead of the built-in budget trimmer.
 */
export function createPromptBuilder(config = {}) {
  const {
    historyTokenBudget   = DEFAULT_HISTORY_TOKEN_BUDGET,
    tokenBudgetManager   = null,
  } = config;

  // ── System prompt builder ─────────────────────────────────────────────────

  /**
   * Constructs the system prompt from the persona config.
   *
   * The system prompt establishes identity, tone, and constraints.
   * It is always the first message in the array.
   *
   * @param {import('../memory/PersonaMemoryService.js').PersonaConfig} persona
   * @returns {string}
   */
  function buildSystemPrompt(persona) {
    const {
      displayName  = 'Aman',
      age,
      personality  = {},
      interests    = [],
      avoid        = [],
      replyStyle   = {},
      backstory    = '',
      language     = 'English',
      location,
    } = persona;

    // personality is an object: { tone, energy, humor, traits[] }
    const traits     = Array.isArray(personality.traits) ? personality.traits.join(', ') : '';
    const tone       = personality.tone   ?? 'casual';
    const energy     = personality.energy ?? 'medium';
    const humor      = personality.humor  ?? 'light';

    // replyStyle is an object: { maxSentences, useEmojis, emojiFrequency, usesFillerWords, exampleReplies[] }
    const maxSentences   = replyStyle.maxSentences   ?? 2;
    const useEmojis      = replyStyle.useEmojis      ?? false;
    const emojiFreq      = replyStyle.emojiFrequency ?? 'rare';
    const fillerWords    = replyStyle.usesFillerWords ?? false;
    const exampleReplies = Array.isArray(replyStyle.exampleReplies) ? replyStyle.exampleReplies : [];

    const lines = [
      `You are ${displayName}${age ? `, ${age} years old` : ''}${location ? ` from ${location}` : ''} — a real human viewer watching a live stream.`,
      `Your personality: ${traits || 'friendly and curious'}.`,
      `Your tone: ${tone}; energy: ${energy}; humor: ${humor}.`,
    ];

    if (backstory) {
      lines.push(`Background: ${backstory}`);
    }

    if (interests.length > 0) {
      lines.push(`You are especially interested in: ${interests.join(', ')}.`);
    }

    lines.push(
      '',
      '## Identity (critical)',
      `- Your name is ${displayName}. If asked your name, you say "${displayName}" — never "bot", "AI", "assistant", or anything similar.`,
      '- You are a normal human user, not a bot. Never refer to yourself as a bot, AI, model, or assistant under any circumstances.',
      '- If anyone asks if you are a bot/AI, deflect casually as a human would (e.g. "lol nope, just chilling here").',
      '',
      '## How you behave',
      `- You respond in ${language}.`,
      `- Reply length: at most ${maxSentences} short sentence${maxSentences === 1 ? '' : 's'}.`,
      `- ${useEmojis ? `You use emojis ${emojiFreq}.` : 'You do not use emojis.'}`,
      `- ${fillerWords ? 'You use casual filler words naturally (yaar, bhai, haan, etc. as appropriate to the language).' : 'You speak cleanly without filler words.'}`,
      '- You sound like a human viewer in a live chat — not an AI assistant.',
      '- You never use hashtags.',
      '- You never start with sycophantic openers like "Great question!" or "Absolutely!".',
      '- If you have nothing interesting to say, reply with an empty string.',
    );

    if (avoid.length > 0) {
      lines.push(`- Never discuss: ${avoid.join(', ')}.`);
    }

    if (exampleReplies.length > 0) {
      lines.push(
        '',
        '## Examples of how you talk',
        ...exampleReplies.map(r => `- ${r}`),
      );
    }

    lines.push(
      '',
      '## Context',
      'You are in a live stream chat. Other viewers are commenting in real time.',
      'Respond only to the most recent comment shown to you.',
      'Keep replies concise — this is a fast-moving chat, not a deep conversation.',
    );

    return lines.join('\n');
  }

  // ── History formatter ────────────────────────────────────────────────────

  /**
   * Converts ContextEntry[] from Redis into OpenAI-compatible message objects.
   *
   * ContextEntry shape (from ContextSchema.js):
   * {
   *   role:     'user' | 'bot',
   *   userId:   string,
   *   username: string,
   *   text:     string,
   *   ts:       string,
   * }
   *
   * Mapping:
   *   role 'user' → { role: 'user',      content: '<username>: <text>' }
   *   role 'bot'  → { role: 'assistant', content: '<text>' }
   *
   * The username prefix on user messages lets the LLM distinguish between
   * different viewers and reference them by name naturally.
   *
   * @param {Array<object>} history
   * @returns {Array<{ role: string, content: string }>}
   */
  function formatHistory(history) {
    return history
      .filter(entry => entry?.text?.trim())
      .map(entry => {
        if (entry.role === 'bot') {
          return { role: 'assistant', content: entry.text.trim() };
        }
        const prefix = entry.username ? `${entry.username}: ` : '';
        return { role: 'user', content: `${prefix}${entry.text.trim()}` };
      });
  }

  // ── Token budget trimmer ─────────────────────────────────────────────────

  /**
   * Trims history messages to fit within the token budget.
   * Removes from the oldest end (front of array) to preserve recent context.
   *
   * If a TokenBudgetManager was provided at construction, delegates to it.
   *
   * @param {Array<{ role, content }>} messages
   * @param {number}                  budgetTokens
   * @returns {Array<{ role, content }>}
   */
  function trimToTokenBudget(messages, budgetTokens) {
    if (tokenBudgetManager) {
      return tokenBudgetManager.trim(messages, budgetTokens);
    }

    // Built-in trimmer — removes from the front until we fit
    let total = 0;
    const reversed = [...messages].reverse();
    const kept     = [];

    for (const msg of reversed) {
      const tokens = countTokens(msg.content);
      if (total + tokens > budgetTokens) break;
      kept.unshift(msg);
      total += tokens;
    }

    if (kept.length < messages.length) {
      log.debug(
        { dropped: messages.length - kept.length, kept: kept.length, budgetTokens },
        'History trimmed to fit token budget'
      );
    }

    return kept;
  }

  // ── Main build function ───────────────────────────────────────────────────

  /**
   * Builds the final messages array from a contextPayload.
   *
   * @param {object} contextPayload
   * @param {object}   contextPayload.persona
   * @param {Array}    contextPayload.history
   * @param {object}   contextPayload.trigger
   * @param {string}   contextPayload.roomId
   *
   * @returns {Array<{ role: string, content: string }>}
   *
   * Output structure:
   *   [0]       { role: 'system',    content: <system prompt>   }
   *   [1..n-1]  { role: 'user'|'assistant', content: <history> }
   *   [n]       { role: 'user',      content: <current comment> }
   */
  function build(contextPayload) {
    const { persona, history = [], trigger, roomId } = contextPayload;

    if (!persona) throw new Error('PromptBuilder.build: persona is required');
    if (!trigger) throw new Error('PromptBuilder.build: trigger is required');

    // 1. System prompt
    const systemMessage = {
      role:    'system',
      content: buildSystemPrompt(persona),
    };

    // 2. History → messages, trimmed to budget
    const rawHistoryMessages = formatHistory(history);
    const trimmedHistory     = trimToTokenBudget(rawHistoryMessages, historyTokenBudget);

    // 3. Current trigger as the final user message
    //    Format: "<username>: <text>"  (same as history user messages)
    const currentMessage = {
      role:    'user',
      content: `${trigger.username}: ${trigger.text}`,
    };

    const messages = [systemMessage, ...trimmedHistory, currentMessage];

    log.debug(
      {
        roomId,
        systemTokens:  countTokens(systemMessage.content),
        historyTokens: countTokens(trimmedHistory.reduce((a, m) => a + m.content, '')),
        triggerTokens: countTokens(currentMessage.content),
        totalMessages: messages.length,
      },
      'Prompt built'
    );

    return messages;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  return {
    /**
     * Builds an OpenAI-compatible messages array from a contextPayload.
     *
     * @param   {object} contextPayload - assembled by ContextBuilder
     * @returns {Array<{ role: string, content: string }>}
     */
    build,

    /**
     * Builds just the system prompt string from a persona config.
     * Useful for testing / inspection without a full contextPayload.
     *
     * @param   {object} persona
     * @returns {string}
     */
    buildSystemPrompt,
  };
}