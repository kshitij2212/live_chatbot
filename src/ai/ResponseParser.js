import logger from '../utils/logger.js';

const log = logger.child({ module: 'ResponseParser' });

// ResponseParser is a pure, stateless module.
// Input:  raw completion object from GroqAdapter (OpenAI-compatible shape)
// Output: { text: string, shouldReply: boolean, raw: object }
// Responsibilities:
//   1. Extract the reply text from the completion object
//   2. Detect "silent" replies — LLM chose not to respond (empty string)
//   3. Strip artefacts: leading/trailing whitespace, role-play prefixes,
//      unwanted formatting the LLM sometimes adds
//   4. Enforce hard length limits
//   5. Never throw — always return a structured result so LLMService
//      can make a clean decision even on malformed LLM output

// Hard cap on reply length (characters).
// Live chat replies should be short — this is a safety net, not a target.
const MAX_REPLY_CHARS = 300;

// Patterns the LLM sometimes prepends despite being told not to.
// Applied in order — first match wins.
// Each is a regex with a capture group for the actual content.
const STRIP_PREFIXES = [
  // "Zara: hello"  or  "Bot: hello"  — LLM echoing its own name
  /^[A-Za-z0-9_ -]{1,32}:\s+/,
  // "*laughs* hello"  — emote prefix
  /^\*[^*]+\*\s*/,
  // "[laughing] hello"  — bracketed emote
  /^\[[^\]]+\]\s*/,
];

// Markdown artefacts that shouldn't appear in a live chat reply
const STRIP_MARKDOWN_RE = /(\*\*|__|\*|_|`{1,3}|~~)/g;

/**
 * Extracts the raw text content from a Groq/OpenAI completion response.
 *
 * Expected shape:
 * {
 *   choices: [{
 *     message: { content: string },
 *     finish_reason: string
 *   }],
 *   usage: { prompt_tokens, completion_tokens, total_tokens }
 * }
 *
 * @param   {object} completion
 * @returns {string | null}  raw content string, or null if extraction failed
 */
function extractContent(completion) {
  if (!completion || typeof completion !== 'object') return null;

  const choice = completion?.choices?.[0];
  if (!choice) return null;

  // finish_reason 'stop' is normal. 'length' means truncated — still usable.
  // 'content_filter' means the provider blocked it — treat as empty.
  if (choice.finish_reason === 'content_filter') {
    log.warn('LLM response blocked by content filter');
    return '';
  }

  const content = choice?.message?.content;
  if (typeof content !== 'string') return null;

  return content;
}

/**
 * Removes role-play prefixes, markdown, and normalises whitespace.
 *
 * @param   {string} text
 * @returns {string}
 */
function cleanText(text) {
  let t = text;

  // Strip known prefixes
  for (const re of STRIP_PREFIXES) {
    t = t.replace(re, '');
  }

  // Strip markdown emphasis characters
  t = t.replace(STRIP_MARKDOWN_RE, '');

  // Collapse internal whitespace runs and trim
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

/**
 * Truncates text to MAX_REPLY_CHARS at a word boundary where possible.
 *
 * @param   {string} text
 * @returns {string}
 */
function enforceMaxLength(text) {
  if (text.length <= MAX_REPLY_CHARS) return text;

  const truncated = text.slice(0, MAX_REPLY_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');

  const result = lastSpace > MAX_REPLY_CHARS * 0.8
    ? truncated.slice(0, lastSpace)
    : truncated;

  log.warn(
    { originalLen: text.length, truncatedLen: result.length },
    'Reply truncated to max length'
  );

  return result;
}

/**
 * Creates a ResponseParser instance.
 *
 * @param {object} [config]
 * @param {number} [config.maxReplyChars] - Override the hard reply length cap
 */
export function createResponseParser(config = {}) {
  const maxReplyChars = config.maxReplyChars ?? MAX_REPLY_CHARS;

  /**
   * Parses a raw Groq/OpenAI completion into a structured reply result.
   *
   * @param {object} completion  - Raw response from GroqAdapter
   * @param {object} [meta]      - Optional metadata for logging (roomId, userId…)
   *
   * @returns {{
   *   text:        string,   — cleaned reply text (empty string if bot chose silence)
   *   shouldReply: boolean,  — false if text is empty or LLM signalled silence
   *   usage:       object,   — token usage from completion (may be null)
   *   raw:         object,   — original completion for debugging
   * }}
   */
  function parse(completion, meta = {}) {
    const rawContent = extractContent(completion);

    // Extraction failed entirely — malformed response
    if (rawContent === null) {
      log.error({ meta, completion }, 'Failed to extract content from completion');
      return {
        text:        '',
        shouldReply: false,
        usage:       completion?.usage ?? null,
        raw:         completion,
      };
    }

    // Clean the extracted text
    let text = cleanText(rawContent);

    // Enforce length cap (may differ from MAX_REPLY_CHARS if config override)
    if (text.length > maxReplyChars) {
      const truncated = text.slice(0, maxReplyChars);
      const lastSpace = truncated.lastIndexOf(' ');
      text = lastSpace > maxReplyChars * 0.8
        ? truncated.slice(0, lastSpace)
        : truncated;
      log.warn({ ...meta, originalLen: rawContent.length, truncatedLen: text.length }, 'Reply truncated');
    }

    // Empty after cleaning → LLM signalled silence
    const shouldReply = text.length > 0;

    if (!shouldReply) {
      log.debug({ meta }, 'LLM returned empty reply — bot will stay silent');
    } else {
      log.debug({ ...meta, replyLen: text.length }, 'Reply parsed successfully');
    }

    return {
      text,
      shouldReply,
      usage: completion?.usage ?? null,
      raw:   completion,
    };
  }

  return { parse };
}