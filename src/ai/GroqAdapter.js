import logger from '../utils/logger.js';
import { retry } from '../utils/retry.js';

const log = logger.child({ module: 'GroqAdapter' });

// ─── Overview ─────────────────────────────────────────────────────────────────
//
// GroqAdapter is the only file that talks to the Groq API.
// It wraps the OpenAI-compatible /v1/chat/completions endpoint.
//
// Responsibilities:
//   1. Build and send the HTTP request to Groq
//   2. Return the raw completion object — no parsing, no business logic
//   3. Handle HTTP errors, surface them cleanly
//   4. Retry on transient failures (429, 5xx) via the retry utility
//   5. Enforce a request timeout so a stalled API call never blocks forever
//
// GroqAdapter does NOT:
//   - Parse or validate the reply text  (that is ResponseParser's job)
//   - Emit events                        (that is LLMService's job)
//   - Know anything about rooms, users, or context

// ─── Constants ────────────────────────────────────────────────────────────────

const GROQ_API_KEY      = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 15_000;  // 15s — Groq is fast; if it takes longer something is wrong

// HTTP status codes that are safe to retry
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a GroqAdapter instance.
 *
 * @param {object} config
 * @param {string} config.apiKey            - Groq API key
 * @param {string} config.model             - Model ID e.g. 'llama-3.3-70b-versatile'
 * @param {number} [config.maxTokens]       - Max tokens for completion (default 256)
 * @param {number} [config.temperature]     - Sampling temperature (default 0.85)
 * @param {number} [config.timeoutMs]       - Per-request timeout in ms
 * @param {number} [config.maxRetries]      - Max retry attempts on transient errors
 * @param {number} [config.retryBaseMs]     - Base delay for exponential backoff
 */
export function createGroqAdapter(config) {
  const {
    apiKey,
    model,
    maxTokens   = 256,
    temperature = 0.85,
    timeoutMs   = DEFAULT_TIMEOUT_MS,
    maxRetries  = 3,
    retryBaseMs = 500,
  } = config;

  if (!apiKey?.trim()) throw new Error('GroqAdapter: apiKey is required');
  if (!model?.trim())  throw new Error('GroqAdapter: model is required');

  // ── Request builder ──────────────────────────────────────────────────────

  /**
   * Sends a single chat completion request to Groq.
   * Returns the raw parsed JSON response.
   * Throws a GroqError on non-retryable HTTP errors.
   * Throws a RetryableError on retryable HTTP errors (retry utility handles these).
   *
   * @param   {Array<{ role: string, content: string }>} messages
   * @returns {Promise<object>}  Raw completion object
   */
  async function _sendRequest(messages) {
    const body = JSON.stringify({
      model,
      messages,
      max_tokens:  maxTokens,
      temperature,
      stream:      false,      // streaming handled separately when needed
    });

    // AbortController gives us a hard timeout regardless of what fetch does
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(GROQ_API_KEY, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // fetch() itself threw — network error or abort
      if (err.name === 'AbortError') {
        throw new GroqTimeoutError(`Groq request timed out after ${timeoutMs}ms`);
      }
      throw new GroqNetworkError(`Groq network error: ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    // ── HTTP error handling ──────────────────────────────────────────────────

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch { /* ignore */ }

      const status  = response.status;
      const message = `Groq API error ${status}: ${errorBody.slice(0, 200)}`;

      if (RETRYABLE_STATUS.has(status)) {
        // Signal the retry utility to back off and try again
        const retryable = new GroqRetryableError(message);
        retryable.status = status;
        throw retryable;
      }

      // 400, 401, 403 etc. — not worth retrying
      const fatal = new GroqAPIError(message);
      fatal.status = status;
      throw fatal;
    }

    // ── Parse response ───────────────────────────────────────────────────────

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new GroqAPIError(`Failed to parse Groq response as JSON: ${err.message}`, { cause: err });
    }

    return json;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Sends a chat completion request to Groq with automatic retry on
   * transient errors (429, 5xx).
   *
   * @param   {Array<{ role: string, content: string }>} messages
   *          OpenAI-compatible messages array from PromptBuilder
   * @returns {Promise<object>}  Raw Groq completion object
   * @throws  {GroqAPIError}     On non-retryable API errors (4xx except 429)
   * @throws  {GroqTimeoutError} If the request times out
   * @throws  {GroqNetworkError} On network-level failures
   */
  async function complete(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('GroqAdapter.complete: messages must be a non-empty array');
    }

    log.debug({ model, messageCount: messages.length }, 'Sending completion request');

    const completion = await retry(
      () => _sendRequest(messages),
      {
        maxAttempts:   maxRetries,
        baseDelayMs:   retryBaseMs,
        // Only retry on our designated retryable error type
        shouldRetry:   (err) => err instanceof GroqRetryableError,
        onRetry:       (err, attempt) => {
          log.warn(
            { attempt, maxRetries, status: err.status, message: err.message },
            'Groq request failed — retrying'
          );
        },
      }
    );

    log.debug(
      {
        model,
        promptTokens:     completion?.usage?.prompt_tokens,
        completionTokens: completion?.usage?.completion_tokens,
        finishReason:     completion?.choices?.[0]?.finish_reason,
      },
      'Completion received'
    );

    return completion;
  }

  /**
   * Returns the model ID this adapter is configured to use.
   * Useful for logging and debugging in LLMService.
   *
   * @returns {string}
   */
  function getModel() {
    return model;
  }

  return { complete, getModel };
}

// ─── Error types ─────────────────────────────────────────────────────────────
//
// Named error classes let callers distinguish failure modes without
// inspecting error messages. LLMService uses these to decide whether
// to emit REPLY_FAILED or silently drop.

export class GroqAPIError     extends Error { constructor(m, o) { super(m, o); this.name = 'GroqAPIError';     } }
export class GroqTimeoutError extends Error { constructor(m, o) { super(m, o); this.name = 'GroqTimeoutError'; } }
export class GroqNetworkError extends Error { constructor(m, o) { super(m, o); this.name = 'GroqNetworkError'; } }
export class GroqRetryableError extends Error { constructor(m, o) { super(m, o); this.name = 'GroqRetryableError'; } }