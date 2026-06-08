import logger from '../utils/logger.js';

const log = logger.child({ module: 'GroqGateCheck' });

const SYSTEM_PROMPT = `You are a classifier for a Hindi/English livestream.
Given an utterance from a streamer, decide who is being addressed:

- "aman"   — the streamer is directly addressing Aman (the bot), or using second-person pronouns/terms (like "tum", "aap", "tujhe", "you", "yaar", "bro") without naming any other specific participant. (e.g., "Aman kaha se ho", "kya bol rha hai", "tum batao", "main samjha nahi tum kya bol rahe ho", "aur batao kaha se ho").
- "chat"   — the streamer is addressing the general chat/audience (e.g. "kya chal rha hai", "hello guys", "sab kaise ho")
- "person" — the streamer is directly addressing/talking to another specific participant, moderator, or viewer by name or specific title (e.g., "hello shivam", "shashi suno", "didi aap batao", "rahul kaisa hai", "arav kya bol rha hai"). Do NOT classify as "person" if no specific name is mentioned and they are just addressing "you". Do NOT classify as "person" if the streamer is referring to a third person (like Atif Aslam, Dhoni, Arijit) as a topic of discussion.

Examples:
1. Input: "हेलो अमन कैसे हो" -> Output: "aman"
2. Input: "हेलो शिवम कैसे हो" -> Output: "person"
3. Input: "aur batao kaha se ho" -> Output: "aman" (no other person named)
4. Input: "main samjha nahi tum kya bol rahe ho" -> Output: "aman" (addressed to "you", no other person named)
5. Input: "हेलो गाइस कैसे हो" -> Output: "chat"
6. Input: "kya chal rha hai dosto" -> Output: "chat"
7. Input: "didi aap batao" -> Output: "person" (addresses didi)
8. Input: "acha arijit ka kaun sa gaana sunoge" -> Output: "chat"

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
