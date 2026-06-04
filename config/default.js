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

const config = {

  livekit: {
    url:          env('LIVEKIT_URL',          'wss:
    apiKey:       env('LIVEKIT_API_KEY',      'devkey'),
    apiSecret:    env('LIVEKIT_API_SECRET',   'devsecret'),
    roomName:     env('LIVEKIT_ROOM',         'test-room'),
    botIdentity:  env('BOT_IDENTITY',         'zara-bot'),
    botDisplayName: env('BOT_DISPLAY_NAME',   'Zara'),
    
    botPersona:   env('BOT_PERSONA',          'zara'),
    tokenApiUrl: env('LIVEKIT_TOKEN_API', ''),

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

  groq: {
    apiKey:      env('GROQ_API_KEY', ''),            
    model:       env('GROQ_MODEL',    'llama-3.3-70b-versatile'),
    maxTokens:   envInt('GROQ_MAX_TOKENS',   256),
    temperature: envFloat('GROQ_TEMPERATURE', 0.85),
    timeoutMs:   envInt('GROQ_TIMEOUT_MS',   15000),
    maxRetries:  envInt('GROQ_MAX_RETRIES',  3),
    retryBaseMs: envInt('GROQ_RETRY_BASE_MS', 500),
  },

  redis: {
    url:         env('REDIS_URL', 'redis:
    
    contextTtlSeconds: envInt('REDIS_CONTEXT_TTL_SECONDS', 7200),
  },

  context: {
    
    windowSize: envInt('CONTEXT_WINDOW_SIZE', 20),
  },

  prompt: {
    
    historyTokenBudget: envInt('PROMPT_HISTORY_TOKEN_BUDGET', 1500),
  },

  behavior: {
    
    perUserCooldownMs:  envInt('REPLY_COOLDOWN_MS',        30000),
    
    globalCooldownMs:   envInt('GLOBAL_RATE_LIMIT_MS',     8000),
    
    typingDelayMinMs:   envInt('TYPING_DELAY_MIN_MS',      1500),
    typingDelayMaxMs:   envInt('TYPING_DELAY_MAX_MS',      4000),
    
    replyProbability:   envFloat('REPLY_PROBABILITY',      0.85),
  },

  commentFilter: {
    minLength:            envInt('FILTER_MIN_LENGTH',             3),
    maxLength:            envInt('FILTER_MAX_LENGTH',             500),
    rateLimitWindowMs:    envInt('FILTER_RATE_LIMIT_WINDOW_MS',   10000),
    rateLimitMaxMessages: envInt('FILTER_RATE_LIMIT_MAX_MESSAGES', 5),
  },

  logging: {
    level: env('LOG_LEVEL', 'info'),
  },

};

export default config;
