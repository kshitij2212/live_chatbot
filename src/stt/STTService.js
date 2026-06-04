/**
 * STTService
 *
 * Coordinates the full STT pipeline:
 *   UTTERANCE_READY → WhisperAdapter → TranscriptNormalizer → TRANSCRIPT_READY
 *                                                            ↘ STT_FAILED
 *
 * This is the only file in stt/ that touches the EventBus.
 * WhisperAdapter and TranscriptNormalizer are plain functions — no bus wiring.
 */

import bus, { Events }           from '../core/EventBus.js';
import { createWhisperAdapter }  from './WhisperAdapter.js';
import { normalizeTranscript }   from './TranscriptNormalizer.js';
import logger                    from '../utils/logger.js';

const log = logger.child({ module: 'STTService' });

/**
 * @param {object} config
 * @param {string} config.groqApiKey
 */
export function createSTTService(config) {
  const { groqApiKey } = config;

  const whisper = createWhisperAdapter({ apiKey: groqApiKey });

  async function onUtteranceReady({ roomId, speakerId, samples, sampleRate, durationMs }) {
    const ts = Date.now();
    
    log.info({ roomId, speakerId, durationMs: Math.round(durationMs) }, 'STT: onUtteranceReady fired');

    log.debug(
      { roomId, speakerId, durationMs: Math.round(durationMs) },
      'STT: received utterance'
    );

    // 1. Transcribe via Groq Whisper
    let raw;
    try {
      raw = await whisper.transcribe(samples, sampleRate);
    } catch (err) {
      log.error({ roomId, speakerId, err }, 'STT: Groq API error');
      bus.emit(Events.STT_FAILED, {
        roomId,
        speakerId,
        reason: err?.message ?? 'groq_api_error',
        ts,
      });
      return;
    }

    // 2. Normalize
    const text = normalizeTranscript(raw);

    // 3. Validate
    if (!text) {
      log.debug({ roomId, speakerId, raw }, 'STT: transcript empty after normalization');
      bus.emit(Events.STT_FAILED, {
        roomId,
        speakerId,
        reason: 'empty_transcript',
        ts,
      });
      return;
    }

    // 4. Emit
    log.info({ roomId, speakerId, text }, '📝 Transcript ready');
    bus.emit(Events.TRANSCRIPT_READY, {
      roomId,
      speakerId,
      text,
      ts,
    });
  }

  function init() {
    bus.on(Events.UTTERANCE_READY, onUtteranceReady);
    log.info('STTService initialised');
    log.info({ listenerCount: bus.listenerCount(Events.UTTERANCE_READY) }, 'UTTERANCE_READY listeners');
  }

  function destroy() {
    bus.off(Events.UTTERANCE_READY, onUtteranceReady);
    log.debug('STTService destroyed');
  }

  return { init, destroy };
}