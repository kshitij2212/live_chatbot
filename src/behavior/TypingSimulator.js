const DEFAULT_WPM = 40;
const DEFAULT_MIN = 400;
const DEFAULT_MAX = 5_000;

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

  const jitter = rawMs * (0.9 + Math.random() * 0.2);

  return Math.round(Math.max(minMs, Math.min(maxMs, jitter)));
}
