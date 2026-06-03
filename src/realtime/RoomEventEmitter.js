/**
 * RoomEventEmitter
 *
 * Responsibility: translate raw LiveKit room events into normalized internal
 * bus events. Nothing outside this file should import from @livekit/rtc-node.
 *
 * Comment-ingestion contract
 * ──────────────────────────
 * Two separate code paths produce comment events, intentionally kept distinct:
 *
 *  • onDataReceived  → emits Events.COMMENT_RAW
 *      Raw binary payload from the LiveKit data channel. The shape of the
 *      JSON inside is controlled by the broadcaster's client SDK and is NOT
 *      guaranteed. CommentParser (src/comments/CommentParser.js) owns
 *      deserialization and validation before anything downstream consumes it.
 *
 *  • onChatMessage   → emits Events.COMMENT_RECEIVED
 *      Structured message from LiveKit's native Chat API. Already decoded and
 *      typed by the SDK; emitted with a normalized shape that CommentFilter
 *      and downstream listeners can consume directly without further parsing.
 *
 * Downstream listeners must NOT subscribe to both events for the same logical
 * comment — a single chat message will arrive via one path only depending on
 * how the broadcaster's client sends it.
 */
import { RoomEvent, TrackKind, AudioStream } from '@livekit/rtc-node';
import bus, { Events } from '../core/EventBus.js';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'RoomEventEmitter' });
const textDecoder = new TextDecoder();

export function createRoomEventEmitter(room, config) {
  const { roomId, botUserId, ownerIdentity = null } = config;

  // trackSid → AbortController
  // TODO(backpressure): if the event bus consumer (VADProcessor) falls behind,
  // AUDIO_FRAME events will queue unboundedly in Node's event loop. Consider
  // adding a high-water-mark counter per trackSid and dropping/logging frames
  // when the lag exceeds a threshold (e.g. > 500 ms of buffered audio).
  const audioStreams = new Map();

  // ─── Audio frame reader ─────────────────────────────────────────────────

  async function runAudioFrameLoop(audioStream, trackSid, speakerId, abortSignal) {
    const reader = audioStream.getReader();

    // Wake the awaiting reader.read() when abort fires.
    //
    // Note: do NOT use `Promise.race([reader.read(), abortPromise])` here.
    // That pattern is a known memory leak — each iteration attaches a fresh
    // `then` callback to the long-lived abortPromise's reaction list, and
    // because abortPromise never resolves, those callbacks (each retaining
    // a wrapper promise) accumulate forever.
    const onAbort = () => {
      try { reader.cancel(); } catch { /* already cancelled */ }
    };
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let frameCount = 0;
    let lastHeapLogTs = Date.now();

    try {
      while (!abortSignal.aborted) {
        let result;
        try {
          result = await reader.read();
        } catch (err) {
          if (abortSignal.aborted) break;
          throw err;
        }

        const { value: frame, done } = result;
        if (done || abortSignal.aborted) break;

        frameCount++;

        // Periodic heap growth log — leaves a trail in stdout when the
        // process is approaching OOM, so the leak source can be identified
        // from the rate of growth (steady ramp = SDK-side queue, sudden
        // jumps = downstream listener buildup).
        const now = Date.now();
        if (now - lastHeapLogTs >= 1000) {
          const mu = process.memoryUsage();
          // Sync stderr — pino's transport is buffered and a fast OOM
          // can happen before any of those lines reach the terminal.
          process.stderr.write(
            `[heap] frames=${frameCount} ` +
            `heap=${Math.round(mu.heapUsed / 1024 / 1024)}/${Math.round(mu.heapTotal / 1024 / 1024)}MB ` +
            `ext=${Math.round(mu.external / 1024 / 1024)}MB ` +
            `arrBuf=${Math.round(mu.arrayBuffers / 1024 / 1024)}MB ` +
            `rss=${Math.round(mu.rss / 1024 / 1024)}MB\n`,
          );
          lastHeapLogTs = now;
          frameCount = 0;
        }

        // Testing hack removed, we will test downstream pipelines
        if (process.env.AUDIO_DROP_FRAMES === '1') {
          continue;
        }

        bus.emit(Events.AUDIO_FRAME, {
          roomId,
          speakerId,
          trackSid,
          data:              frame.data,           // Int16Array, 16kHz mono
          sampleRate:        frame.sampleRate,     // always 16000
          channels:          frame.channels,       // always 1
          samplesPerChannel: frame.samplesPerChannel,
          ts:                now,
        });

        // Yield to the event loop's macrotask queue. If reader.read() resolves
        // synchronously because of a backlog, a tight while(await) loop will
        // starve the event loop and OOM the process.
        await new Promise(r => setImmediate(r));

        if (frameCount % 100 === 0 && global.gc) {
          global.gc();
        }
      }
    } finally {
      abortSignal.removeEventListener?.('abort', onAbort);
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  function startAudioFrameReader(track, trackSid, speakerId) {
    if (audioStreams.has(trackSid)) {
      log.warn({ trackSid }, 'Audio frame reader already exists for track SID — skipping creation');
      return;
    }

    // frameSizeMs: 30 batches frames at the SDK level. Without this the
    // native side emits ~10ms frames (~100 Hz), and each one allocates an
    // AudioFrame holding an FfiHandle whose retained microtask continuations
    // accumulate faster than the GC can reclaim them — the process OOMs in
    // ~20s. Batching to 30ms gives ~33 Hz, matching the VAD window exactly
    // and removing the need for a per-frame drop throttle in this loop.
    const audioStream     = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 30 });
    const abortController = new AbortController();

    audioStreams.set(trackSid, { controller: abortController, speakerId });

    runAudioFrameLoop(audioStream, trackSid, speakerId, abortController.signal)
      .catch((err) => {
        if (err?.name === 'AbortError') {
          log.debug({ trackSid }, 'Audio frame reader aborted cleanly');
          return;
        }
        log.error({ trackSid, err }, 'Audio frame reader crashed');
        bus.emit(Events.AUDIO_TRACK_REMOVED, { roomId, participantId: speakerId, trackSid });
      });
  }

  function stopAudioFrameReader(trackSid) {
    const entry = audioStreams.get(trackSid);
    if (!entry) return;
    entry.controller.abort();
    audioStreams.delete(trackSid);
  }

  function stopAllAudioReaders() {
    for (const [trackSid, entry] of audioStreams) {
      log.debug({ trackSid }, 'Stopping audio reader');
      entry.controller.abort();
    }
    audioStreams.clear();
  }

  // ─── Room lifecycle ─────────────────────────────────────────────────────

  function onConnected() {
    log.info({ roomId }, 'Room connected');
    bus.emit(Events.ROOM_CONNECTED, { roomId, roomName: room.name });

    // Wire participants already present when the bot joined.
    // This handles the race where remoteParticipants exist before Connected fires.
    for (const [, participant] of room.remoteParticipants) {
      log.debug({ identity: participant.identity }, 'Wiring pre-existing participant');
      onParticipantConnected(participant);
      for (const [, publication] of participant.trackPublications) {
        if (publication.track) {
          onTrackSubscribed(publication.track, publication, participant);
        }
      }
    }
  }

  function onDisconnected(reason) {
    log.warn({ roomId, reason }, 'Room disconnected');
    stopAllAudioReaders();
    bus.emit(Events.ROOM_DISCONNECTED, { roomId, reason: String(reason ?? 'unknown') });
  }

  function onReconnecting() {
    log.warn({ roomId }, 'Room reconnecting');
    bus.emit(Events.ROOM_RECONNECTING, { roomId });
  }

  function onReconnected() {
    log.info({ roomId }, 'Room reconnected');
    bus.emit(Events.ROOM_RECONNECTED, { roomId });

    // After a reconnect, LiveKit may have replaced track SIDs for existing
    // participants. Stop stale readers and re-wire from the current state.
    stopAllAudioReaders();

    for (const [, participant] of room.remoteParticipants) {
      log.debug({ identity: participant.identity }, 'Re-wiring participant after reconnect');
      onParticipantConnected(participant);
      for (const [, publication] of participant.trackPublications) {
        if (publication.track) {
          onTrackSubscribed(publication.track, publication, participant);
        }
      }
    }
  }

  // ─── Participant lifecycle ───────────────────────────────────────────────

  function onParticipantConnected(participant) {
    log.info({ identity: participant.identity }, 'Participant joined');
    bus.emit(Events.PARTICIPANT_JOINED, {
      roomId,
      participantId: participant.identity,
      identity:      participant.identity,
    });
  }

  function onParticipantDisconnected(participant) {
    log.info({ identity: participant.identity }, 'Participant left');

    // Defensively stop any audio readers for this participant.
    // TrackUnsubscribed events normally arrive first, but abrupt network
    // disconnects can prevent them — leaving stale readers alive indefinitely.
    for (const [trackSid, entry] of audioStreams) {
      if (entry.speakerId === participant.identity) {
        log.debug({ trackSid, identity: participant.identity }, 'Stopping orphaned audio reader on participant disconnect');
        entry.controller.abort();
        audioStreams.delete(trackSid);
      }
    }

    bus.emit(Events.PARTICIPANT_LEFT, {
      roomId,
      participantId: participant.identity,
      identity:      participant.identity,
    });
  }

  // ─── Track lifecycle ─────────────────────────────────────────────────────

  function onTrackSubscribed(track, publication, participant) {
    if (track.kind !== TrackKind.KIND_AUDIO) return;

    if (ownerIdentity && participant.identity !== ownerIdentity) {
      log.debug(
        { identity: participant.identity, ownerIdentity },
        'Skipping audio track — not the owner'
      );
      return;
    }

    log.info({ trackSid: publication.sid, identity: participant.identity }, 'Audio track subscribed');

    bus.emit(Events.AUDIO_TRACK_ADDED, {
      roomId,
      participantId: participant.identity,
      track,
      publication,
    });

    // Voice STT is gated behind ENABLE_VOICE_STT=true because the continuous
    // AudioStream read loop creates allocation pressure that OOMs the process.
    // Disable by default until a proper backpressure mechanism is in place.
    if (process.env.ENABLE_VOICE_STT === 'true') {
      startAudioFrameReader(track, publication.sid, participant.identity);
    } else {
      log.debug({ trackSid: publication.sid }, 'Voice STT disabled (ENABLE_VOICE_STT != true) — audio frames will not be processed');
    }
  }

  function onTrackUnsubscribed(track, publication, participant) {
    if (track.kind !== TrackKind.KIND_AUDIO) return;

    log.info({ trackSid: publication.sid, identity: participant.identity }, 'Audio track unsubscribed');
    stopAudioFrameReader(publication.sid);

    bus.emit(Events.AUDIO_TRACK_REMOVED, {
      roomId,
      participantId: participant.identity,
      trackSid:      publication.sid,
    });
  }

  // ─── Data channel ────────────────────────────────────────────────────────

  function onDataReceived(payload, participant, _kind, topic) {
    if (!participant || participant.identity === botUserId) return;

    // Topic filter: intentionally only process 'chat' topic or untagged messages.
    // Other topics (e.g. reactions, presence pings) are unrelated to comment
    // ingestion and should not be forwarded to CommentParser.
    // TODO(reliable-filter): also check _kind === DataPacketKind.RELIABLE once
    // the broadcaster client is confirmed to send chat data as RELIABLE packets.
    // LOSSY packets are acceptable for ephemeral data (e.g. cursor positions)
    // but not for chat messages that must be processed exactly once.
    if (topic != null && topic !== 'chat' && topic !== 'lk.chat') return;

    // Guard: TextDecoder.decode() throws TypeError if payload is not a BufferSource
    if (!(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) {
      log.warn({ type: typeof payload }, 'Data channel payload is not a BufferSource — dropping');
      return;
    }

    let decoded;
    try {
      decoded = textDecoder.decode(payload);
    } catch (err) {
      log.warn({ err }, 'Failed to decode data channel payload — dropping');
      return;
    }

    if (!decoded.trim()) return;

    // Emits COMMENT_RAW — shape is unvalidated. CommentParser must handle
    // malformed JSON, missing fields, and unexpected payload versions before
    // re-emitting as COMMENT_RECEIVED.
    // CONTRACT: do NOT subscribe to COMMENT_RAW outside of CommentParser.
    // Direct subscribers receive raw, unvalidated, potentially malicious data.
    bus.emit(Events.COMMENT_RAW, {
      rawPayload:    decoded,
      participantId: participant?.identity ?? 'unknown',
      roomId,
      source:        'data_channel',
    });
  }

  // ─── Native chat API ──────────────────────────────────────────────────────

  // Emits COMMENT_RECEIVED directly — bypasses COMMENT_RAW / CommentParser
  // entirely because the LiveKit Chat API already provides a structured,
  // SDK-validated payload. The shape emitted here is the canonical
  // COMMENT_RECEIVED contract that all downstream listeners expect.
  function onChatMessage(message, participant) {
    if (participant?.identity === botUserId) return;
    if (!message?.message?.trim()) return;

    // Validate timestamp — guard against non-numeric truthy values producing
    // an "Invalid Date" which would throw on .toISOString().
    let ts;
    if (message.timestamp != null) {
      const d = new Date(message.timestamp);
      ts = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    } else {
      ts = new Date().toISOString();
    }

    bus.emit(Events.COMMENT_RECEIVED, {
      roomId,
      userId:   participant?.identity ?? 'unknown',
      username: participant?.name ?? participant?.identity ?? 'unknown',
      text:     message.message.trim(),
      ts,
      source:   'chat_message',
    });
  }

  // ─── Native chat text-stream API ─────────────────────────────────────────
  //
  // Newer LiveKit clients (web SDK >= 2.x) send chat via the TextStream API
  // on topic `lk.chat` instead of the legacy ChatMessage / DataPacket paths.
  // Without a registered handler the SDK logs:
  //   "ignoring incoming text stream due to no handler for topic: lk.chat"
  // and the message is dropped. Emit COMMENT_RECEIVED with the same canonical
  // shape used by onChatMessage so downstream listeners need no changes.

  const CHAT_TOPICS = ['lk.chat', 'chat'];

  async function onChatTextStream(reader, participantInfo) {
    const identity = participantInfo?.identity ?? 'unknown';
    if (identity === botUserId) return;

    let text;
    try {
      text = await reader.readAll();
    } catch (err) {
      log.warn({ err, identity }, 'Failed to read chat text stream — dropping');
      return;
    }

    if (!text || !text.trim()) return;

    const participant = room.remoteParticipants?.get?.(identity);
    const ts = reader.info?.timestamp != null
      ? new Date(Number(reader.info.timestamp)).toISOString()
      : new Date().toISOString();

    log.info(
      { roomId, identity, topic: reader.info?.topic, textLen: text.length },
      'Chat text stream received'
    );

    bus.emit(Events.COMMENT_RECEIVED, {
      roomId,
      userId:   identity,
      username: participant?.name ?? identity,
      text:     text.trim(),
      ts:       Number.isNaN(Date.parse(ts)) ? new Date().toISOString() : ts,
      source:   'chat_message',
    });
  }

  // ─── Attach / detach ─────────────────────────────────────────────────────

  function attach() {
    room.on(RoomEvent.Connected,               onConnected);
    room.on(RoomEvent.Disconnected,            onDisconnected);
    room.on(RoomEvent.Reconnecting,            onReconnecting);
    room.on(RoomEvent.Reconnected,             onReconnected);
    room.on(RoomEvent.ParticipantConnected,    onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.TrackSubscribed,         onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed,       onTrackUnsubscribed);
    room.on(RoomEvent.DataReceived,            onDataReceived);
    room.on(RoomEvent.ChatMessage,             onChatMessage);

    if (typeof room.registerTextStreamHandler === 'function') {
      for (const topic of CHAT_TOPICS) {
        try {
          room.registerTextStreamHandler(topic, onChatTextStream);
        } catch (err) {
          log.warn({ err, topic }, 'Failed to register text stream handler');
        }
      }
    }

    log.debug({ roomId }, 'RoomEventEmitter attached');
  }

  function detach() {
    stopAllAudioReaders();

    room.off(RoomEvent.Connected,               onConnected);
    room.off(RoomEvent.Disconnected,            onDisconnected);
    room.off(RoomEvent.Reconnecting,            onReconnecting);
    room.off(RoomEvent.Reconnected,             onReconnected);
    room.off(RoomEvent.ParticipantConnected,    onParticipantConnected);
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.TrackSubscribed,         onTrackSubscribed);
    room.off(RoomEvent.TrackUnsubscribed,       onTrackUnsubscribed);
    room.off(RoomEvent.DataReceived,            onDataReceived);
    room.off(RoomEvent.ChatMessage,             onChatMessage);

    if (typeof room.unregisterTextStreamHandler === 'function') {
      for (const topic of CHAT_TOPICS) {
        try {
          room.unregisterTextStreamHandler(topic);
        } catch { /* ignore */ }
      }
    }

    log.debug({ roomId }, 'RoomEventEmitter detached');
  }

  // Attach immediately on creation
  attach();

  // Only expose what callers actually need
  return { detach };
}