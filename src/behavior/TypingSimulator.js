/**
 * TypingSimulator
 *
 * Computes a realistic "thinking + typing" delay before the bot sends a reply.
 *
 * Formula:
 *   delay = (wordCount / WPM) × 60_000  ms
 *
 * Rationale:
 *  - A casual typist does ~40 WPM.
 *  - A 5-word reply takes ~7.5 s at 40 WPM — too long. The maxMs cap (5 000)
 *    ensures replies always arrive within a reasonable window.
 *  - ±10% random jitter prevents all replies arriving at exactly the same lag.
 *
 * PersonalityTraits.typingSpeedMultiplier can scale this up/down per persona.
 */

const DEFAULT_WPM = 40;    // casual human typing pace
const DEFAULT_MIN = 400;   // floor — even a one-word reply has a tiny pause
const DEFAULT_MAX = 5_000; // ceiling — reply within 5 s regardless of length

/**
 * @param {string} text      - Reply text (word count drives the delay)
 * @param {object} [options]
 * @param {number} [options.wordsPerMinute]  - Typing speed (default 40)
 * @param {number} [options.minMs]           - Minimum delay in ms (default 400)
 * @param {number} [options.maxMs]           - Maximum delay in ms (default 5000)
 * @param {number} [options.speedMultiplier] - From PersonalityTraits (default 1.0)
 * @returns {number} Delay in milliseconds
 */
export function computeTypingDelay(text, {
  wordsPerMinute  = DEFAULT_WPM,
  minMs           = DEFAULT_MIN,
  maxMs           = DEFAULT_MAX,
  speedMultiplier = 1.0,
} = {}) {
  const wordCount  = text?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  const effectiveWpm = wordsPerMinute * speedMultiplier;

  const rawMs  = wordCount > 0
    ? (wordCount / effectiveWpm) * 60_000
    : minMs;

  // ±10% jitter so repeated short replies don't arrive at identical intervals
  const jitter = rawMs * (0.9 + Math.random() * 0.2);

  return Math.round(Math.max(minMs, Math.min(maxMs, jitter)));
}
