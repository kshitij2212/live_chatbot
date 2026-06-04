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

  const roomRef = { room: null };

  const listeners = [];

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

  function wireEvents() {

    on(Events.ROOM_CONNECTED, ({ roomId, roomName, room }) => {
      
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

    on(Events.TRANSCRIPT_READY, async ({ roomId, text, speakerId }) => {
      if (!text?.trim() || isShuttingDown) return;

      const blacklist = /^(thank\s*you|bye|yeah|yes|ok|okay)$/i;
      if (blacklist.test(text.trim())) {
        log.debug({ roomId, text }, 'Blacklisted transcript (likely noise) — ignoring');
        return;
      }
      
      log.debug({ roomId, speakerId, text }, '📝 Transcript received');
      try {
        await context.addTranscript(roomId, text, speakerId);
        const decision = await behavior.evaluate({ roomId, type: 'transcript', text });
        if (!decision.shouldReply) return;
        bus.emit(Events.BEHAVIOR_APPROVED, {
          roomId,
          trigger:     text,
          triggerType: 'transcript',
          username:    speakerId,
          userId:      speakerId,
          delayMs:     decision.delayMs,
        });
      } catch (err) {
        log.error({ err, roomId }, 'Error in transcript handler');
      }
    });

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

    on(Events.REPLY_READY, async ({ roomId, text, trigger, usage }) => {
      if (isShuttingDown) {
        log.debug({ roomId }, 'Shutdown in progress — dropping queued reply');
        return;
      }

      const delayMs = trigger?.delayMs ?? 0;
      if (delayMs > 0) {
        log.debug({ roomId, delayMs }, '⌨️  Simulating typing delay');
        await sleep(delayMs);
      }

      if (isShuttingDown) return;

      try {
        
        const modResult = await moderation.check(text);
        if (!modResult.safe) {
          log.warn({ roomId, reason: modResult.reason }, 'Moderation flagged reply — dropping');
          return;
        }

        await context.addBotReply(roomId, text);

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

    once(Events.BOT_SHUTDOWN, () => {
      stop('BOT_SHUTDOWN event').catch((err) => log.error({ err }, 'Shutdown error'));
    });
  }

  async function start() {
    log.info('═══════════════════════════════════════════');
    log.info('  Roxstar AI Bot — starting up');
    log.info('═══════════════════════════════════════════');
    log.info({ room: config.livekit.roomName, bot: config.livekit.botIdentity }, 'Config loaded');

    log.info('Connecting to Redis...');
    redis = await createRedisClient(config.redis.url);
    log.info({ url: config.redis.url }, '✓ Redis connected');

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

    moderation = createModerationService({ groqKey: config.groq.apiKey });
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
      await stt.init();
      log.debug('✓ STTService');
    }

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

    replyPublisher = createReplyPublisher({
      roomRef,
      botIdentity:    config.livekit.botIdentity,
      botDisplayName: config.livekit.botDisplayName,
      sendMode:       'chat',
    });
    log.debug('✓ ReplyPublisher');

    log.info('Wiring EventBus...');
    wireEvents();
    log.info('✓ EventBus wired');

    log.info({ room: config.livekit.roomName }, 'Connecting to LiveKit room...');
    await connector.connect();

    if (connector.getRoom) roomRef.room = connector.getRoom();

    log.info('═══════════════════════════════════════════');
    log.info('  Bot is live. Listening...');
    log.info('═══════════════════════════════════════════');
  }

  async function stop(reason = 'unknown') {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info({ reason }, 'Shutting down bot...');

    unwireEvents();

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

    roomRef.room = null;

    log.info('Bot stopped cleanly. Goodbye.');
    await sleep(200);
    process.exit(0);
  }

  return { start, stop };
}

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
