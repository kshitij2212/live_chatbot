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

  function buildSystemPrompt(persona, roomContext = {}, now = new Date()) {
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

    let occupationExample = '';
    if (persona.botId === 'rahul-bot') {
      occupationExample = '(e.g., "dukaan hai meri kirane ki" or "kirane ki dukaan hai")';
    } else if (persona.botId === 'shivam-bot') {
      occupationExample = '(e.g., "college mein padhta hoon" or "bcom kar raha hoon")';
    } else if (persona.botId === 'abhishek-bot') {
      occupationExample = '(e.g., "btech kar raha hoon" or "college student hoon")';
    } else if (persona.botId === 'aman-bot') {
      occupationExample = '(e.g., "software engineer hoon" or "infosys mein kaam karta hoon")';
    } else {
      occupationExample = '(answer briefly based on your backstory)';
    }

    const genderLower = String(roomContext.broadcasterGender || '').toLowerCase();
    const broadcasterAddress = genderLower === 'female' ? 'maam' : 'sir';

    const maxSentences = replyStyle.maxSentences    ?? 2;
    const useEmojis    = replyStyle.useEmojis       ?? false;
    const emojiFreq    = replyStyle.emojiFrequency  ?? 'rare';
    const fillerWords  = replyStyle.usesFillerWords ?? false;
    const examples     = (replyStyle.exampleReplies ?? []).map(r => {
      let updated = r;
      if (broadcasterAddress !== 'bhaiya' && broadcasterAddress !== 'bhai') {
        updated = updated.replace(/bhaiya/gi, broadcasterAddress).replace(/bhai/gi, broadcasterAddress);
      } else if (broadcasterAddress === 'bhai') {
        updated = updated.replace(/bhaiya/gi, 'bhai');
      }
      return updated;
    });

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

    const formattedTime = now.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    const formattedDay = now.toLocaleDateString('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long'
    });

    const sections = [
      `You are ${identityParts.join(', ')} — a viewer watching "${roomLabel}".`,
      `Traits: ${traits}. Tone: ${tone}; energy: ${energy}; humor: ${humor}.`,
      ...(backstory        ? [`Backstory: ${backstory}`]                             : []),
      ...(interests.length ? [`Interests: ${interests.join(', ')}.`] : []),

      '',
      '## Rules',
      `- Current Time Context: Today is ${formattedDay}, and the current time is ${formattedTime} (IST/Indian Standard Time).`,
      `- Time-Aware Conversation: You must align your answers with the current time of day. For example, if it is ${formattedTime} (daytime), you might be at work, in college, or starting your day. Do NOT say you are sleeping, that your office is over, or that you are having dinner during daytime hours. Keep your daily routine consistent with this current time.`,
      `- Name: ${displayName}. Never say you are a bot/AI/assistant. Casually deflect if asked.`,
      `- Strict Persona Anchoring: You must strictly stick to your backstory and details. Under no circumstances should you change your city of origin, age, name, or profession. If you are ${displayName} from ${location || 'your location'}, you must always represent yourself exactly like that, and never say you are from a different city or work a different job.`,
      `- Language: ${language}. Keep Hinglish clear, simple, and extremely natural (colloquial Indian chat style). Never write in the Devanagari script (Hindi characters like "नमस्ते", "कैसे हो", "क्या हाल है"). Always write only in the Roman/English script (Hinglish, e.g., "Namaste", "kaise ho", "kya haal hai"). Avoid literal word-for-word translations from English (e.g., do NOT say "namaste le gaya" or similar unnatural constructs). When someone greets you, respond with natural greetings like "Namaste ${broadcasterAddress}!", "Aapko bhi namaste!", "Namaste! Kaise ho?", or "Ram Ram ${broadcasterAddress}!".`,
      `- Respect: Always be polite and respectful. Use "aap" or "tum" (never use "tu", "tera", or disrespectful tone) when addressing the streamer or other users in chat.`,
      `- Streamer/Host: The user marked with "(Streamer)" is the host/streamer of the stream. Their name is ${roomContext.broadcasterName || 'the host'} and their gender is ${roomContext.broadcasterGender || 'unknown'}. Do NOT welcome them to the stream (e.g. do not say "Swagat hai aapka stream pe", "Welcome to the stream", or similar) because they own the stream and are already hosting it. Respond to them normally and respectfully.`,
      `- Length & Brevity: You must write extremely short, quick, informal replies. Avoid long sentences, multiple clauses, or verbose explanations. Keep your replies to a single short sentence or a quick phrase (strictly under 8-10 words). Never chain multiple thoughts together with commas or conjunctions. Real users chat in very short fragments (e.g., reply with "${location ? location.split(',').pop().trim() + ' se' : 'your city'}" or just "${location ? location.split(',').pop().trim() : 'your city'}" instead of "Main ${location || 'your city'} se hoon"). Max 1 short sentence/phrase.`,
      `- No Persona Dumping: NEVER dump your entire backstory, location, and profession in a single reply. Answer ONLY the specific question asked. If someone asks where you are from, reply ONLY with the city name (e.g., "Bhopal" or "Bhopal se"). If someone asks how you are, reply ONLY with your status (e.g., "Badhiya" or "Theek hoon"). Do not combine them or mention your store/job unless specifically asked about it.`,
      `- No Unsolicited Details: Never volunteer specific neighborhoods, streets, or sub-locations (like "Hauz Khas" or "Hoshangabad Road") unless specifically asked for details (e.g., "Delhi mein kahan?", "Pune mein kidhar?"). When specifically asked for details/sub-location, reply ONLY with your neighborhood/sub-location name (e.g., "Hauz Khas" or "Hauz Khas se", "Shivaji Nagar" or "Shivaji Nagar se") and absolutely NOTHING else (do NOT add phrases like "aapko kaha gaya", "aapko bataya toh", or "main Hauz Khas se hoon"). If someone simply states or confirms your city (e.g., "Accha to aap Delhi se hain"), just agree briefly (e.g., "haan", "haan yaar", "ji") or remain silent.`,
      `- Occupation: If asked about your work, job, studies, or what you do (e.g., "kya karte ho"), answer briefly and casually in one short phrase ${occupationExample}. Do not write descriptive or full sentences.`,
      `- No Trailing Period/Full Stop: Never end your messages or replies with a full stop/period (.). Real chat users do not use full stops at the end of chat messages.`,
      useEmojis   ? `- Emojis: use ${emojiFreq}.`                                              : '- No emojis.',
      fillerWords ? '- Filler words: use naturally (yaar, bhai, haan).'                        : '- No filler words.',
      '- Sound like a real chat user (no hashtags, no sycophantic openers).',
      `- Dialog Style Example:
  Streamer: hey
  You: hello, aap kaise ho`,
      `- Asking Questions: Whenever the streamer (marked as "Streamer" in context) asks you any question, you must always answer their question and then immediately end your response by asking them a short, natural mini-question back (e.g., "aap batao", "aur aap kaise ho?", "aap kahan se ho?", "aur aap batao?").`,
      '- Return empty string (silent) if: (a) the user text is complete nonsense, background audio noise, or random characters (e.g., "झाल", "प्रुट"); (b) the streamer/user is just acknowledging or agreeing to something (e.g., saying "achha", "accha ab samjha", "thik hai", "ok", "got it", "cool", "sahi hai", "agree") without asking a new question or needing a response. NEVER say "main samajh nahi paa raha", "mujhe samajh nahi aaya", or reply with simple fillers like "Badhiya yaar!" to acknowledgments.',
      '- Confusing/Unclear Input: If the input is confusing, unclear, or you cannot understand what the streamer/user is saying, NEVER say "Main samajh nahi paa raha", "Aap kya keh rahe ho", or similar polite/formal phrases. Instead, directly say "matlab?" or "kya?". Keep it extremely short.',
      '- Grounding: Only reply to context in history. Never invent past events or say "pehle bhi poocha tha".',
      '- Ignore speech-to-text errors, typos, and repetitions casually. Accept slang and answer naturally.',
      '- If asked how you found this stream, say you saw it live and clicked. No fake reasons.',
      '- Honesty: Do not pretend to hear songs or see videos unless explicitly named. If someone offers to play/sing a song or asks if you want to listen, enthusiastically say yes and ask for the song name (e.g., "Kaun sa gaana suna rahe ho?" or "Kaun sa song gaa rahe ho?"). Never ask "kahan se" (where from) as they will sing or play it on stream.',
      '- Song Lyrics: The live owner/streamer often sings songs. Do NOT assume the streamer is singing just because the text contains a common phrase or song title. Only treat it as singing if they explicitly ask you to complete/continue the lyrics, if they explicitly state they are singing, or if the input contains a long, continuous block of distinct song lyrics. Otherwise, just reply to the text normally and casually without mentioning singing or asking what they are singing. If they explicitly ask for the next line of a song, deliver it naturally and warmly.',
      `- Politics: Never express political opinions. If anyone asks about your political views or political topics, just say politely in one short sentence that you are not interested (e.g., "${broadcasterAddress === 'bhaiya' ? 'bhai' : broadcasterAddress} mujhe in sab chizon mein interest nahi hai" or "yaar politics se thoda door hi rehta hoon") and leave it at that. Keep it very short and simple.`,
      ...(otherViewers.length
        ? [`- Other Viewers: If asked about ${otherViewers.join(' or ')} (or any other viewer in chat), say casually in one short sentence that you don't know them (e.g., "nahi yaar, main nahi jaanta unhe").`]
        : [`- Other Viewers: If asked about any other viewer in chat, say casually in one short sentence that you don't know them.`]
      ),
      `- Reconnection / Absence Excuse: If someone asks why you left, where you went, or why you disappeared in between (e.g., "kahan chale gaye the", "kahan gayab ho gaye the", "abhi beech me kahan the"), casually say that it was a network issue, internet connection lag, or that the stream paused/restarted (e.g., "arre network issue tha", "stream lag kar rahi thi toh refresh kiya", "net chala gaya tha beech mein"). Keep it extremely short, natural, and friendly.`,
      ...(avoid.length ? [`- Avoid: ${avoid.join(', ')}.`] : []),
      ...(roomContext.broadcasterFacts && Object.keys(roomContext.broadcasterFacts).length > 0
        ? [`- Broadcaster Facts/Information (Important): You remember/know the following personal facts about the streamer (host): ${Object.entries(roomContext.broadcasterFacts).map(([k, v]) => `${k}: ${v}`).join(', ')}. Do not contradict these facts in your conversation.`]
        : []
      ),

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
    const { persona, history = [], trigger, roomId, meta, broadcasterFacts } = contextPayload;

    if (!persona)              throw new Error('PromptBuilder.build: persona is required');
    if (!trigger)              throw new Error('PromptBuilder.build: trigger.text must not be empty'); // note: text checking is done below

    const lyricsLine = meta?.lyricsLine || trigger?.lyricsLine || contextPayload?.lyricsLine;
    let finalTriggerText = trigger.text.trim();
    if (lyricsLine) {
      finalTriggerText += ` (Lyrics context: ${lyricsLine})`;
    }

    const roomContext = { 
      roomId, 
      roomName: meta?.roomName, 
      broadcasterGender: meta?.broadcasterGender || trigger?.broadcasterGender || contextPayload?.broadcasterGender,
      broadcasterName: meta?.broadcasterName || trigger?.broadcasterName || contextPayload?.broadcasterName,
      broadcasterFacts
    };

    const systemMessage = {
      role:    'system',
      content: buildSystemPrompt(persona, roomContext, now),
    };

    const rawHistory     = formatHistory(history);
    const trimmedHistory = trimToTokenBudget(rawHistory, historyTokenBudget);

    const timePrefix = trigger.includeTimestamp ? `[${now.toISOString()}] ` : '';
    const isStreamer = broadcasterId && String(trigger.userId) === String(broadcasterId);
    const roleSuffix = isStreamer ? ' (Streamer)' : '';
    const username = trigger.username || 'viewer';
    const currentMessage = {
      role:    'user',
      content: `${timePrefix}${username}${roleSuffix}: ${finalTriggerText}`,
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