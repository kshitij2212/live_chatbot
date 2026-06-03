/**
 * ReplyProbability
 *
 * Stateless helper — computes the probability [0, 1] of replying to a trigger.
 *
 * Rules (applied additively, then clamped to [0, 1]):
 *  • Direct questions (ends in ?, contains question words) get a +0.4 boost
 *  • Hinglish question words get an additional +0.2 boost
 *  • Transcripts are less reply-worthy than direct comments — multiplied by 0.6
 *
 * BehaviorEngine calls Math.random() > prob to decide whether to skip.
 * Keeping the probability logic here makes it unit-testable independently.
 */

// Common English + Hinglish question words
const QUESTION_WORD_RE = /\b(what|how|why|when|where|who|kya|kaisa|kaisi|kaise|bata|batao|samjha|samjhao|kyun|kab|kaun)\b/i;

/**
 * @param {number}  baseProb - Base probability from config (e.g. 0.4)
 * @param {object}  trigger
 * @param {string}  trigger.type - 'comment' | 'transcript'
 * @param {string}  trigger.text - Trigger text
 * @returns {number} Probability in [0, 1]
 */
export function computeReplyProbability(baseProb, { type, text }) {
  let prob = baseProb;

  // Questions always deserve a response — boost regardless of type
  if (text.includes('?')) {
    prob = Math.min(1.0, prob + 0.4);
  }

  if (QUESTION_WORD_RE.test(text)) {
    prob = Math.min(1.0, prob + 0.2);
  }

  // Transcripts are continuous speech — lower signal than a typed comment
  if (type === 'transcript') {
    prob *= 0.6;
  }

  return Math.max(0, Math.min(1, prob));
}
