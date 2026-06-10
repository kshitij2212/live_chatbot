import logger from '../utils/logger.js';

const log = logger.child({ module: 'GroqGateCheck' });

function getSystemPrompt(botName = 'Aman') {
  const botLower = botName.toLowerCase();
  const otherName = botLower === 'aman' ? 'Shivam' : 'Aman';
  const otherLower = otherName.toLowerCase();

  return `You are a classifier for a Hindi/English livestream.
Given an utterance from a streamer, decide who is being addressed:

- "${botLower}"   — the streamer is directly addressing ${botName} (the bot), or using second-person pronouns/terms (like "tum", "aap", "tujhe", "you", "yaar", "bro") without naming any other specific participant. (e.g., "${botName} kaha se ho", "kya bol rha hai", "tum batao", "main samjha nahi tum kya bol rahe ho", "aur batao kaha se ho").
- "chat"   — the streamer is addressing the general chat/audience (e.g. "kya chal rha hai", "hello guys", "sab kaise ho")
- "person" — the streamer is directly addressing/talking to another specific participant, moderator, or viewer by name or specific title (e.g., "hello ${otherLower}", "shashi suno", "didi aap batao", "rahul kaisa hai", "arav kya bol rha hai"). Do NOT classify as "person" if no specific name is mentioned and they are just addressing "you". Do NOT classify as "person" if the streamer is referring to a third person (like Atif Aslam, Dhoni, Arijit) as a topic of discussion.

Examples:
1. Input: "हेलो ${botName === 'Aman' ? 'अमन' : 'शिवम'} कैसे हो" -> Output: "${botLower}"
2. Input: "हेलो ${botName === 'Aman' ? 'शिवम' : 'अमन'} कैसे हो" -> Output: "person"
3. Input: "aur batao kaha se ho" -> Output: "${botLower}" (no other person named)
4. Input: "main samjha nahi tum kya bol rahe ho" -> Output: "${botLower}" (addressed to "you", no other person named)
5. Input: "हेलो गाइस कैसे हो" -> Output: "chat"
6. Input: "kya chal rha hai dosto" -> Output: "chat"
7. Input: "didi aap batao" -> Output: "person" (addresses didi)
8. Input: "acha arijit ka kaun sa gaana sunoge" -> Output: "chat"

Reply with ONLY one word: "${botLower}", "chat", or "person". Nothing else.`;
}

const GATE_TIMEOUT_MS  = 3000;
const GATE_MAX_TOKENS  = 3;
const GATE_TEMPERATURE = 0;

export function createGroqGateCheck({ groqAdapter, botName = 'Aman' }) {
  if (!groqAdapter) throw new Error('GroqGateCheck: groqAdapter is required');

  const botLower = botName.toLowerCase();
  const systemPrompt = getSystemPrompt(botName);

  async function check(text) {
    const messages = [
      { role: 'system', content: systemPrompt },
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

      if (raw.includes(botLower)) {
        log.info({ text, raw }, `Groq gate → ${botLower}`);
        return { directed: botLower };
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
