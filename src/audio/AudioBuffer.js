console.log('🚀 AudioBuffer (ring‑buffer) version loaded');
/**
 * AudioBuffer
 *
 * Sits immediately after RoomEventEmitter in the audio pipeline.
 * LiveKit delivers audio in variable-size frames — whatever the codec and
 * browser decide to send, typically ~30ms chunks of 480 Int16 samples at 16kHz.
 * VAD processors (and eventually STT) need a consistent, fixed-size window.
 *
 * Responsibilities:
 *  - Subscribe to Events.AUDIO_FRAME on the EventBus
 *  - Accumulate incoming Int16 PCM samples into an internal ring buffer
 *  - Flush a complete CHUNK_SIZE_MS window of samples to VADProcessor
 *    as soon as enough samples have accumulated
 *  - Track per-room buffers so multiple rooms work independently
 *  - On AUDIO_TRACK_REMOVED, discard that room's buffer cleanly
 *
 * Memory design:
 *  - Uses a pre-allocated fixed-size ring buffer per speaker (no per-frame allocations)
 *  - The emitted chunk is a copy (slice) of the ring window — safe for async downstream
 *  - Only one allocation happens per chunk emitted (SAMPLES_PER_CHUNK * 2 bytes = 960 bytes)
 *    at a rate of ~33 chunks/second = ~32KB/s, well within V8 GC capacity
 *
 * Does NOT:
 *  - Do any speech detection (that's VADProcessor)
 *  - Modify sample values in any way (data passes through untouched)
 *  - Buffer more than MAX_BUFFER_MS of audio (overflow protection)
 */

import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'AudioBuffer' });

// ─── Config ───────────────────────────────────────────────────────────────────

// How many milliseconds of audio to accumulate before flushing to VAD.
// 30ms is the standard VAD frame window (WebRTC VAD spec).
const CHUNK_SIZE_MS = 30;

// Safety ceiling: if the ring buffer is full, the oldest samples are overwritten.
// Protects against unbounded growth if VAD processing falls behind.
const MAX_BUFFER_MS = 500;

// Fixed sample rate — RoomEventEmitter requests 16kHz from LiveKit SDK
const SAMPLE_RATE = 16_000;

// Pre-compute sample counts from ms values
const SAMPLES_PER_CHUNK  = Math.round((SAMPLE_RATE * CHUNK_SIZE_MS) / 1000);  // 480
const MAX_BUFFER_SAMPLES = Math.round((SAMPLE_RATE * MAX_BUFFER_MS) / 1000);  // 8000

// ─── Ring buffer per speaker ──────────────────────────────────────────────────

/**
 * A fixed-capacity circular buffer for Int16 PCM samples.
 * Pre-allocated once — zero heap allocations during steady-state write/read.
 */
function createRingBuffer(capacity) {
  const buf      = new Int16Array(capacity);  // allocated ONCE
  const chunkBuf = new Int16Array(SAMPLES_PER_CHUNK); // reusable scratch
  let writePos = 0;  // next write position
  let count    = 0;  // number of valid samples currently stored

  return {
    /** Write samples into the ring, overwriting oldest if full. */
    write(samples) {
      const len = samples.length;

      if (len >= capacity) {
        // Incoming frame is larger than the whole buffer — take only the tail
        buf.set(samples.subarray(len - capacity));
        writePos = 0;
        count    = capacity;
        return;
      }

      const overflow = count + len - capacity;
      if (overflow > 0) {
        // Drop overflow oldest samples (they are at readPos, which equals writePos
        // when the buffer is full). We don't need to actually move anything —
        // writePos advancement handles it.
        count = capacity - len;
      }

      const endPos = writePos + len;
      if (endPos <= capacity) {
        buf.set(samples, writePos);
      } else {
        // Wrap around
        const firstPart = capacity - writePos;
        buf.set(samples.subarray(0, firstPart), writePos);
        buf.set(samples.subarray(firstPart), 0);
      }
      writePos = endPos % capacity;
      count = Math.min(count + len, capacity);
    },

    /** How many samples are available to read. */
    get available() { return count; },

    /**
     * Read exactly SAMPLES_PER_CHUNK samples from the front of the ring
     * and return them as a fresh Int16Array copy (safe for async downstream).
     * Returns null if fewer than SAMPLES_PER_CHUNK samples are available.
     */
    readChunk() {
      if (count < SAMPLES_PER_CHUNK) return null;

      // Compute readPos: for a ring buffer with head=writePos and count items,
      // the oldest item is at (writePos - count + capacity) % capacity
      const readPos = (writePos - count + MAX_BUFFER_SAMPLES) % MAX_BUFFER_SAMPLES;

      const endPos = readPos + SAMPLES_PER_CHUNK;
      if (endPos <= MAX_BUFFER_SAMPLES) {
        chunkBuf.set(buf.subarray(readPos, endPos));
      } else {
        const firstPart = MAX_BUFFER_SAMPLES - readPos;
        chunkBuf.set(buf.subarray(readPos, MAX_BUFFER_SAMPLES), 0);
        chunkBuf.set(buf.subarray(0, SAMPLES_PER_CHUNK - firstPart), firstPart);
      }

      count -= SAMPLES_PER_CHUNK;

      // Return a copy — downstream listeners may hold onto this asynchronously
      return chunkBuf.slice();
    },

    /** Discard all buffered samples. */
    clear() {
      writePos = 0;
      count    = 0;
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAudioBuffer() {

  // Per-speaker state: speakerKey → { ring, speakerId, roomId }
  const speakers = new Map();

  function getSpeakerKey(roomId, speakerId) {
    return `${roomId}:${speakerId}`;
  }

  // Stats window — reset every 10s by the stats interval
  let stats = { framesReceived: 0, chunksEmitted: 0, overflows: 0 };
  let statsInterval = null;

  function onFrame(frame) {
    stats.framesReceived++;

    const { roomId, speakerId, data, ts } = frame;

    if (!data || data.length === 0) return;

    const key = getSpeakerKey(roomId, speakerId);

    // Get or create the ring buffer for this speaker
    if (!speakers.has(key)) {
      speakers.set(key, {
        ring: createRingBuffer(MAX_BUFFER_SAMPLES),
        speakerId,
        roomId,
      });
      log.debug({ roomId, speakerId }, 'New speaker ring buffer created');
    }

    const state = speakers.get(key);

    // Track overflow for stats (ring buffer handles it silently by overwriting)
    const beforeAvail = state.ring.available;
    if (beforeAvail + data.length > MAX_BUFFER_SAMPLES) {
      stats.overflows++;
      log.warn(
        { roomId, speakerId, available: beforeAvail, incoming: data.length },
        'AudioBuffer overflow — oldest samples will be overwritten'
      );
    }

    // Write incoming samples into the ring buffer (zero allocations)
    state.ring.write(data);

    // Flush as many complete CHUNK_SIZE_MS windows as available
    let chunk;
    while ((chunk = state.ring.readChunk()) !== null) {
      stats.chunksEmitted++;

      bus.emit(Events.SPEECH_CHUNK, {
        roomId,
        speakerId:   state.speakerId,
        chunk,                       // Int16Array, exactly SAMPLES_PER_CHUNK samples
        sampleRate:  SAMPLE_RATE,
        chunkSizeMs: CHUNK_SIZE_MS,
        ts,
      });
    }
  }

  function clearSpeaker(roomId, speakerId) {
    const key = getSpeakerKey(roomId, speakerId);
    const state = speakers.get(key);
    if (!state) return;
    log.debug({ roomId, speakerId, available: state.ring.available }, 'Speaker ring buffer cleared');
    state.ring.clear();
    speakers.delete(key);
  }

  // AUDIO_TRACK_REMOVED carries { roomId, participantId, trackSid }
  function onTrackRemoved({ roomId, participantId }) {
    clearSpeaker(roomId, participantId);
  }

  function onRoomDisconnected({ roomId }) {
    for (const [key, state] of speakers) {
      if (state.roomId === roomId) {
        log.debug(
          { roomId, speakerId: state.speakerId, available: state.ring.available },
          'Speaker ring buffer cleared on room disconnect'
        );
        state.ring.clear();
        speakers.delete(key);
      }
    }
  }

  function logStats() {
    if (stats.framesReceived === 0) return;
    log.debug(
      {
        framesReceived: stats.framesReceived,
        chunksEmitted:  stats.chunksEmitted,
        overflows:      stats.overflows,
        activeSpeakers: speakers.size,
      },
      'AudioBuffer stats (last 10s)'
    );
    stats = { framesReceived: 0, chunksEmitted: 0, overflows: 0 };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  function init() {
    bus.on(Events.AUDIO_FRAME,         onFrame);
    bus.on(Events.AUDIO_TRACK_REMOVED, onTrackRemoved);
    bus.on(Events.ROOM_DISCONNECTED,   onRoomDisconnected);

    statsInterval = setInterval(logStats, 10_000);
    // Don't keep the process alive after shutdown
    statsInterval.unref();

    log.info(
      { chunkSizeMs: CHUNK_SIZE_MS, samplesPerChunk: SAMPLES_PER_CHUNK },
      'AudioBuffer initialised'
    );
  }

  function destroy() {
    bus.off(Events.AUDIO_FRAME,         onFrame);
    bus.off(Events.AUDIO_TRACK_REMOVED, onTrackRemoved);
    bus.off(Events.ROOM_DISCONNECTED,   onRoomDisconnected);

    clearInterval(statsInterval);
    statsInterval = null;

    speakers.clear();
    log.debug('AudioBuffer destroyed');
  }

  return { init, destroy };
}