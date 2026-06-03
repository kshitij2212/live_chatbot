/**
 * PersonalityTraits
 *
 * Derives behavioral adjustments from a persona config object.
 *
 * Keeping this logic separate from BehaviorEngine means:
 *  - It can be unit-tested without Redis or the full engine
 *  - Adding new traits doesn't require touching BehaviorEngine
 *
 * All adjustments are additive/multiplicative deltas.
 * BehaviorEngine decides how to apply them.
 */

/**
 * @typedef {object} TraitAdjustments
 * @property {number} probabilityBoost      - Added to baseReplyProbability (e.g. +0.1)
 * @property {number} typingSpeedMultiplier - Scales typing delay (e.g. 1.4 = types faster)
 */

/**
 * Returns behavioral adjustments derived from persona traits and energy level.
 *
 * @param {object} persona - Full persona object from PersonaMemoryService
 * @returns {TraitAdjustments}
 */
export function getTraitAdjustments(persona) {
  const traits  = persona?.personality?.traits ?? [];
  const energy  = persona?.personality?.energy ?? 'medium';

  let probabilityBoost      = 0;
  let typingSpeedMultiplier = 1.0;

  // "curious" bots ask questions and engage more often
  if (traits.includes('curious')) {
    probabilityBoost += 0.10;
  }

  // "supportive" bots reply more freely to everything
  if (traits.includes('supportive')) {
    probabilityBoost += 0.05;
  }

  // "friendly" bots are slightly more talkative
  if (traits.includes('friendly')) {
    probabilityBoost += 0.05;
  }

  // Energy level affects perceived typing speed
  if (energy === 'high') {
    typingSpeedMultiplier = 1.4;   // faster — more energetic
  } else if (energy === 'low') {
    typingSpeedMultiplier = 0.7;   // slower — more relaxed
  }

  return { probabilityBoost, typingSpeedMultiplier };
}
