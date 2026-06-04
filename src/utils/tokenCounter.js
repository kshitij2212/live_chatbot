// Lightweight token estimator — no external dependencies.
// Uses the chars/4 heuristic which is accurate enough for English text
// and consistent with what PromptBuilder and TokenBudgetManager use.
// For non-English languages or code-heavy prompts, actual token counts
// may differ by 20–40%. This is acceptable for a prototype — the token
// budget has enough headroom to absorb the variance.
// If you need exact counts later, swap the implementation to use
// tiktoken or Groq's own tokeniser without changing any call sites.

const CHARS_PER_TOKEN = 4;

/**
 * Estimates the number of tokens in a string.
 *
 * @param   {string} text
 * @returns {number}  Estimated token count (always >= 0)
 *
 * @example
 * countTokens('Hello, world!');  // → 4
 */
export function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimates total tokens across an array of chat messages.
 *
 * @param   {Array<{ role: string, content: string }>} messages
 * @returns {number}
 *
 * @example
 * countMessagesTokens([
 *   { role: 'system',    content: 'You are...' },
 *   { role: 'user',      content: 'Hello' },
 * ]);
 */
export function countMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, msg) => {
    // Each message has a small overhead (~4 tokens) for role + formatting
    return total + countTokens(msg?.content ?? '') + 4;
  }, 0);
}

/**
 * Returns true if the messages array fits within the given token budget.
 *
 * @param   {Array<{ role, content }>} messages
 * @param   {number}                   budget
 * @returns {boolean}
 */
export function fitsInBudget(messages, budget) {
  return countMessagesTokens(messages) <= budget;
}