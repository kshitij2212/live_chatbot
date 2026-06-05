import logger from '../utils/logger.js';

const log = logger.child({ module: 'GroqModerationAdapter' });

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODEL = 'openai/gpt-oss-safeguard-20b';

const SYSTEM_PROMPT = `You are a content moderation classifier.
Decide whether the user message is SAFE or UNSAFE under this policy:

UNSAFE categories:
S1 violent_crimes
S2 non_violent_crimes
S3 sex_related_crimes
S4 child_sexual_exploitation
S5 defamation
S6 specialized_advice
S7 privacy
S8 intellectual_property
S9 indiscriminate_weapons
S10 hate
S11 suicide_self_harm
S12 sexual_content
S13 elections

Respond with exactly one of:
  safe
  unsafe: S<n>[,S<n>...]

No other text.`;

const CATEGORY_MAP = {
  S1:  'violent_crimes',
  S2:  'non_violent_crimes',
  S3:  'sex_related_crimes',
  S4:  'child_sexual_exploitation',
  S5:  'defamation',
  S6:  'specialized_advice',
  S7:  'privacy',
  S8:  'intellectual_property',
  S9:  'indiscriminate_weapons',
  S10: 'hate',
  S11: 'suicide_self_harm',
  S12: 'sexual_content',
  S13: 'elections',
};

export class GroqModerationAdapter {
  constructor(apiKey) {
    if (!apiKey?.trim()) throw new Error('GroqModerationAdapter: apiKey is required');
    this.apiKey = apiKey;
  }

  async check(text) {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model:      MODEL,
        messages:   [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: text },
        ],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {  }
      throw new Error(`Groq Moderation API error: ${res.status} ${res.statusText} ${detail}`);
    }

    const data   = await res.json();
    const output = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';

    log.debug({ output }, 'Llama Guard raw response');

    if (output.startsWith('unsafe')) {
      
      const codesPart = output.replace(/^unsafe[:\s]*/i, '').split('\n')[0] ?? '';
      const codes     = codesPart.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
      const flaggedCategories = codes
        .map(code => CATEGORY_MAP[code] ?? code.toLowerCase())
        .filter(Boolean);

      return { safe: false, flaggedCategories };
    }

    return { safe: true, flaggedCategories: [] };
  }
}
