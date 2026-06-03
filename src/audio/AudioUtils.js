import logger from '../utils/logger.js';
/**
 * AudioUtils
 *
 * Pure-function PCM helpers used throughout the audio pipeline.
 *
 * Context: LiveKit delivers audio at whatever sample rate the browser publishes
 * (typically 48kHz stereo). We request 16kHz mono directly from the AudioStream
 * constructor in RoomEventEmitter, so the SDK resamples before we ever see the
 * data. These helpers exist for cases where you want to override that default
 * (e.g. capture at full 48kHz for quality reasons) or for testing with WAV files.
 *
 * All functions are stateless and return new typed arrays — they never mutate input.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const INT16_MAX  =  32767;
export const INT16_MIN  = -32768;

// ─── Conversion helpers ───────────────────────────────────────────────────────

/**
 * Stereo Int16Array → Mono Int16Array
 * Averages the left and right channels sample-by-sample.
 *
 * @param {Int16Array} stereo - Interleaved L/R samples: [L0, R0, L1, R1, ...]
 * @returns {Int16Array} Mono samples
 */
export function stereoToMono(stereo) {
  const mono = new Int16Array(stereo.length >>> 1);
  for (let i = 0, j = 0; i < stereo.length; i += 2, j++) {
    // Math.round gives a properly rounded average (e.g. 1+2 → 1.5 → 2).
    // The >> 1 shift would truncate (1+2 → 3 >> 1 = 1), losing 0.5 LSB accuracy.
    mono[j] = Math.round((stereo[i] + stereo[i + 1]) / 2);
  }
  return mono;
}

/**
 * Downmix an N-channel interleaved Int16Array to mono.
 * Each output sample is the average of all channels at that frame position.
 * Works for any channel count: stereo (2), quad (4), 5.1 (6), etc.
 *
 * @param {Int16Array} interleaved - Interleaved samples [ch0, ch1, ..., chN-1, ch0, ...]
 * @param {number}     channels    - Number of channels (must be >= 1)
 * @returns {Int16Array} Mono samples
 */
export function downmixToMono(interleaved, channels) {
  if (channels === 1) return interleaved;
  const mono = new Int16Array(Math.floor(interleaved.length / channels));
  for (let i = 0, j = 0; i < interleaved.length; i += channels, j++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += interleaved[i + c];
    }
    // Divide once at the end — avoids channels floating-point multiplications
    // per frame and keeps the hot path as integer additions.
    mono[j] = Math.round(sum / channels);
  }
  return mono;
}

/**
 * Float32Array PCM → Int16Array PCM
 * Float32 range is [-1.0, 1.0]; Int16 range is [-32768, 32767].
 *
 * Note: Use Int16Array.buffer.subarray (not .slice) when copying because
 * .slice behaviour on typed array buffers is unstable in some Node versions.
 *
 * @param {Float32Array} float32
 * @returns {Int16Array}
 */
export function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    // Asymmetric scaling: negative samples scale by 32768, positive by 32767.
    // This gives -1.0 → -32768 and +1.0 → 32767 with no post-clamp needed,
    // and avoids the rounding edge case where Math.round(1.0 * 32768) = 32768
    // would exceed INT16_MAX before clamping.
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? (clamped * 32768) : (clamped * 32767);
  }
  return int16;
}

/**
 * Int16Array PCM → Float32Array PCM
 * Inverse of float32ToInt16. Useful for feeding audio to WASM modules that
 * expect float input.
 *
 * @param {Int16Array} int16
 * @returns {Float32Array}
 */
export function int16ToFloat32(int16) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    // Divide by 32768 (not INT16_MAX / 32767) so -32768 maps to exactly -1.0.
    // Dividing by 32767 would map -32768 to -1.000030..., exceeding the valid
    // [-1, 1] PCM range and potentially distorting downstream DSP.
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

/**
 * Resample Int16Array from one sample rate to another.
 *
 * Uses linear interpolation between adjacent samples for non-integer source
 * positions, and nearest-neighbour for exact integer positions.
 * This is sufficient for the 48kHz → 16kHz downsampling case.
 *
 * Note: no low-pass (anti-aliasing) filter is applied before downsampling.
 * This is acceptable for Whisper/STT but production speech pipelines may
 * prefer SoX, ffmpeg, or libsamplerate for higher-quality resampling.
 *
 * @param {Int16Array} samples     - Input PCM
 * @param {number}     fromRate    - Input sample rate (e.g. 48000)
 * @param {number}     toRate      - Output sample rate (e.g. 16000)
 * @returns {Int16Array}
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;

  const ratio      = fromRate / toRate;
  const outLength  = Math.round(samples.length / ratio);
  const out        = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac   = srcPos - srcIdx;

    if (frac === 0 || srcIdx + 1 >= samples.length) {
      // Nearest neighbour
      out[i] = samples[Math.min(srcIdx, samples.length - 1)];
    } else {
      // Linear interpolation between adjacent samples
      const a = samples[srcIdx];
      const b = samples[srcIdx + 1];
      out[i]  = Math.round(a + frac * (b - a));
    }
  }

  return out;
}

/**
 * Convenience: convert a raw LiveKit audio frame to 16kHz mono Int16.
 * Use this when NOT requesting 16kHz from AudioStream directly.
 *
 * @param {object} frame
 * @param {Int16Array} frame.data
 * @param {number}     frame.sampleRate
 * @param {number}     frame.channels
 * @returns {Int16Array} 16kHz mono PCM
 */
export function normaliseFrame(frame) {
  let data = frame.data;

  // Step 1: downmix to mono if multi-channel (stereo, quad, 5.1, etc.)
  if (frame.channels > 1) {
    data = downmixToMono(data, frame.channels);
  }

  // Step 2: resample to 16kHz if needed
  if (frame.sampleRate !== 16000) {
    data = resample(data, frame.sampleRate, 16000);
  }

  return data;
}

// ─── WAV encoding ─────────────────────────────────────────────────────────────

/**
 * Encode Int16Array PCM into a valid WAV file Buffer.
 * Used by WhisperAdapter when writing a temp file for the Whisper API.
 *
 * @param {Int16Array} samples    - 16kHz mono Int16 PCM
 * @param {number}     sampleRate - Should be 16000
 * @returns {Buffer}
 */
export function encodeWAV(samples, sampleRate = 16000) {
  if (!samples || samples.length === 0) {
    const log = logger.child({ module: 'AudioUtils' });
    log.warn('encodeWAV called with empty or undefined samples — returning empty wav buffer');
    // Return minimal valid WAV header with zero data size
    const emptyBuffer = Buffer.alloc(44);
    emptyBuffer.write('RIFF', 0);
    emptyBuffer.writeUInt32LE(36, 4); // 36 + dataSize(0)
    emptyBuffer.write('WAVE', 8);
    emptyBuffer.write('fmt ', 12);
    emptyBuffer.writeUInt32LE(16, 16);
    emptyBuffer.writeUInt16LE(1, 20);
    emptyBuffer.writeUInt16LE(1, 22); // numChannels
    emptyBuffer.writeUInt32LE(sampleRate, 24);
    const byteRate = sampleRate * 1 * (16 / 8);
    emptyBuffer.writeUInt32LE(byteRate, 28);
    emptyBuffer.writeUInt16LE(2, 32); // blockAlign
    emptyBuffer.writeUInt16LE(16, 34);
    emptyBuffer.write('data', 36);
    emptyBuffer.writeUInt32LE(0, 40);
    return emptyBuffer;
  }

  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign    = numChannels * (bitsPerSample / 8);
  const dataSize      = samples.length * (bitsPerSample / 8);
  const buffer        = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16,            16);  // sub-chunk size
  buffer.writeUInt16LE(1,             20);  // PCM = 1
  buffer.writeUInt16LE(numChannels,   22);
  buffer.writeUInt32LE(sampleRate,    24);
  buffer.writeUInt32LE(byteRate,      28);
  buffer.writeUInt16LE(blockAlign,    32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM samples (little-endian)
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

/**
 * Concatenate multiple Int16Arrays into one.
 * Used by SpeechSegmenter to merge accumulated frames into a single buffer.
 *
 * @param {Int16Array[]} arrays
 * @returns {Int16Array}
 */
export function concatInt16Arrays(arrays) {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result      = new Int16Array(totalLength);
  let   offset      = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Estimate the duration in milliseconds of a PCM buffer.
 *
 * @param {Int16Array} samples
 * @param {number}     sampleRate
 * @returns {number} duration in ms
 */
export function durationMs(samples, sampleRate = 16000) {
  return (samples.length / sampleRate) * 1000;
}