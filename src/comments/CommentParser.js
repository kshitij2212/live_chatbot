import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'CommentParser' });

// Clients sending via the data channel should JSON-encode a payload like:
//   { text: "hello!", username: "alice", userId: "alice-123", ts: 1718000000000 }
// Only `text` is required. All other fields are optional and fall back to
// values already present in the COMMENT_RAW envelope (participantId, Date.now).
// This parser is intentionally lenient — it never throws, it just drops
// payloads it cannot make sense of and logs a warning.

/**
 * Attempts to parse a raw string as JSON.
 * Falls back to treating the entire string as plain `text` if it is not JSON.
 * This covers clients that send bare strings instead of JSON objects.
 *
 * @param   {string} raw
 * @returns {{ text?: string, username?: string, userId?: string, ts?: number } | null}
 */
function parsePayload(raw) {
  const trimmed = raw.trim();

  if (!trimmed.startsWith('{')) {
    // Bare string — treat the whole thing as the comment text
    return { text: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn({ raw: trimmed }, 'Parsed JSON is not an object — dropping');
      return null;
    }

    return parsed;
  } catch {
    log.warn({ raw: trimmed }, 'Failed to JSON-parse data channel payload — dropping');
    return null;
  }
}

/**
 * Extracts and normalises a timestamp from the parsed payload.
 * Accepts: ISO string, Unix ms number, Unix s number.
 * Falls back to now if the value is missing or unparseable.
 *
 * @param   {unknown} raw
 * @returns {string}  ISO-8601 string
 */
function normaliseTimestamp(raw) {
  if (raw == null) return new Date().toISOString();

  // Numeric: distinguish ms (13 digits) from seconds (10 digits)
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d   = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  // String: try direct Date parse
  if (typeof raw === 'string') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  return new Date().toISOString();
}

/**
 * Cleans the text field:
 * - Trims surrounding whitespace
 * - Collapses internal runs of whitespace to a single space
 * - Strips null bytes
 *
 * @param   {string} text
 * @returns {string}
 */
function sanitiseText(text) {
  return text
    .replace(/\0/g, '')       // null bytes
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
}

/**
 * Handles a COMMENT_RAW event emitted by RoomEventEmitter (data channel path).
 *
 * Parses the raw payload into a normalised COMMENT_RECEIVED shape that is
 * identical to what the native chat path produces directly, so all downstream
 * consumers (CommentFilter, etc.) only need to handle one shape.
 *
 * COMMENT_RECEIVED shape:
 * {
 *   roomId:   string,
 *   userId:   string,
 *   username: string,
 *   text:     string,
 *   ts:       string,   ← ISO-8601
 *   source:   'data_channel'
 * }
 */
function onCommentRaw({ rawPayload, participantId, roomId, source }) {
  // 1. Parse
  const parsed = parsePayload(rawPayload);
  if (!parsed) return;  // already logged in parsePayload

  // 2. Extract text
  const rawText = typeof parsed.text === 'string' ? parsed.text : '';
  const text    = sanitiseText(rawText);

  if (!text) {
    log.debug({ roomId, participantId }, 'Empty text after sanitisation — dropping');
    return;
  }

  // 3. Resolve identity fields
  //    Priority: explicit fields in the payload > participantId from the envelope
  const userId   = (typeof parsed.userId   === 'string' && parsed.userId.trim())
    ? parsed.userId.trim()
    : participantId ?? 'unknown';

  const username = (typeof parsed.username === 'string' && parsed.username.trim())
    ? parsed.username.trim()
    : userId;

  // 4. Normalise timestamp
  const ts = normaliseTimestamp(parsed.ts);

  // 5. Emit normalised event — same shape as the native chat path
  const event = {
    roomId,
    userId,
    username,
    text,
    ts,
    source: 'data_channel',   // preserve original source even though shape is unified
  };

  log.debug({ roomId, userId, username, textLen: text.length }, 'Comment parsed');
  bus.emit(Events.COMMENT_RECEIVED, event);
}

bus.on(Events.COMMENT_RAW, onCommentRaw);

log.debug('CommentParser registered');