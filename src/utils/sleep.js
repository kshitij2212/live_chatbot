// Promise-based delay helper.
// Used by:
//   - LiveKitConnector  (reconnect backoff)
//   - BehaviorEngine    (typing simulation delay)
//   - TypingSimulator   (calculated delay before reply)

/**
 * Resolves after `ms` milliseconds.
 *
 * @param   {number} ms - Delay in milliseconds. Clamped to >= 0.
 * @returns {Promise<void>}
 *
 * @example
 * await sleep(1500);
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}