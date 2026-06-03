/**
 * SpeechSegmenter
 *
 * The bridge between VADProcessor and the STT service.
 *
 * VADProcessor emits two signals:
 *   Events.VAD_SPEECH_START — the speaker has started speaking
 *   Events.VAD_SPEECH_END   — the speaker has stopped speaking
 *
 * SpeechSegmenter listens to BOTH of those signals AND the raw SPEECH_CHUNK
 * events from AudioBuffer. While the VAD state is SPEAKING, it accumulates
 * every 30ms chunk into a growing buffer. When VAD_SPEECH_END fires, it
 * collects a short silence pad for natural boundaries, then emits a single
 * Events.UTTERANCE_READY event with the full utterance buffer — ready for
 * the STT service to consume.
 *
 * Edge cases handled:
 *  - Max utterance length: hard-flush at MAX_UTTERANCE_MS to prevent huge STT
 *    payloads when someone talks for a very long time
 *  - Minimum utterance length: drop utterances shorter than MIN_UTTERANCE_MS
 *    (avoids sending a single cough or pop to STT)
 *  - Room disconnect: discard in-progress utterance cleanly
 *  - Back-to-back speech: flush previous utterance before starting new one
 *
 * Emits (via EventBus):
 *  Events.UTTERANCE_READY — { roomId, speakerId, samples: Int16Array, sampleRate, durationMs, startTs, endTs }
 *
 * Consumes (via EventBus):
 *  Events.SPEECH_CHUNK      — raw 30ms PCM frames from AudioBuffer
 *  Events.VAD_SPEECH_START  — VAD declared speech started
 *  Events.VAD_SPEECH_END    — VAD declared speech ended
 *  Events.ROOM_DISCONNECTED — clean up state for the room
 */

import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';
import { concatInt16Arrays } from './AudioUtils.js';

const log = logger.child({ module: 'SpeechSegmenter' });

// ─── Config ───────────────────────────────────────────────────────────────────

const SAMPLE_RATE  = 16_000;
const FRAME_SIZE_MS = 30;

// Hard-flush an in-progress utterance if it exceeds this length.
// Prevents sending a 30-second monologue to STT in one shot.
// At 15s × 16kHz × 2 bytes = ~480KB — safe for all STT APIs.
const MAX_UTTERANCE_MS     = 15_000;
const MAX_UTTERANCE_FRAMES = MAX_UTTERANCE_MS / FRAME_SIZE_MS;   // 500 frames

// Discard utterances shorter than this — likely noise, not speech
const MIN_UTTERANCE_MS     = 300; // lowered from 300 to accept shorter utterances
const MIN_UTTERANCE_FRAMES = MIN_UTTERANCE_MS / FRAME_SIZE_MS;   // adjusted accordingly


// Frames of silence to keep at the end of the utterance.
// A natural trailing silence helps STT identify the last word correctly.
const SILENCE_PAD_FRAMES = 5;   // 5 × 30ms = 150ms

// ─── Per-speaker state ────────────────────────────────────────────────────────

function createSpeakerState(roomId, speakerId) {
  return {
    roomId,
    speakerId,
    isCapturing:    false,
    frames:         [],      // Int16Array[] — accumulated 30ms chunks
    frameCount:     0,
    silencePadding: 0,
    startTs:        null,
  };
}

// ─── Per-room state ───────────────────────────────────────────────────────────

function createRoomState() {
  return {
    isCapturing:    false,
    frames:         [],      // Int16Array[] — accumulated 30ms chunks
    frameCount:     0,
    silencePadding: 0,
    startTs:        null,
    speakerId:      null,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSpeechSegmenter() {

  const speakers = new Map();

  function getSpeakerKey(roomId, speakerId) {
    return `${roomId}:${speakerId}`;
  }

  // ─── Flush ───────────────────────────────────────────────────────────────────
  function flush(roomId, speakerId, ts) {

    log.debug({ roomId, speakerId, ts }, '🗣️ flush() entered');
  
    const key = getSpeakerKey(roomId, speakerId);
    const state = speakers.get(key);
    if (!state || state.frames.length === 0) return;

    // Snapshot what we need, then reset state before emitting.
    // Resetting first makes the function re-entrance safe: if a downstream
    // listener somehow triggers another flush for the same room synchronously,
    // the state is already clean and the second flush is a no-op.
    const frames    = state.frames;
    const startTs   = state.startTs;

    state.frames         = [];
    state.frameCount     = 0;
    state.silencePadding = 0;
    state.isCapturing    = false;
    state.startTs        = null;

    if (frames.length < MIN_UTTERANCE_FRAMES) {
      log.warn(
        { roomId, frames: frames.length, minFrames: MIN_UTTERANCE_FRAMES },
        'Utterance too short — discarded'
      );
      return;
    }

    const samples   = concatInt16Arrays(frames);
    const durMs     = (samples.length / SAMPLE_RATE) * 1000;

    log.info(
      { roomId, speakerId, durationMs: Math.round(durMs), samples: samples.length },
      `📢 Utterance ready (${(durMs / 1000).toFixed(1)}s)`
    );

    bus.emit(Events.UTTERANCE_READY, {
      roomId,
      speakerId,
      samples,
      sampleRate: SAMPLE_RATE,
      durationMs: durMs,
      startTs,
      endTs:      ts,
    });
    log.debug({ roomId, speakerId }, '🟢 UTTERANCE_READY emitted');
  }

  // ─── VAD signal handlers ──────────────────────────────────────────────────────

  function onSpeechStart({ roomId, speakerId, ts }) {
    const key = getSpeakerKey(roomId, speakerId);
    if (!speakers.has(key)) {
      speakers.set(key, createSpeakerState(roomId, speakerId));
    }
    const state = speakers.get(key);

    // If already capturing (back-to-back speech with very brief silence gap),
    // flush the previous utterance before starting fresh.
    if (state.isCapturing && state.frameCount > 0) {
      log.debug({ roomId, speakerId }, 'Speech start while already capturing — flushing previous utterance');
      flush(roomId, speakerId, ts);
    }

    state.isCapturing    = true;
    state.frames         = [];
    state.frameCount     = 0;
    state.silencePadding = 0;
    state.startTs        = ts;

    log.debug({ roomId, speakerId }, 'Started capturing utterance');
  }

  function onSpeechEnd({ roomId, speakerId, ts }) {
    const key = getSpeakerKey(roomId, speakerId);
    const state = speakers.get(key);
    if (!state || !state.isCapturing) return;

    // Mark VAD as ended — onChunk will collect SILENCE_PAD_FRAMES then flush.
    state.isCapturing    = false;
    state.silencePadding = 0;

    log.debug({ roomId, frameCount: state.frameCount }, 'Speech end — collecting silence padding');
  }

  // ─── Chunk accumulation ───────────────────────────────────────────────────────

  function onChunk({ roomId, speakerId, chunk, ts }) {
    const key = getSpeakerKey(roomId, speakerId);
    const state = speakers.get(key);
    if (!state) return;

    if (state.isCapturing) {
      state.frames.push(chunk);
      state.frameCount++;

      // Hard-flush if the utterance has grown too long
      if (state.frameCount >= MAX_UTTERANCE_FRAMES) {
        log.warn(
          { roomId, speakerId, frames: state.frameCount, maxMs: MAX_UTTERANCE_MS },
          'Max utterance length reached — force-flushing'
        );
        // flush() resets isCapturing to false, so we restore it immediately
        // to keep collecting — the speaker is still talking.
        const startTs = state.startTs;
        flush(roomId, speakerId, ts);
        state.isCapturing = true;
        state.startTs     = startTs;
      }

    } else if (state.frames.length > 0) {
      // Silence padding phase (after VAD_SPEECH_END)
      state.frames.push(chunk);
      state.silencePadding++;

      if (state.silencePadding >= SILENCE_PAD_FRAMES) {
        flush(roomId, speakerId, ts);
      }
    }
    // pure silence with no accumulated frames — nothing to do
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  function onTrackRemoved({ roomId, participantId }) {
    const key = getSpeakerKey(roomId, participantId);
    const state = speakers.get(key);
    if (!state) return;
    const frames = state.frameCount;
    speakers.delete(key);
    if (frames > 0) {
      log.debug({ roomId, speakerId: participantId, frames, reason: 'track removed' }, 'In-progress utterance discarded');
    }
  }

  function onRoomDisconnected({ roomId }) {
    for (const [key, state] of speakers) {
      if (state.roomId === roomId) {
        const frames = state.frameCount;
        speakers.delete(key);
        if (frames > 0) {
          log.debug({ roomId, speakerId: state.speakerId, frames, reason: 'room disconnected' }, 'In-progress utterance discarded');
        }
      }
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  function init() {
    bus.on(Events.SPEECH_CHUNK,         onChunk);
    bus.on(Events.VAD_SPEECH_START,     onSpeechStart);
    bus.on(Events.VAD_SPEECH_END,       onSpeechEnd);
    bus.on(Events.ROOM_DISCONNECTED,    onRoomDisconnected);
    bus.on(Events.AUDIO_TRACK_REMOVED,  onTrackRemoved);

    log.info(
      {
        maxUtteranceMs:   MAX_UTTERANCE_MS,
        minUtteranceMs:   MIN_UTTERANCE_MS,
        silencePadFrames: SILENCE_PAD_FRAMES,
      },
      'SpeechSegmenter initialised'
    );
  }

  function destroy() {
    bus.off(Events.SPEECH_CHUNK,         onChunk);
    bus.off(Events.VAD_SPEECH_START,     onSpeechStart);
    bus.off(Events.VAD_SPEECH_END,       onSpeechEnd);
    bus.off(Events.ROOM_DISCONNECTED,    onRoomDisconnected);
    bus.off(Events.AUDIO_TRACK_REMOVED,  onTrackRemoved);
    speakers.clear();
    log.debug('SpeechSegmenter destroyed');
  }

  function getStats() {
    const result = [];
    for (const [key, state] of speakers) {
      result.push({
        roomId:      state.roomId,
        speakerId:   state.speakerId,
        isCapturing: state.isCapturing,
        frameCount:  state.frameCount,
        durationMs:  Math.round(state.frameCount * FRAME_SIZE_MS),
        silencePad:  state.silencePadding,
      });
    }
    return result;
  }

  return { init, destroy, getStats };
}