import bus, { Events }   from '../core/EventBus.js';
import logger             from '../utils/logger.js';
import { GroqAPIError, GroqTimeoutError, GroqNetworkError } from './GroqAdapter.js';

const log = logger.child({ module: 'LLMService' });

// LLMService is the orchestrator of the AI reply pipeline.
// Event flow:
//   CONTEXT_READY
//       ↓
//   LLMService.onContextReady()
//       ↓  calls
//   GroqAdapter.complete(messages)
//       ↓  passes raw completion to
//   ResponseParser.parse(completion)
//       ↓  emits
//   REPLY_READY  { roomId, trigger, text, usage }
//   REPLY_FAILED { roomId, trigger, err }         ← on unrecoverable error
// LLMService enforces a per-room concurrency limit so that if comments
// arrive faster than Groq responds, we don't pile up simultaneous requests
// for the same room. Excess requests for a busy room are dropped (not queued)
// to keep the bot feeling real-time rather than delayed.

// Max simultaneous in-flight Groq requests per room.
// 1 = strict serial per room. Increase only if you expect very high volume.
const MAX_CONCURRENT_PER_ROOM = 1;

/**
 * Creates an LLMService instance.
 *
 * @param {object} deps
 * @param {import('./GroqAdapter.js').GroqAdapter}         deps.groqAdapter
 * @param {import('./ResponseParser.js').ResponseParser}   deps.responseParser
 */
export function createLLMService({ groqAdapter, responseParser }) {
  if (!groqAdapter)    throw new Error('LLMService: groqAdapter is required');
  if (!responseParser) throw new Error('LLMService: responseParser is required');

  // Map<roomId, number>  — count of in-flight requests for each room
  const inFlight = new Map();

  function getInFlight(roomId)      { return inFlight.get(roomId) ?? 0; }
  function incrementInFlight(roomId){ inFlight.set(roomId, getInFlight(roomId) + 1); }
  function decrementInFlight(roomId){
    const next = getInFlight(roomId) - 1;
    if (next <= 0) inFlight.delete(roomId);
    else           inFlight.set(roomId, next);
  }

  /**
   * Handles a CONTEXT_READY event.
   *
   * CONTEXT_READY shape:
   * {
   *   roomId:         string,
   *   trigger:        { userId, username, text, ts, source },
   *   promptMessages: Array<{ role, content }>,
   *   contextPayload: object,   ← passed through to REPLY_READY for memory append
   * }
   */
  async function onContextReady({ roomId, trigger, promptMessages, contextPayload }) {
    // If the room already has MAX_CONCURRENT_PER_ROOM requests in flight,
    // drop this one rather than queuing. A queued reply arriving 10 seconds
    // late is worse than no reply — it breaks the human-like illusion.
    if (getInFlight(roomId) >= MAX_CONCURRENT_PER_ROOM) {
      log.debug(
        { roomId, userId: trigger?.userId, inFlight: getInFlight(roomId) },
        'Dropping LLM request — room concurrency limit reached'
      );
      return;
    }

    incrementInFlight(roomId);

    log.debug(
      { roomId, userId: trigger?.userId, model: groqAdapter.getModel(), messageCount: promptMessages?.length },
      'Requesting LLM completion'
    );

    try {
      const completion = await groqAdapter.complete(promptMessages);

      const parsed = responseParser.parse(completion, { roomId, userId: trigger?.userId });

      if (!parsed.shouldReply) {
        // LLM chose silence — don't publish anything.
        // BehaviorEngine / ReplyPublisher never see this.
        log.debug({ roomId, userId: trigger?.userId }, 'LLM signalled silence — no reply emitted');
        return;
      }

      // REPLY_READY is consumed by BehaviorEngine, which applies
      // delays and cooldowns before handing off to ReplyPublisher.
      bus.emit(Events.REPLY_READY, {
        roomId,
        trigger,
        text:           parsed.text,
        usage:          parsed.usage,
        contextPayload, // forwarded so ContextMemoryService can append the exchange
      });

      log.info(
        { roomId, userId: trigger?.userId, replyLen: parsed.text.length },
        'Reply ready'
      );

    } catch (err) {
      _handleError(err, roomId, trigger);
    } finally {
      decrementInFlight(roomId);
    }
  }

  /**
   * Classifies the error and emits REPLY_FAILED with appropriate context.
   * Never rethrows — LLMService must not crash the process on API failures.
   */
  function _handleError(err, roomId, trigger) {
    const meta = { roomId, userId: trigger?.userId, errName: err.name, errMessage: err.message };

    if (err instanceof GroqTimeoutError) {
      log.warn(meta, 'LLM request timed out');
    } else if (err instanceof GroqNetworkError) {
      log.warn(meta, 'LLM request failed — network error');
    } else if (err instanceof GroqAPIError) {
      // status is attached by GroqAdapter
      log.error({ ...meta, status: err.status }, 'LLM request failed — API error');
    } else {
      log.error({ ...meta, err }, 'LLM request failed — unexpected error');
    }

    bus.emit(Events.REPLY_FAILED, {
      roomId,
      trigger,
      errName:    err.name,
      errMessage: err.message,
    });
  }

  bus.on(Events.CONTEXT_READY, onContextReady);
  log.debug('LLMService registered');

  return {
    /**
     * Removes the CONTEXT_READY bus listener.
     * In-flight requests will still complete — this only stops new ones.
     */
    destroy() {
      bus.off(Events.CONTEXT_READY, onContextReady);
      log.debug('LLMService destroyed');
    },

    /**
     * Returns count of in-flight requests for a given room.
     * Primarily for testing and health checks.
     *
     * @param   {string} roomId
     * @returns {number}
     */
    getInFlightCount: (roomId) => getInFlight(roomId),
  };
}