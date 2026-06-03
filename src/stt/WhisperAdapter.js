/**
 * WhisperAdapter
 *
 * Single responsibility: send a WAV buffer to Groq Whisper, return raw text.
 *
 * No cleaning. No validation. No EventBus. No logging of transcript content.
 * Just audio in, raw string out.
 *
 * Throws on API failure — STTService handles the error.
 */

import Groq, { toFile } from 'groq-sdk';
import { encodeWAV }    from '../audio/AudioUtils.js';
import logger           from '../utils/logger.js';

const log = logger.child({ module: 'WhisperAdapter' });

// Groq requires at least 0.01s of audio. At 16kHz that is 160 samples.
const MIN_SAMPLES_16KHZ = 160;

const MODEL = 'whisper-large-v3-turbo';

/**
 * @param {object} config
 * @param {string} config.apiKey
 */
export function createWhisperAdapter(config) {
  const { apiKey } = config;

  if (!apiKey?.trim()) {
    throw new Error('WhisperAdapter: missing required config field "apiKey"');
  }

  const groq = new Groq({ apiKey });

  /**
   * Transcribe a PCM utterance.
   *
   * @param {Int16Array} samples
   * @param {number}     sampleRate
   * @returns {Promise<string>} raw transcript — may be empty, not trimmed
   */
  async function transcribe(samples, sampleRate) {
    // Guard: reject utterances that are too short for the Groq API.
    // Groq requires at least 0.01 seconds of audio (160 samples @ 16kHz).
    const minSamples = Math.round(MIN_SAMPLES_16KHZ * (sampleRate / 16000));
    if (!samples || samples.length < minSamples) {
      log.warn(
        { sampleCount: samples?.length ?? 0, minSamples, sampleRate },
        'Utterance too short — skipping Groq transcription'
      );
      return '';
    }

    const wavBuffer = encodeWAV(samples, sampleRate);
    const file      = await toFile(wavBuffer, 'utterance.wav', { type: 'audio/wav' });

    const response = await groq.audio.transcriptions.create({
      file,
      model:           MODEL,
      response_format: 'json',
    });

    return response.text ?? '';
  }

  return { transcribe };
}