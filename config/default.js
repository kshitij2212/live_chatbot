// ─── config/default.js ────────────────────────────────────────────────────────
//
// Single source of truth for all configuration values.
//
// Priority (highest → lowest):
//   1. Environment variables  (process.env.*)
//   2. Values defined here    (defaults)
//
// All env vars are read once at startup. Changing them at runtime has no effect.
// Sensitive values (API keys, secrets) are NEVER hardcoded here —
// they must be set in .env and will throw if missing in production.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function env(key, fallback) {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== '') return val.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`config: required environment variable "${key}" is not set`);
}

function envInt(key, fallback) {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== '') {
    const n = parseInt(val.trim(), 10);
    if (isNaN(n)) throw new Error(`config: "${key}" must be an integer, got "${val}"`);
    return n;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`config: required environment variable "${key}" is not set`);
}

function envFloat(key, fallback) {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== '') {
    const n = parseFloat(val.trim());
    if (isNaN(n)) throw new Error(`config: "${key}" must be a number, got "${val}"`);
    return n;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`config: required environment variable "${key}" is not set`);
}

// ─── Config object ────────────────────────────────────────────────────────────

const config = {

  // ── LiveKit ────────────────────────────────────────────────────────────────
  livekit: {
    url:          env('LIVEKIT_URL',          'wss://livestreaming-wfekhupp.livekit.cloud'),
    apiKey:       env('LIVEKIT_API_KEY',      'devkey'),
    apiSecret:    env('LIVEKIT_API_SECRET',   'devsecret'),
    roomName:     env('LIVEKIT_ROOM',         'test-room'),
    botIdentity:  env('BOT_IDENTITY',         'zara-bot'),
    botDisplayName: env('BOT_DISPLAY_NAME',   'Zara'),
    // Persona file id under config/personas/<botPersona>.json.
    // Separate from botIdentity so the LiveKit identity can include suffixes
    // like "-bot" while the persona file stays clean (e.g. "aman.json").
    botPersona:   env('BOT_PERSONA',          'zara'),
    tokenApiUrl: env('LIVEKIT_TOKEN_API', ''),

    // New bot config for internal usage
    bot: {
      userId: env('BOT_IDENTITY', 'zara-bot'),
      username: env('BOT_DISPLAY_NAME', 'Zara'),
    },
    reconnect: {
      attempts:   envInt('LIVEKIT_RECONNECT_ATTEMPTS', 5),
      baseMs:     envInt('LIVEKIT_RECONNECT_BASE_MS',  1500),
      maxMs:      envInt('LIVEKIT_RECONNECT_MAX_MS',   30000),
    },
  },

  // ── Groq / LLM ────────────────────────────────────────────────────────────
  groq: {
    apiKey:      env('GROQ_API_KEY', ''),            // fallback empty string for tests
    model:       env('GROQ_MODEL',    'llama-3.3-70b-versatile'),
    maxTokens:   envInt('GROQ_MAX_TOKENS',   256),
    temperature: envFloat('GROQ_TEMPERATURE', 0.85),
    timeoutMs:   envInt('GROQ_TIMEOUT_MS',   15000),
    maxRetries:  envInt('GROQ_MAX_RETRIES',  3),
    retryBaseMs: envInt('GROQ_RETRY_BASE_MS', 500),
  },

  // ── Redis ──────────────────────────────────────────────────────────────────
  redis: {
    url:         env('REDIS_URL', 'redis://localhost:6379'),
    // TTL in seconds for a room's context key after last activity.
    // 2 hours — if the stream goes idle, context expires automatically.
    contextTtlSeconds: envInt('REDIS_CONTEXT_TTL_SECONDS', 7200),
  },

  // ── Context memory ─────────────────────────────────────────────────────────
  context: {
    // Max number of messages kept in the rolling window per room.
    windowSize: envInt('CONTEXT_WINDOW_SIZE', 20),
  },

  // ── Prompt / token budget ──────────────────────────────────────────────────
  prompt: {
    // Max tokens allocated to history in the prompt.
    // System prompt + current message + reply headroom are in addition to this.
    historyTokenBudget: envInt('PROMPT_HISTORY_TOKEN_BUDGET', 1500),
  },

  // ── Behavior engine ────────────────────────────────────────────────────────
  behavior: {
    // Minimum ms between replies to the same user
    perUserCooldownMs:  envInt('REPLY_COOLDOWN_MS',        30000),
    // Minimum ms between any two replies in the room
    globalCooldownMs:   envInt('GLOBAL_RATE_LIMIT_MS',     8000),
    // Typing delay range (human-like pause before sending)
    typingDelayMinMs:   envInt('TYPING_DELAY_MIN_MS',      1500),
    typingDelayMaxMs:   envInt('TYPING_DELAY_MAX_MS',      4000),
    // Probability of replying to a valid comment (0.0–1.0).
    // 1.0 = always reply. Lower values make the bot feel more selective.
    replyProbability:   envFloat('REPLY_PROBABILITY',      0.85),
  },

  // ── Comment filter ─────────────────────────────────────────────────────────
  commentFilter: {
    minLength:            envInt('FILTER_MIN_LENGTH',             3),
    maxLength:            envInt('FILTER_MAX_LENGTH',             500),
    rateLimitWindowMs:    envInt('FILTER_RATE_LIMIT_WINDOW_MS',   10000),
    rateLimitMaxMessages: envInt('FILTER_RATE_LIMIT_MAX_MESSAGES', 5),
  },

  // ── Logging ────────────────────────────────────────────────────────────────
  logging: {
    level: env('LOG_LEVEL', 'info'),
  },

};

export default config;