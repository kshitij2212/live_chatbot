import logger from '../utils/logger.js';

const log = logger.child({ module: 'GroqGateCheck' });

const SYSTEM_PROMPT = `You are a classifier for a Hindi/English livestream.
Given an utterance from a streamer, decide who is being addressed:

- "aman"   — the streamer is directly addressing Aman (the bot)
- "chat"   — the streamer is addressing the general chat/audience (e.g. "kya chal rha hai", "hello guys", "sab kaise ho")
- "person" — the streamer is directly addressing/talking to another specific participant, moderator, or viewer (e.g., "hello shivam", "shashi suno", "didi aap batao", "rahul kaisa hai"). Do NOT classify as "person" if the streamer is referring to a third person (like a celebrity, singer, player, e.g., "Atif Aslam", "Dhoni", "Arijit") as a topic of discussion or asking about their songs/videos.

Examples:
1. Input: "हेलो अमन कैसे हो" -> Output: "aman"
2. Input: "हेलो शिवम कैसे हो" -> Output: "person"
3. Input: "हेलो शवाम कैसे हो" -> Output: "person"
4. Input: "हेलो गाइस कैसे हो" -> Output: "chat"
5. Input: "kya chal rha hai dosto" -> Output: "chat"
6. Input: "didi aap batao" -> Output: "person"
7. Input: "अच्छा Arijit Singh ka kaun sa gaana sunoge" -> Output: "chat"
8. Input: "अच्छा आतिफ असलम कोंसा गाना सुनोगे" -> Output: "chat"

Reply with ONLY one word: "aman", "chat", or "person". Nothing else.`;

const GATE_TIMEOUT_MS  = 3000;
const GATE_MAX_TOKENS  = 3;
const GATE_TEMPERATURE = 0;

export function createGroqGateCheck({ groqAdapter }) {
  if (!groqAdapter) throw new Error('GroqGateCheck: groqAdapter is required');

  async function check(text) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: text },
    ];

    try {
      const result = await Promise.race([
        groqAdapter.complete(messages, { maxTokens: GATE_MAX_TOKENS, temperature: GATE_TEMPERATURE }),
        timeoutPromise(GATE_TIMEOUT_MS),
      ]);

      if (result === 'TIMEOUT') {
        log.warn({ text }, 'Groq gate timed out — defaulting to "chat"');
        return { directed: 'chat' };
      }

      const raw = result?.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? '';

      if (raw.includes('aman')) {
        log.info({ text, raw }, 'Groq gate → aman');
        return { directed: 'aman' };
      }

      if (raw.includes('person')) {
        log.info({ text, raw }, 'Groq gate → person');
        return { directed: 'person' };
      }

      log.info({ text, raw }, 'Groq gate → chat');
      return { directed: 'chat' };

    } catch (err) {

      log.warn({ err, text }, 'Groq gate error — defaulting to "chat"');
      return { directed: 'chat' };
    }
  }

  return { check };
}

function timeoutPromise(ms) {
  return new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms));
}
