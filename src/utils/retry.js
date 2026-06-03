import logger from './logger.js';

const log = logger.child({ module: 'retry' });

// ─── Overview ─────────────────────────────────────────────────────────────────
//
// Generic exponential backoff retry wrapper.
// Used by:
//   - GroqAdapter  (transient Groq API failures — 429, 5xx)
//   - RedisClient  (transient Redis connection failures)
//
// Design:
//   - Caller controls WHICH errors are retryable via `shouldRetry`
//   - Exponential backoff with optional jitter
//   - Gives up after `maxAttempts` and rethrows the last error

/**
 * @typedef {object} RetryOptions
 * @property {number}                    [maxAttempts=3]    - Total attempts (including the first)
 * @property {number}                    [baseDelayMs=500]  - Delay before attempt 2 (doubles each time)
 * @property {number}                    [maxDelayMs=15000] - Cap on backoff delay
 * @property {boolean}                   [jitter=true]      - Add ±20% random jitter to each delay
 * @property {(err: Error) => boolean}   [shouldRetry]      - Return true to retry this error (default: always retry)
 * @property {(err: Error, attempt: number) => void} [onRetry] - Called before each retry
 */

/**
 * Calls `fn` up to `maxAttempts` times, backing off on retryable failures.
 *
 * @template T
 * @param   {() => Promise<T>} fn      - Async function to retry
 * @param   {RetryOptions}     options
 * @returns {Promise<T>}               - Resolves with the first successful result
 * @throws                             - Rethrows the last error after all attempts are exhausted
 *
 * @example
 * const result = await retry(
 *   () => fetch('https://api.groq.com/...'),
 *   {
 *     maxAttempts: 3,
 *     baseDelayMs: 500,
 *     shouldRetry: (err) => err instanceof GroqRetryableError,
 *     onRetry:     (err, attempt) => log.warn({ attempt }, 'Retrying Groq request'),
 *   }
 * );
 */
export async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs  = 15_000,
    jitter      = true,
    shouldRetry = () => true,
    onRetry     = null,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Last attempt — don't delay, just rethrow below
      if (attempt === maxAttempts) break;

      // Check if this error is worth retrying
      if (!shouldRetry(err)) {
        log.debug(
          { attempt, errName: err.name },
          'Error is not retryable — giving up immediately'
        );
        break;
      }

      // Calculate backoff delay
      const base  = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = jitter
        ? Math.round(base * (0.8 + Math.random() * 0.4))  // ±20% jitter
        : base;

      if (onRetry) onRetry(err, attempt);

      log.debug(
        { attempt, maxAttempts, delayMs: delay, errName: err.name },
        'Retrying after delay'
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}