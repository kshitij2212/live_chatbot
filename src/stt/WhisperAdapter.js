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

import { encodeWAV }    from '../audio/AudioUtils.js';
import logger           from '../utils/logger.js';

const log = logger.child({ module: 'WhisperAdapter' });

// Groq requires at least 0.01s of audio. At 16kHz that is 160 samples.
const MIN_SAMPLES_16KHZ = 160;

const MODEL = 'whisper-large-v3-turbo';
const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * @param {object} config
 * @param {string} config.apiKey
 */
export function createWhisperAdapter(config) {
  const { apiKey } = config;

  if (!apiKey?.trim()) {
    throw new Error('WhisperAdapter: missing required config field "apiKey"');
  }

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
    
    // Create a standard Web Blob to avoid Node.js specific node-fetch buffer leaks
    // in older undici versions when passed through FormData.
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    
    const formData = new FormData();
    formData.append('file', blob, 'utterance.wav');
    formData.append('model', MODEL);
    formData.append('response_format', 'json');
    formData.append('language', 'hi');
    formData.append('prompt', 'नमस्ते, आप कैसे हैं? मैं बिल्कुल ठीक हूँ। आज आपका क्या प्लान है? हाँ, अच्छा है। कृपया मुझे बताइये। बहुत बढ़िया!');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    let response;
    try {
      response = await fetch(GROQ_AUDIO_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Groq Whisper request timed out after 15s`);
      }
      throw new Error(`Groq Whisper network error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch { /* ignore */ }
      throw new Error(`Groq Whisper API error ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`Failed to parse Groq Whisper response as JSON: ${err.message}`);
    }

    return json.text ?? '';
  }

  return { transcribe };
}