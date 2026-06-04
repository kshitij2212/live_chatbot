import logger from '../utils/logger.js';
import { countTokens } from '../utils/tokenCounter.js';

const log = logger.child({ module: 'PromptBuilder' });

const DEFAULT_HISTORY_TOKEN_BUDGET = 1_500;

export function createPromptBuilder(config = {}) {
  const {
    historyTokenBudget   = DEFAULT_HISTORY_TOKEN_BUDGET,
    tokenBudgetManager   = null,
  } = config;

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

    const traits     = Array.isArray(personality.traits) ? personality.traits.join(', ') : '';
    const tone       = personality.tone   ?? 'casual';
    const energy     = personality.energy ?? 'medium';
    const humor      = personality.humor  ?? 'light';

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

  function trimToTokenBudget(messages, budgetTokens) {
    if (tokenBudgetManager) {
      return tokenBudgetManager.trim(messages, budgetTokens);
    }

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

  function build(contextPayload) {
    const { persona, history = [], trigger, roomId } = contextPayload;

    if (!persona) throw new Error('PromptBuilder.build: persona is required');
    if (!trigger) throw new Error('PromptBuilder.build: trigger is required');

    const systemMessage = {
      role:    'system',
      content: buildSystemPrompt(persona),
    };

    const rawHistoryMessages = formatHistory(history);
    const trimmedHistory     = trimToTokenBudget(rawHistoryMessages, historyTokenBudget);

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

  return {
    
    build,

    buildSystemPrompt,
  };
}
