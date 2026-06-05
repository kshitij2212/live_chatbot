import { encodeWAV }    from '../audio/AudioUtils.js';
import logger           from '../utils/logger.js';
import { writeFileSync } from 'fs';

const log = logger.child({ module: 'WhisperAdapter' });

const MIN_SAMPLES_16KHZ = 160;

const MODEL = 'whisper-large-v3-turbo';
const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export function createWhisperAdapter(config) {
  const { apiKey } = config;

  if (!apiKey?.trim()) {
    throw new Error('WhisperAdapter: missing required config field "apiKey"');
  }

  async function transcribe(samples, sampleRate) {
    
    const minSamples = Math.round(MIN_SAMPLES_16KHZ * (sampleRate / 16000));
    if (!samples || samples.length < minSamples) {
      log.warn(
        { sampleCount: samples?.length ?? 0, minSamples, sampleRate },
        'Utterance too short — skipping Groq transcription'
      );
      return '';
    }

    const wavBuffer = encodeWAV(samples, sampleRate);
    writeFileSync(`/tmp/utterance_${Date.now()}.wav`, wavBuffer);
    log.info('WAV saved to /tmp');
    
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    
    const formData = new FormData();
    formData.append('file', blob, 'utterance.wav');
    formData.append('model', MODEL);
    formData.append('response_format', 'json');
    formData.append('language', 'hi');
    formData.append('temperature', '0');

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
      try { errorBody = await response.text(); } catch {  }
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
