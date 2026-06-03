import bus, { Events }        from '../core/EventBus.js';
import logger                  from '../utils/logger.js';

const log = logger.child({ module: 'ContextBuilder' });

// ─── Overview ─────────────────────────────────────────────────────────────────
//
// ContextBuilder listens for BEHAVIOR_APPROVED (from BotRunner)
// and assembles a rich context payload by consulting:
//
//   • ContextMemoryService  — per-room rolling history from Redis
//   • PersonaMemoryService  — static bot persona config
//
// It then passes the assembled payload directly to PromptBuilder and emits
// CONTEXT_READY for any other listeners that need the full context.
//
// ContextBuilder is intentionally stateless — all state lives in the
// memory services it calls. This makes it safe to restart without data loss.

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {import('../memory/ContextMemoryService.js').ContextMemoryService} deps.contextMemory
 * @param {import('../memory/PersonaMemoryService.js').PersonaMemoryService} deps.personaMemory
 * @param {import('./PromptBuilder.js').PromptBuilder}                       deps.promptBuilder
 * @param {string}                                                           deps.botId
 */
export function createContextBuilder({ contextMemory, personaMemory, promptBuilder, botId }) {
  if (!contextMemory) throw new Error('ContextBuilder: contextMemory is required');
  if (!personaMemory) throw new Error('ContextBuilder: personaMemory is required');
  if (!promptBuilder) throw new Error('ContextBuilder: promptBuilder is required');
  if (!botId)         throw new Error('ContextBuilder: botId is required');

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Merges separate context lists into a unified, chronologically sorted array.
   * Oldest first (newest last).
   * 
   * @param {object} rawContext
   * @param {Array} rawContext.transcripts
   * @param {Array} rawContext.comments
   * @param {Array} rawContext.botReplies
   * @returns {Array<object>} Unified history array
   */
  function interleaveHistory({ transcripts = [], comments = [], botReplies = [] }) {
    const merged = [];

    for (const t of transcripts) {
      if (t) merged.push({ role: 'user', userId: t.speakerId, username: t.speakerId, text: t.text, ts: t.ts });
    }

    for (const c of comments) {
      if (c) merged.push({ role: 'user', userId: c.userId, username: c.username, text: c.text, ts: c.ts });
    }

    for (const b of botReplies) {
      if (b) merged.push({ role: 'bot', text: b.text, ts: b.ts });
    }

    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }

  // ── Core handler ─────────────────────────────────────────────────────────────

  /**
   * Handles BEHAVIOR_APPROVED.
   *
   * Trigger shape:
   * {
   *   roomId:      string,
   *   trigger:     string (the text),
   *   triggerType: 'comment' | 'transcript',
   *   delayMs:     number,
   *   username?:   string,
   *   userId?:     string,
   * }
   */
  async function onTrigger(triggerEvent) {
    const { roomId } = triggerEvent;

    // ── Normalise trigger to a unified shape ────────────────────────────────
    const normalisedTrigger = normaliseTrigger(triggerEvent);
    if (!normalisedTrigger) return;  // logged inside normalise

    log.debug(
      { roomId, userId: normalisedTrigger.userId, source: normalisedTrigger.source },
      'Building context'
    );

    // ── Fetch context and persona in parallel ────────────────────────────────
    let rawContext, persona;
    try {
      [rawContext, persona] = await Promise.all([
        contextMemory.getAll(roomId),
        personaMemory.getPersona(botId),
      ]);
    } catch (err) {
      log.error({ roomId, err }, 'Failed to fetch context or persona — aborting');
      bus.emit(Events.CONTEXT_BUILD_FAILED, { roomId, trigger: normalisedTrigger, err: String(err) });
      return;
    }

    const history = interleaveHistory(rawContext);

    // ── Assemble context payload ─────────────────────────────────────────────
    //
    // This is the single source of truth passed to PromptBuilder.
    // All fields are explicit — no magic, no hidden state.
    const contextPayload = {
      roomId,
      trigger:    normalisedTrigger,   // the comment / transcript that triggered this
      history,                          // ContextEntry[]  from Redis (newest-last)
      persona,                          // PersonaConfig   from PersonaMemoryService
      builtAt:    new Date().toISOString(),
    };

    // ── Hand off to PromptBuilder ────────────────────────────────────────────
    let promptMessages;
    try {
      promptMessages = promptBuilder.build(contextPayload);
    } catch (err) {
      log.error({ roomId, err }, 'PromptBuilder threw — aborting');
      bus.emit(Events.CONTEXT_BUILD_FAILED, { roomId, trigger: normalisedTrigger, err: String(err) });
      return;
    }

    // ── Emit CONTEXT_READY ───────────────────────────────────────────────────
    //
    // LLMService listens for this event.
    // The full contextPayload is included alongside promptMessages so
    // post-LLM handlers (e.g. ContextMemoryService.append) have everything
    // they need without re-fetching.
    bus.emit(Events.CONTEXT_READY, {
      roomId,
      trigger:        normalisedTrigger,
      promptMessages,                    // OpenAI-compatible messages array
      contextPayload,                    // raw context — for memory append after reply
    });

    log.debug(
      { roomId, messageCount: promptMessages.length },
      'Context ready — emitted CONTEXT_READY'
    );
  }

  // ── Trigger normalisation ────────────────────────────────────────────────────

  /**
   * Converts any supported trigger event into a unified shape:
   * {
   *   userId:   string,
   *   username: string,
   *   text:     string,
   *   ts:       string,
   *   source:   string,
   * }
   *
   * Returns null (and logs) if the trigger cannot be normalised.
   *
   * @param {object} trigger
   * @returns {{ userId, username, text, ts, source } | null}
   */
  function normaliseTrigger(event) {
    const { trigger, triggerType, username, userId, delayMs } = event;
    if (!trigger?.trim()) {
      log.warn({ event }, 'Trigger has empty text — dropping');
      return null;
    }
    
    return {
      userId:   userId ?? username ?? 'unknown',
      username: username ?? userId ?? 'unknown',
      text:     trigger.trim(),
      ts:       new Date().toISOString(),
      source:   triggerType,
      delayMs:  delayMs || 0,
    };
  }

  // ── Event registration ───────────────────────────────────────────────────────

  bus.on(Events.BEHAVIOR_APPROVED, onTrigger);

  log.debug('ContextBuilder registered');

  // ── Public API ───────────────────────────────────────────────────────────────

  return {
    /**
     * Removes all bus listeners registered by this instance.
     */
    destroy() {
      bus.off(Events.BEHAVIOR_APPROVED, onTrigger);
      log.debug('ContextBuilder destroyed');
    },
  };
}