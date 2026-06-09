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

  function buildSystemPrompt(persona, roomContext = {}) {
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

    const maxSentences = replyStyle.maxSentences    ?? 2;
    const useEmojis    = replyStyle.useEmojis       ?? false;
    const emojiFreq    = replyStyle.emojiFrequency  ?? 'rare';
    const fillerWords  = replyStyle.usesFillerWords ?? false;
    const examples     = replyStyle.exampleReplies  ?? [];

    const identityParts = [displayName];
    if (age)      identityParts.push(`${age} years old`);
    if (location) identityParts.push(`from ${location}`);

    const roomLabel = roomContext.roomName || roomContext.roomId || 'this live stream';

    const sections = [
      `You are ${identityParts.join(', ')} — a viewer watching "${roomLabel}".`,
      `Traits: ${traits}. Tone: ${tone}; energy: ${energy}; humor: ${humor}.`,
      ...(backstory        ? [`Backstory: ${backstory}`]                             : []),
      ...(interests.length ? [`Interests: ${interests.join(', ')}.`] : []),

      '',
      '## Rules',
      `- Name: ${displayName}. Never say you are a bot/AI/assistant. Casually deflect if asked.`,
      `- Language: ${language}. Keep Hinglish clear, simple and natural. Correct grammar: use "hoon" with "main" (no "main hai"). Do not translate "chilling" literally as "chilla".`,
      `- Length: Max ${maxSentences} short sentence${maxSentences === 1 ? '' : 's'}.`,
      useEmojis   ? `- Emojis: use ${emojiFreq}.`                                              : '- No emojis.',
      fillerWords ? '- Filler words: use naturally (yaar, bhai, haan).'                        : '- No filler words.',
      '- Sound like a real chat user (no hashtags, no sycophantic openers).',
      '- Return empty string (silent) if user text is nonsense, noise, or repeated gibberish (e.g., "झाल", "प्रुट", "कर दो"). Never spam "don\'t understand" replies.',
      '- Grounding: Only reply to context in history. Never invent past events or say "pehle bhi poocha tha".',
      '- Ignore typos/repetition casually. Accept slang without correcting.',
      '- If asked how you found this stream, say you saw it live and clicked. No fake reasons.',
      '- Honesty: Do not pretend to hear songs or see videos unless explicitly named. Ask for details if unsure.',

      ...(avoid.length ? [`- Avoid: ${avoid.join(', ')}.`] : []),

      ...(examples.length
        ? ['', '## Examples', ...examples.map(r => `- ${r}`)]
        : []
      ),
      '',
      '## Context',
      'Live chat setting. Respond ONLY to the latest message. Be brief.',
    ];

    return sections.join('\n');
  }

  function formatHistory(history) {
    return history.reduce((acc, entry) => {
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
    let i     = messages.length - 1;
    const kept = [];

    while (i >= 0) {
      const msg    = messages[i];
      const tokens = countTokens(msg.content);

      if (msg.role === 'assistant' && i > 0) {
        const prevTokens = countTokens(messages[i - 1].content);
        if (total + tokens + prevTokens > budgetTokens) {
          break;
        }
        kept.unshift(messages[i - 1], msg);
        total += tokens + prevTokens;
        i -= 2;
      } else if (msg.role !== 'assistant') {
        if (total + tokens > budgetTokens) break;
        kept.unshift(msg);
        total += tokens;
        i -= 1;
      } else {
        i -= 1;
      }
    }

    const dropped = messages.length - kept.length;
    if (dropped > 0) {
      log.debug({ dropped, kept: kept.length, budgetTokens }, 'History trimmed to fit token budget');
    }

    return kept;
  }

  function build(contextPayload, now = new Date()) {
    const { persona, history = [], trigger, roomId, meta } = contextPayload;

    if (!persona)              throw new Error('PromptBuilder.build: persona is required');
    if (!trigger)              throw new Error('PromptBuilder.build: trigger is required');
    if (!trigger.text?.trim()) throw new Error('PromptBuilder.build: trigger.text must not be empty');

    const roomContext = { roomId, roomName: meta?.roomName };

    const systemMessage = {
      role:    'system',
      content: buildSystemPrompt(persona, roomContext),
    };

    const rawHistory     = formatHistory(history);
    const trimmedHistory = trimToTokenBudget(rawHistory, historyTokenBudget);

    const timePrefix = trigger.includeTimestamp ? `[${now.toISOString()}] ` : '';
    const username = trigger.username || 'viewer';
    const currentMessage = {
      role:    'user',
      content: `${timePrefix}${username}: ${trigger.text.trim()}`,
    };

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