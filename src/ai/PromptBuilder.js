import logger from '../utils/logger.js';
import { countTokens } from '../utils/tokenCounter.js';

const log = logger.child({ module: 'PromptBuilder' });

const DEFAULT_HISTORY_TOKEN_BUDGET = 1_500;

function joinOr(arr, sep, fallback = '') {
  return Array.isArray(arr) && arr.length > 0 ? arr.join(sep) : fallback;
}

export function createPromptBuilder(config = {}) {
  const {
    historyTokenBudget = DEFAULT_HISTORY_TOKEN_BUDGET,
    tokenBudgetManager = null,
  } = config;

  function buildSystemPrompt(persona) {
    const {
      displayName = 'Aman',
      age,
      location,
      language    = 'English',
      backstory   = '',
      interests   = [],
      avoid       = [],
      personality = {},
      replyStyle  = {},
    } = persona;

    const traits = joinOr(personality.traits, ', ', 'friendly and curious');
    const tone   = personality.tone   ?? 'casual';
    const energy = personality.energy ?? 'medium';
    const humor  = personality.humor  ?? 'light';

    const maxSentences = replyStyle.maxSentences   ?? 2;
    const useEmojis    = replyStyle.useEmojis      ?? false;
    const emojiFreq    = replyStyle.emojiFrequency ?? 'rare';
    const fillerWords  = replyStyle.usesFillerWords ?? false;
    const examples     = replyStyle.exampleReplies ?? [];

    const identityParts = [displayName];
    if (age)      identityParts.push(`${age} years old`);
    if (location) identityParts.push(`from ${location}`);

    const sections = [
      
      `You are ${identityParts.join(', ')} — a real human viewer watching a live stream.`,
      `Personality: ${traits}. Tone: ${tone}; energy: ${energy}; humor: ${humor}.`,

      ...(backstory   ? [`Background: ${backstory}`]                             : []),
      ...(interests.length ? [`Especially interested in: ${interests.join(', ')}.`] : []),

      '',
      '## Identity (critical)',
      `- Your name is ${displayName}. If asked, say "${displayName}" — never "bot", "AI", "assistant", or similar.`,
      '- You are a normal human user. Never refer to yourself as a bot, AI, model, or assistant.',
      '- If asked whether you are a bot/AI, deflect casually (e.g. "lol nope, just chilling here").',

      '',
      '## How you behave',
      `- Respond in ${language}.`,
      `- Reply length: at most ${maxSentences} short sentence${maxSentences === 1 ? '' : 's'}.`,
      useEmojis
        ? `- Use emojis ${emojiFreq}.`
        : '- Do not use emojis.',
      fillerWords
        ? '- Use casual filler words naturally where appropriate (yaar, bhai, haan, etc.).'
        : '- Speak cleanly without filler words.',
      '- Sound like a human viewer in a live chat — not an AI assistant.',
      '- Never use hashtags.',
      '- Never open with sycophantic phrases like "Great question!" or "Absolutely!".',
      '- If you have nothing interesting to say, reply with an empty string.',
      '- Never repeat the exact same or very similar reply that you have already sent previously in the conversation history. Keep your responses fresh, diverse, and contextually appropriate.',

      ...(avoid.length ? [`- Never discuss: ${avoid.join(', ')}.`] : []),

      ...(examples.length
        ? ['', '## Examples of how you talk', ...examples.map(r => `- ${r}`)]
        : []
      ),

      '',
      '## Context',
      'You are in a live stream chat. Other viewers are commenting in real time.',
      'Respond only to the most recent comment shown to you.',
      'Keep replies concise — this is a fast-moving chat, not a deep conversation.',
    ];

    return sections.join('\n');
  }

  function formatHistory(history) {
    return history.reduce(( acc, entry) => {
      const text = entry?.text?.trim();
      if (!text) return acc;

      if (entry.role === 'bot') {
        acc.push({ role: 'assistant', content: text });
      } else {
        const prefix = entry.username ? `${entry.username}: ` : '';
        acc.push({ role: 'user', content: `${prefix}${text}` });
      }
      return acc;
    }, []);
  }

  function trimToTokenBudget(messages, budgetTokens) {
    if (tokenBudgetManager) {
      return tokenBudgetManager.trim(messages, budgetTokens);
    }

    let total = 0;
    const kept =  ([]);

    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = countTokens(messages[i].content);
      if (total + tokens > budgetTokens) break;
      kept.unshift(messages[i]);
      total += tokens;
    }

    const dropped = messages.length - kept.length;
    if (dropped > 0) {
      log.debug({ dropped, kept: kept.length, budgetTokens }, 'History trimmed to fit token budget');
    }

    return kept;
  }

  function build(contextPayload) {
    const { persona, history = [], trigger, roomId } = contextPayload;

    if (!persona) throw new Error('PromptBuilder.build: persona is required');
    if (!trigger) throw new Error('PromptBuilder.build: trigger is required');
    if (!trigger.text?.trim()) throw new Error('PromptBuilder.build: trigger.text must not be empty');

    const systemMessage =  ({
      role:    'system',
      content: buildSystemPrompt(persona),
    });

    const rawHistory     = formatHistory(history);
    const trimmedHistory = trimToTokenBudget(rawHistory, historyTokenBudget);

    const currentMessage =  ({
      role:    'user',
      content: `${trigger.username}: ${trigger.text.trim()}`,
    });

    const messages = [systemMessage, ...trimmedHistory, currentMessage];

    log.debug(
      {
        roomId,
        systemTokens:  countTokens(systemMessage.content),
        historyTokens: trimmedHistory.reduce((sum, m) => sum + countTokens(m.content), 0),
        triggerTokens: countTokens(currentMessage.content),
        totalMessages: messages.length,
      },
      'Prompt built',
    );

    return messages;
  }

  return { build, buildSystemPrompt };
}