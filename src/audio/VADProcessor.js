/**
 * VADProcessor
 *
 * Pure-JavaScript Voice Activity Detection.
 *
 * Why pure JS, not Silero?
 * Silero VAD (via @ricky0123/vad-node) requires onnxruntime-node, which
 * downloads native binaries from NuGet during `npm install`. That download
 * fails in restricted network environments (CI, sandboxed dev boxes, Docker
 * without outbound internet). This pure-JS implementation works everywhere
 * with zero native dependencies and is accurate enough for prototype use.
 *
 * When to upgrade to Silero:
 * Once the prototype is proven and you're on a machine with full internet
 * access during npm install, swap this file for a SileroVADProcessor that
 * exposes the same interface (subscribe to SPEECH_CHUNK, emit VAD_SPEECH_START
 * / VAD_SPEECH_END via EventBus). BotRunner wires them identically.
 *
 * Algorithm:
 *  1. RMS energy per 30ms frame  — primary gate (is there *any* signal?)
 *  2. Zero Crossing Rate (ZCR)   — secondary gate (is it speech, not broadband noise?)
 *  3. Adaptive calibration       — measure ambient noise floor for first ~1s
 *                                   then set threshold = max(MIN_THRESHOLD, floor × MULTIPLIER)
 *  4. Confirmation counters      — require N consecutive speech/silence frames
 *                                   to avoid triggering on transient pops
 *  5. State machine              — CALIBRATING → SILENCE ↔ SPEAKING
 *
 * Emits (via EventBus):
 *  Events.VAD_SPEECH_START  — { roomId, speakerId, ts }
 *  Events.VAD_SPEECH_END    — { roomId, speakerId, ts }
 *
 * Consumes:
 *  Events.SPEECH_CHUNK (from AudioBuffer) — { roomId, speakerId, chunk: Int16Array, sampleRate, ts }
 */

import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'VADProcessor' });

const MIN_ENERGY_THRESHOLD   = 100;   // absolute floor — lower this so normal speech passes
const ADAPTIVE_MULTIPLIER    = 4;     // threshold = ambientRMS × this
const CALIBRATION_FRAMES     = 33;    // ~1s of ambient measurement before VAD activates

// Speech has moderate ZCR (~0.05–0.25).
// Very high ZCR (>0.4) is usually white noise, typing, or 'f', 's', 'sh' alone.
const MAX_ZCR_FOR_SPEECH     = 0.40;

// Confirmation counters (1 frame = 30ms)
const SPEECH_CONFIRM_FRAMES  = 6;    // 6 × 30ms = ~180ms  before declaring speech start
const SILENCE_CONFIRM_FRAMES = 40;   // 40 × 30ms = ~1200ms (1.2s) wait before cutting off the sentence

/**
 * Root Mean Square energy of a PCM frame.
 * Silence typically < 100, speech typically > 800.
 * @param {Int16Array} frame
 * @returns {number}
 */
function computeRMS(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Zero Crossing Rate — fraction of samples that change sign.
 * Low (~0.05–0.25) = voiced speech. High (>0.4) = broadband noise / hiss.
 * @param {Int16Array} frame
 * @returns {number} value in [0, 1]
 */
function computeZCR(frame) {
  let crossings = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) crossings++;
  }
  return crossings / frame.length;
}

function createSpeakerState(roomId, speakerId) {
  return {
    roomId,
    speakerId,
    calibrationFrames: [],
    isCalibrated:      false,
    energyThreshold:   MIN_ENERGY_THRESHOLD,
    state:             'CALIBRATING',   // 'CALIBRATING' | 'SILENCE' | 'SPEAKING'
    speechConfirm:     0,
    silenceConfirm:    0,
  };
}

export function createVADProcessor() {

  // speakerKey → speaker state object
  const speakers = new Map();

  function getSpeakerKey(roomId, speakerId) {
    return `${roomId}:${speakerId}`;
  }

  /**
   *  SILENCE ──(SPEECH_CONFIRM_FRAMES consecutive speech frames)──► SPEAKING
   *  SPEAKING ──(SILENCE_CONFIRM_FRAMES consecutive silence frames)──► SILENCE
   */
  function updateStateMachine(state, roomId, speakerId, isSpeechFrame, ts) {
    if (state.state === 'SILENCE') {
      if (isSpeechFrame) {
        state.speechConfirm++;
        state.silenceConfirm = 0;

        if (state.speechConfirm >= SPEECH_CONFIRM_FRAMES) {
          state.state         = 'SPEAKING';
          state.speechConfirm = 0;
          log.debug({ roomId }, '🎙  VAD: speech start');
          bus.emit(Events.VAD_SPEECH_START, { roomId, speakerId, ts });
        }
      } else {
        state.speechConfirm = 0;
      }

    } else if (state.state === 'SPEAKING') {
      if (!isSpeechFrame) {
        state.silenceConfirm++;
        state.speechConfirm = 0;

        if (state.silenceConfirm >= SILENCE_CONFIRM_FRAMES) {
          state.state          = 'SILENCE';
          state.silenceConfirm = 0;
          log.debug({ roomId }, '🔇  VAD: speech end');
          bus.emit(Events.VAD_SPEECH_END, { roomId, speakerId, ts });
        }
      } else {
        state.silenceConfirm = 0;
      }
    }
  }

  function onChunk({ roomId, speakerId, chunk, ts }) {
    if (!chunk || chunk.length === 0) return;

    const key = getSpeakerKey(roomId, speakerId);

    if (!speakers.has(key)) {
      speakers.set(key, createSpeakerState(roomId, speakerId));
      log.debug({ roomId, speakerId }, 'VAD state created for speaker');
    }

    const state = speakers.get(key);

    const rms = computeRMS(chunk);
    const zcr = computeZCR(chunk);

    if (!state.isCalibrated) {
      state.calibrationFrames.push(rms);

      if (state.calibrationFrames.length >= CALIBRATION_FRAMES) {
        const sum    = state.calibrationFrames.reduce((a, b) => a + b, 0);
        const avgRMS = sum / state.calibrationFrames.length;

        state.energyThreshold   = Math.max(MIN_ENERGY_THRESHOLD, Math.round(avgRMS * ADAPTIVE_MULTIPLIER));
        state.isCalibrated      = true;
        state.state             = 'SILENCE';
        state.calibrationFrames = [];   // free memory

        log.info(
          { roomId, ambientRMS: Math.round(avgRMS), threshold: state.energyThreshold },
          'VAD calibrated'
        );
      }
      // Don't run the state machine during calibration — no baseline yet
      return;
    }

    const isSpeechFrame = rms > state.energyThreshold && zcr < MAX_ZCR_FOR_SPEECH;

    log.trace(
      {
        roomId,
        rms:       Math.round(rms),
        zcr:       zcr.toFixed(3),
        threshold: state.energyThreshold,
        isSpeechFrame,
        state:     state.state,
      },
      'VAD frame'
    );

    updateStateMachine(state, roomId, speakerId, isSpeechFrame, ts);
  }

  function onTrackRemoved({ roomId, participantId }) {
    const key = getSpeakerKey(roomId, participantId);
    speakers.delete(key);
    log.debug({ roomId, speakerId: participantId }, 'VAD state cleared on track removed');
  }

  function onRoomDisconnected({ roomId }) {
    for (const [key, state] of speakers) {
      if (state.roomId === roomId) {
        speakers.delete(key);
        log.debug({ roomId, speakerId: state.speakerId }, 'VAD state cleared on room disconnect');
      }
    }
  }

  function init() {
    bus.on(Events.SPEECH_CHUNK,         onChunk);
    bus.on(Events.ROOM_DISCONNECTED,    onRoomDisconnected);
    bus.on(Events.AUDIO_TRACK_REMOVED,  onTrackRemoved);
    log.info('VADProcessor initialised (pure-JS energy+ZCR mode)');
  }

  function destroy() {
    bus.off(Events.SPEECH_CHUNK,         onChunk);
    bus.off(Events.ROOM_DISCONNECTED,    onRoomDisconnected);
    bus.off(Events.AUDIO_TRACK_REMOVED,  onTrackRemoved);
    speakers.clear();
    log.debug('VADProcessor destroyed');
  }

  /**
   * Snapshot of per-room VAD state. Useful for debug endpoints.
   * @returns {object[]}
   */
  function getStats() {
    const result = [];
    for (const [key, state] of speakers) {
      result.push({
        roomId:          state.roomId,
        speakerId:       state.speakerId,
        state:           state.state,
        isCalibrated:    state.isCalibrated,
        energyThreshold: state.energyThreshold,
        speechConfirm:   state.speechConfirm,
        silenceConfirm:  state.silenceConfirm,
      });
    }
    return result;
  }

  return { init, destroy, getStats };
}