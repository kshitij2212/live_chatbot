import 'dotenv/config';

import bus, { Events }           from './EventBus.js';
import logger                    from '../utils/logger.js';
import config                    from '../../config/default.js';

import { createLiveKitConnector }  from '../realtime/LiveKitConnector.js';
import { createReplyPublisher }    from '../realtime/ReplyPublisher.js';
import { createRedisClient }       from '../memory/RedisClient.js';
import { createContextMemory }     from '../memory/ContextMemoryService.js';
import { createPersonaMemory }     from '../memory/PersonaMemoryService.js';
import { createBehaviorEngine }    from '../behavior/BehaviorEngine.js';
import { createContextBuilder }    from '../ai/ContextBuilder.js';
import { createPromptBuilder }     from '../ai/PromptBuilder.js';
import { createGroqAdapter }       from '../ai/GroqAdapter.js';
import { createLLMService }        from '../ai/LLMService.js';
import { createResponseParser }    from '../ai/ResponseParser.js';
import { createModerationService } from '../moderation/ModerationService.js';
import { createCommentFilter }     from '../comments/CommentFilter.js';
import { createCommentListener }   from '../comments/CommentListener.js';
import '../comments/CommentParser.js';

const log = logger.child({ module: 'BotRunner' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── BotRunner ────────────────────────────────────────────────────────────────

export function createBotRunner() {

  let connector       = null;
  let replyPublisher  = null;
  let redis           = null;
  let context         = null;
  let persona         = null;
  let behavior        = null;
  let contextBuilder  = null;
  let promptBuilder   = null;
  let llm             = null;
  let responseParser  = null;
  let moderation      = null;
  let audioBuffer     = null;
  let vad             = null;
  let segmenter       = null;
  let stt             = null;
  let commentFilter   = null;
  let commentListener = null;
  let isShuttingDown  = false;

  // roomRef is a shared mutable container.
  // LiveKitConnector updates roomRef.room on connect/reconnect.
  // ReplyPublisher reads roomRef.room when sending — always gets the live instance.
  const roomRef = { room: null };

  // Tracks every bus.on() registration so unwireEvents() can clean up
  const listeners = [];

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function on(event, fn) {
    bus.on(event, fn);
    listeners.push([event, fn]);
  }

  function once(event, fn) {
    bus.once(event, fn);
    listeners.push([event, fn]);
  }

  function unwireEvents() {
    for (const [event, fn] of listeners) bus.off(event, fn);
    listeners.length = 0;
  }

  // ─── Wire ──────────────────────────────────────────────────────────────────

  function wireEvents() {

    // ── Room lifecycle ──────────────────────────────────────────────────────

    on(Events.ROOM_CONNECTED, ({ roomId, roomName, room }) => {
      // Fix #2 — keep roomRef in sync so ReplyPublisher always has the live Room
      if (room) roomRef.room = room;
      log.info({ roomId, roomName }, '🎙  Joined room');
      context.setMeta(roomId, {
        roomName,
        botUserId: config.livekit.botIdentity,
        startedAt: new Date().toISOString(),
      }).catch((err) => log.warn({ err }, 'Failed to set room meta'));
    });

    on(Events.ROOM_DISCONNECTED, ({ roomId, reason }) => {
      log.warn({ roomId, reason }, 'Left room');
    });



    on(Events.PARTICIPANT_JOINED, ({ roomId, identity }) => {
      log.info({ roomId, identity }, '👤 Participant joined');
    });

    on(Events.PARTICIPANT_LEFT, ({ roomId, identity }) => {
      log.info({ roomId, identity }, '👤 Participant left');
    });

    // ── Transcript pipeline (Phase 2 — STT) ────────────────────────────────
    // Wired now so the handler exists when STT is enabled.
    // Does nothing while ENABLE_VOICE_STT is not set.

    on(Events.TRANSCRIPT_READY, async ({ roomId, text, speakerId }) => {
      if (!text?.trim() || isShuttingDown) return;
      log.debug({ roomId, speakerId, text }, '📝 Transcript received');
      try {
        await context.addTranscript(roomId, text);
        const decision = await behavior.evaluate({ roomId, type: 'transcript', text });
        if (!decision.shouldReply) return;
        bus.emit(Events.BEHAVIOR_APPROVED, {
          roomId,
          trigger:     text,
          triggerType: 'transcript',
          delayMs:     decision.delayMs,
        });
      } catch (err) {
        log.error({ err, roomId }, 'Error in transcript handler');
      }
    });

    // ── Comment pipeline ────────────────────────────────────────────────────
    //
    // Flow:
    //   COMMENT_RECEIVED
    //     → CommentFilter (subscribed directly)
    //       → COMMENT_ACCEPTED
    //         → here (BotRunner) — stores in context, asks BehaviorEngine
    //           → BEHAVIOR_APPROVED
    //             → ContextBuilder — builds prompt
    //               → CONTEXT_READY
    //                 → LLMService — calls Groq
    //                   → REPLY_READY

    on(Events.COMMENT_ACCEPTED, async ({ roomId, userId, username, text }) => {
      if (!text?.trim() || isShuttingDown) return;
      log.debug({ roomId, username, text }, '💬 Comment accepted');
      try {
        await context.addComment(roomId, userId, username, text);
        const decision = await behavior.evaluate({ roomId, type: 'comment', text });
        if (!decision.shouldReply) return;
        bus.emit(Events.BEHAVIOR_APPROVED, {
          roomId,
          trigger:     text,
          triggerType: 'comment',
          username,
          delayMs:     decision.delayMs,
        });
      } catch (err) {
        log.error({ err, roomId }, 'Error in comment handler');
      }
    });

    // ── Reply publish ───────────────────────────────────────────────────────
    //
    // LLMService emits REPLY_READY → BotRunner applies delay + moderation
    // → emits REPLY_SEND → ReplyPublisher sends into the LiveKit room
    // → emits REPLY_SENT → BotRunner logs confirmation

    on(Events.REPLY_READY, async ({ roomId, text, trigger, usage }) => {
      if (isShuttingDown) {
        log.debug({ roomId }, 'Shutdown in progress — dropping queued reply');
        return;
      }

      // Typing delay — simulates human latency before sending
      const delayMs = trigger?.delayMs ?? 0;
      if (delayMs > 0) {
        log.debug({ roomId, delayMs }, '⌨️  Simulating typing delay');
        await sleep(delayMs);
      }

      if (isShuttingDown) return;

      try {
        // Moderation check before storing or sending
        const modResult = await moderation.check(text);
        if (!modResult.safe) {
          log.warn({ roomId, reason: modResult.reason }, 'Moderation flagged reply — dropping');
          return;
        }

        // Store bot reply in context BEFORE sending so history is consistent
        // even if the send fails
        await context.addBotReply(roomId, text);

        // Hand off to ReplyPublisher via the event bus
        // ReplyPublisher listens to REPLY_SEND and calls room.localParticipant.sendChatMessage()
        bus.emit(Events.REPLY_SEND, { roomId, trigger, text, usage });

      } catch (err) {
        log.error({ err, roomId }, 'Error in reply handler');
      }
    });

    on(Events.REPLY_SENT, ({ roomId, text }) => {
      log.info({ roomId, text }, '✅ Reply sent');
    });

    on(Events.REPLY_FAILED, ({ roomId, trigger, errName, errMessage }) => {
      log.warn({ roomId, userId: trigger?.userId, errName, errMessage }, '⚠️  Reply failed');
    });

    // ── Connector events ────────────────────────────────────────────────────

    on(Events.CONNECTOR_RECONNECTING, ({ roomId, attempt, maxAttempts, delayMs }) => {
      log.warn({ roomId, attempt, maxAttempts, delayMs }, '🔄 Reconnecting...');
    });

    on(Events.CONNECTOR_RECONNECTED, ({ roomId, attempt }) => {
      if (connector?.getRoom) roomRef.room = connector.getRoom();
      log.info({ roomId, attempt }, '✓ Connector reconnected');
    });

    on(Events.CONNECTOR_FAILED, ({ roomId, attempts }) => {
      log.error({ roomId, attempts }, '✗ All reconnect attempts failed — shutting down');
      stop('connector_failed').catch((err) => log.error({ err }, 'Shutdown error'));
    });

    // ── Shutdown signal ─────────────────────────────────────────────────────

    once(Events.BOT_SHUTDOWN, () => {
      stop('BOT_SHUTDOWN event').catch((err) => log.error({ err }, 'Shutdown error'));
    });
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async function start() {
    log.info('═══════════════════════════════════════════');
    log.info('  Roxstar AI Bot — starting up');
    log.info('═══════════════════════════════════════════');
    log.info({ room: config.livekit.roomName, bot: config.livekit.botIdentity }, 'Config loaded');

    // ── Redis ─────────────────────────────────────────────────────────────

    log.info('Connecting to Redis...');
    redis = await createRedisClient(config.redis.url);
    log.info({ url: config.redis.url }, '✓ Redis connected');

    // ── Core services ─────────────────────────────────────────────────────

    log.info('Instantiating services...');

    persona = createPersonaMemory();
    log.debug('✓ PersonaMemory');

    context = createContextMemory(redis, {
      maxTranscriptEntries: config.context.windowSize,
      maxCommentEntries:    config.context.windowSize,
      maxBotReplyEntries:   config.context.windowSize,
      contextTtl:           config.redis.contextTtlSeconds,
    });
    log.debug('✓ ContextMemory');

    behavior = createBehaviorEngine(redis, {
      cooldownSeconds:      Math.floor(config.behavior.perUserCooldownMs / 1000),
      baseReplyProbability: config.behavior.replyProbability,
      maxRepliesPerMinute:  6,
    });
    log.debug('✓ BehaviorEngine');

    promptBuilder = createPromptBuilder({
      historyTokenBudget: config.prompt.historyTokenBudget,
    });
    log.debug('✓ PromptBuilder');

    contextBuilder = createContextBuilder({
      contextMemory: context,
      personaMemory: persona,
      promptBuilder,
      botId:         config.livekit.botPersona,
    });
    log.debug('✓ ContextBuilder');

    // Fix #3 — createResponseParser takes a single config object, not (persona, options)
    responseParser = createResponseParser({ maxReplyChars: 300 });
    log.debug('✓ ResponseParser');

    const groqAdapter = createGroqAdapter({
      apiKey:      config.groq.apiKey,
      model:       config.groq.model,
      maxTokens:   config.groq.maxTokens,
      temperature: config.groq.temperature,
      timeoutMs:   config.groq.timeoutMs,
      maxRetries:  config.groq.maxRetries,
    });
    log.debug('✓ GroqAdapter');

    llm = createLLMService({ groqAdapter, responseParser });
    log.debug('✓ LLMService');

    moderation = createModerationService({ openaiKey: process.env.OPENAI_API_KEY });
    log.debug('✓ ModerationService');

    commentFilter = createCommentFilter({
      minLength:            config.commentFilter.minLength,
      maxLength:            config.commentFilter.maxLength,
      rateLimitWindowMs:    config.commentFilter.rateLimitWindowMs,
      rateLimitMaxMessages: config.commentFilter.rateLimitMaxMessages,
    });
    log.debug('✓ CommentFilter');

    commentListener = createCommentListener();
    log.debug('✓ CommentListener');

    // ── Audio pipeline (Phase 2) ──────────────────────────────────────────
    //
    // Fix #1 — default is SKIPPED, not full pipeline.
    // Set AUDIO_PIPELINE_STAGE=1/2/3/4 explicitly to enable stages.
    // Unset or '0' = comment-only mode, no audio processing.
    //
    // AUDIO_PIPELINE_STAGE levels:
    //   0 or unset → skip all audio (safe default, no OOM risk)
    //   1          → AudioBuffer only
    //   2          → AudioBuffer + VAD
    //   3          → AudioBuffer + VAD + SpeechSegmenter
    //   4          → full pipeline including STT

    const audioStage = Number(process.env.AUDIO_PIPELINE_STAGE ?? '0');
    log.info({ audioStage }, `Audio pipeline stage: ${audioStage === 0 ? 'DISABLED' : audioStage}`);

    if (audioStage >= 1) {
      const { createAudioBuffer } = await import('../audio/AudioBuffer.js');
      audioBuffer = createAudioBuffer();
      audioBuffer.init();
      log.debug('✓ AudioBuffer');
    }

    if (audioStage >= 2) {
      const { createVADProcessor } = await import('../audio/VADProcessor.js');
      vad = createVADProcessor();
      vad.init();
      log.debug('✓ VADProcessor');
    }

    if (audioStage >= 3) {
      const { createSpeechSegmenter } = await import('../audio/SpeechSegmenter.js');
      segmenter = createSpeechSegmenter();
      segmenter.init();
      log.debug('✓ SpeechSegmenter');
    }

    if (audioStage >= 4) {
      const { createSTTService } = await import('../stt/STTService.js');
      stt = createSTTService({
        groqApiKey: process.env.WHISPER_API_KEY ?? config.groq.apiKey,
      });
      stt.init();
      log.debug('✓ STTService');
    }

    // ── Transport layer ───────────────────────────────────────────────────

    connector = createLiveKitConnector({
      url:            config.livekit.url,
      apiKey:         config.livekit.apiKey,
      apiSecret:      config.livekit.apiSecret,
      tokenApiUrl:    config.livekit.tokenApiUrl,
      roomName:       config.livekit.roomName,
      botIdentity:    config.livekit.botIdentity,
      botDisplayName: config.livekit.botDisplayName,
      reconnect:      config.livekit.reconnect,
    });
    log.debug('✓ LiveKitConnector');

    // Fix #2 — roomRef is a shared object; connector must update it on connect
    // LiveKitConnector exposes getRoom() for this purpose
    replyPublisher = createReplyPublisher({
      roomRef,
      botIdentity:    config.livekit.botIdentity,
      botDisplayName: config.livekit.botDisplayName,
      sendMode:       'chat',
    });
    log.debug('✓ ReplyPublisher');

    // ── Wire events ───────────────────────────────────────────────────────

    log.info('Wiring EventBus...');
    wireEvents();
    log.info('✓ EventBus wired');

    // ── Connect ───────────────────────────────────────────────────────────

    log.info({ room: config.livekit.roomName }, 'Connecting to LiveKit room...');
    await connector.connect();

    // Seed roomRef.room immediately after connect for ReplyPublisher
    // ROOM_CONNECTED event also updates it, but this covers the window
    // between connect() resolving and the event firing
    if (connector.getRoom) roomRef.room = connector.getRoom();

    log.info('═══════════════════════════════════════════');
    log.info('  Bot is live. Listening...');
    log.info('═══════════════════════════════════════════');
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────

  async function stop(reason = 'unknown') {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info({ reason }, 'Shutting down bot...');

    // Stop accepting new events first
    unwireEvents();

    // Destroy services in reverse dependency order
    llm?.destroy();
    contextBuilder?.destroy();
    replyPublisher?.destroy();
    commentFilter?.destroy();
    commentListener?.destroy();
    stt?.destroy();
    segmenter?.destroy();
    vad?.destroy();
    audioBuffer?.destroy();

    if (connector) {
      await connector.disconnect().catch((err) => log.warn({ err }, 'Connector disconnect error'));
    }

    if (redis?.quit) {
      await redis.quit().catch((err) => log.warn({ err }, 'Redis quit error'));
      log.info('Redis disconnected');
    }

    // Null roomRef so any late ReplyPublisher calls fail fast
    roomRef.room = null;

    log.info('Bot stopped cleanly. Goodbye.');
    await sleep(200);
    process.exit(0);
  }

  return { start, stop };
}

// ─── Signal handlers ──────────────────────────────────────────────────────────

function registerSignalHandlers(runner) {
  let forcedExit = false;

  async function handleSignal(signal) {
    if (forcedExit) {
      process.stderr.write(`Forced exit on second ${signal}\n`);
      process.exit(1);
    }
    forcedExit = true;
    log.info({ signal }, 'Signal received — beginning graceful shutdown');
    await runner.stop(signal);
  }

  process.on('SIGINT',  () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    log.error({ err }, 'Uncaught exception');
    await runner.stop('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled promise rejection — investigate immediately');
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('BotRunner.js') || process.argv[1].endsWith('start-bot.js'));

if (isMain) {
  const runner = createBotRunner();
  registerSignalHandlers(runner);
  runner.start().catch(async (err) => {
    log.error({ err }, 'BotRunner.start() failed');
    await runner.stop('startup_error');
  });
}