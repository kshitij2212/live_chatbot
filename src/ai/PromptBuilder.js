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
    broadcasterId = null,
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

    const otherViewers = persona.otherViewers ?? [];

    const maxSentences = replyStyle.maxSentences    ?? 2;
    const useEmojis    = replyStyle.useEmojis       ?? false;
    const emojiFreq    = replyStyle.emojiFrequency  ?? 'rare';
    const fillerWords  = replyStyle.usesFillerWords ?? false;
    const examples     = replyStyle.exampleReplies  ?? [];

    const identityParts = [displayName];
    if (age)      identityParts.push(`${age} years old`);
    if (location) identityParts.push(`from ${location}`);

    const isTechnicalId = (name) => {
      if (!name) return true;
      if (/\s/.test(name)) return false; // Has spaces, likely a human-friendly name
      return /^(room|test|default|livekit|live|stream)[_-]/i.test(name) || 
             /[_-]\d+/.test(name) || 
             /^\d+$/.test(name);
    };

    let roomLabel = 'this live stream';
    if (roomContext.roomName && !isTechnicalId(roomContext.roomName)) {
      roomLabel = roomContext.roomName;
    } else if (roomContext.roomId && !isTechnicalId(roomContext.roomId)) {
      roomLabel = roomContext.roomId;
    }

    const sections = [
      `You are ${identityParts.join(', ')} — a viewer watching "${roomLabel}".`,
      `Traits: ${traits}. Tone: ${tone}; energy: ${energy}; humor: ${humor}.`,
      ...(backstory        ? [`Backstory: ${backstory}`]                             : []),
      ...(interests.length ? [`Interests: ${interests.join(', ')}.`] : []),

      '',
      '## Rules',
      `- Name: ${displayName}. Never say you are a bot/AI/assistant. Casually deflect if asked.`,
      `- Language: ${language}. Keep Hinglish clear, simple and natural`,
      `- Respect: Always be polite and respectful. Use "aap" or "tum" (never use "tu", "tera", or disrespectful tone) when addressing the streamer or other users in chat.`,
      `- Streamer/Host: The user marked with "(Streamer)" is the host/streamer of the stream. Do NOT welcome them to the stream (e.g. do not say "Swagat hai aapka stream pe", "Welcome to the stream", or similar) because they own the stream and are already hosting it. Respond to them normally and respectfully.`,
      `- Length: Max ${maxSentences} short sentence${maxSentences === 1 ? '' : 's'}.`,
      useEmojis   ? `- Emojis: use ${emojiFreq}.`                                              : '- No emojis.',
      fillerWords ? '- Filler words: use naturally (yaar, bhai, haan).'                        : '- No filler words.',
      '- Sound like a real chat user (no hashtags, no sycophantic openers).',
      '- Return empty string (silent) if the user text is complete nonsense, background audio noise, random characters (e.g., "झाल", "प्रुट"), or if you cannot understand what they are saying. NEVER say "main samajh nahi paa raha", "mujhe samajh nahi aaya", or similar phrases. If the input is confusing, incomplete, or not understandable, simply return an empty string (remain silent).',
      '- Grounding: Only reply to context in history. Never invent past events or say "pehle bhi poocha tha".',
      '- Ignore speech-to-text errors, typos, and repetitions casually. Accept slang and answer naturally.',
      '- If asked how you found this stream, say you saw it live and clicked. No fake reasons.',
      '- Honesty: Do not pretend to hear songs or see videos unless explicitly named. If someone offers to play/sing a song or asks if you want to listen, enthusiastically say yes and ask for the song name (e.g., "Kaun sa gaana suna rahe ho?" or "Kaun sa song gaa rahe ho?"). Never ask "kahan se" (where from) as they will sing or play it on stream.',
      '- Song Lyrics: The live owner/streamer often sings songs. Only if the text clearly and explicitly contains recognizable song lyrics or lines, recognize that they are singing, compliment their voice or singing style briefly, and name the correct song, movie, or singer if you know it. Do not comment on singing if the transcription is just normal talking or background noise.',

      '- Politics: Never express political opinions. If anyone asks about your political views or political topics, just say politely in one short sentence that you are not interested (e.g., "bhai mujhe in sab chizon mein interest nahi hai" or "yaar politics se thoda door hi rehta hoon") and leave it at that. Keep it very short and simple.',
      ...(otherViewers.length
        ? [`- Other Viewers: If asked about ${otherViewers.join(' or ')} (or any other viewer in chat), say casually in one short sentence that you don't know them (e.g., "nahi yaar, main nahi jaanta unhe").`]
        : [`- Other Viewers: If asked about any other viewer in chat, say casually in one short sentence that you don't know them.`]
      ),
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
        const isStreamer = broadcasterId && String(entry.userId) === String(broadcasterId);
        const roleSuffix = isStreamer ? ' (Streamer)' : '';
        const prefix = entry.username ? `${entry.username}${roleSuffix}: ` : '';
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
    const isStreamer = broadcasterId && String(trigger.userId) === String(broadcasterId);
    const roleSuffix = isStreamer ? ' (Streamer)' : '';
    const username = trigger.username || 'viewer';
    const currentMessage = {
      role:    'user',
      content: `${timePrefix}${username}${roleSuffix}: ${trigger.text.trim()}`,
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