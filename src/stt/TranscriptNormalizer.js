/**
 * TranscriptNormalizer
 *
 * Cleans raw Whisper/Groq transcript text before it enters the bot pipeline.
 *
 * Rules (in order):
 *  1. Trim leading/trailing whitespace
 *  2. Collapse multiple spaces into one
 *  3. Remove known Whisper hallucinations
 *  4. Collapse consecutive repeated filler words (umm umm umm → umm)
 *  5. Re-trim after all substitutions
 *  6. Return null if result is empty or too short to be real speech
 *
 * Does NOT:
 *  - Remove filler words entirely
 *  - Rewrite or rephrase sentences
 *  - Change punctuation aggressively
 *  - Touch anything that looks like real speech content
 */

// ─── Whisper hallucinations ───────────────────────────────────────────────────
// Whisper frequently outputs these strings on silence, noise, or short audio.
// Matched case-insensitively, full-string or as a standalone phrase.

const HALLUCINATIONS = [
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'see you in the next video',
  'bye bye',
  'you',                // single-word hallucination on silence
  'the',               // same
  'i',                 // same
];

// Build a single regex that matches any hallucination as the entire string
// (after trimming). Case-insensitive.
const HALLUCINATION_RE = new RegExp(
  `^(${HALLUCINATIONS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[.!?,]*$`,
  'i'
);

// ─── Filler word collapse ──────────────────────────────────────────────────────
// Collapse 2+ consecutive identical filler words into one.
// "umm umm umm" → "umm"   |   "uh uh hello" → "uh hello"
// Only targets known filler words — does not collapse real repeated words
// like "very very good" which may be intentional emphasis.

const FILLERS = ['umm', 'um', 'uh', 'uhh', 'hmm', 'hm', 'mhm', 'erm', 'err'];

// Regex: word boundary, filler, then one or more repetitions of (space + same filler)
// Uses a backreference so each filler only collapses its own repetitions.
const FILLER_COLLAPSE_RE = new RegExp(
  `\\b(${FILLERS.join('|')})(\\s+\\1)+\\b`,
  'gi'
);

// ─── Minimum length ───────────────────────────────────────────────────────────

const MIN_LENGTH = 2;

// ─── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Normalize a raw Whisper transcript.
 *
 * @param {string} raw - Raw text from WhisperAdapter
 * @returns {string|null} Cleaned text, or null if the result is unusable
 */
export function normalizeTranscript(raw) {
  if (typeof raw !== 'string') return null;

  // 1. Trim
  let text = raw.trim();
  if (!text) return null;

  // 2. Collapse multiple spaces
  text = text.replace(/\s{2,}/g, ' ');

  // 3. Drop known Whisper hallucinations
  if (HALLUCINATION_RE.test(text)) return null;

  // 4. Collapse repeated filler words
  text = text.replace(FILLER_COLLAPSE_RE, '$1');

  // 5. Re-trim after substitutions
  text = text.trim();

  // 6. Final length check
  if (text.length < MIN_LENGTH) return null;

  return text;
}