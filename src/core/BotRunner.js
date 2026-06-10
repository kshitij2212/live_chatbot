import '../utils/patchLiveKit.js';
import 'dotenv/config';

import bus, { Events }           from './EventBus.js';
import logger                    from '../utils/logger.js';
import config                    from '../../config/default.js';

import { createLiveKitConnector }  from '../realtime/LiveKitConnector.js';
import { createSocketIOConnector }   from '../realtime/SocketIOConnector.js';
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
import { createGroqGateCheck }     from '../ai/GroqGateCheck.js';
import { createJoinGreetingService } from '../ai/JoinGreetingService.js';
import { createTranscriptProcessor } from '../comments/TranscriptProcessor.js';
import { createCommentProcessor }    from '../comments/CommentProcessor.js';
import { createReplyProcessor }      from '../realtime/ReplyProcessor.js';
import { createAudioPipeline }       from '../audio/AudioPipeline.js';
import '../comments/CommentParser.js';

const log = logger.child({ module: 'BotRunner' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBotRunner() {

  let livekitConnector = null;
  let socketIOConnector = null;
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
  let audioPipeline   = null;
  let commentFilter   = null;
  let commentListener = null;
  let gateCheck       = null;
  let groqAdapter     = null;
  let joinGreeting    = null;
  let transcriptProcessor = null;
  let commentProcessor    = null;
  let replyProcessor      = null;
  let isShuttingDown  = false;

  const roomRef = { room: null };
  const connectorRef = { connector: null };

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
      context.clearRoom(roomId)
        .then(() => {
          return context.setMeta(roomId, {
            roomName,
            botUserId: config.livekit.botIdentity,
            startedAt: new Date().toISOString(),
          });
        })
        .catch((err) => log.warn({ err }, 'Failed to clear context or set room meta'));
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
    const arg = process.argv[2];
    if (arg && !arg.startsWith('-')) {
      const botId = arg.endsWith('-bot') ? arg : `${arg}-bot`;
      config.livekit.botPersona = botId;
    }

    const activePersona = config.livekit.botPersona;
    const blockedUserIds = [];
    if (activePersona.includes('shivam')) {
      config.socket.userId = Number(process.env.SOCKET_USER_ID_SHIVAM ?? '3');
      config.livekit.botIdentity = process.env.BOT_IDENTITY_SHIVAM ?? 'shivam-bot';
      config.livekit.botDisplayName = process.env.BOT_DISPLAY_NAME_SHIVAM ?? 'Shivam';
      blockedUserIds.push('2', 'aman', 'aman-bot');
    } else if (activePersona.includes('aman')) {
      config.socket.userId = Number(process.env.SOCKET_USER_ID_AMAN ?? '2');
      config.livekit.botIdentity = process.env.BOT_IDENTITY_AMAN ?? 'aman-bot';
      config.livekit.botDisplayName = process.env.BOT_DISPLAY_NAME_AMAN ?? 'Aman';
      blockedUserIds.push('3', 'shivam', 'shivam-bot');
    }

    log.info('═══════════════════════════════════════════');
    log.info('  Roxstar AI Bot — starting up');
    log.info('═══════════════════════════════════════════');
    log.info({ room: config.livekit.roomName, bot: config.livekit.botIdentity, persona: config.livekit.botPersona }, 'Config loaded');

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
      unifiedRoomId:        config.livekit.roomName,
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

    const useLiveKit = config.realtime.provider === 'livekit' || config.realtime.provider === 'both';
    const useSocketIO = config.realtime.provider === 'socketio' || config.realtime.provider === 'both';

    contextBuilder = createContextBuilder({
      contextMemory: context,
      personaMemory: persona,
      promptBuilder,
      roomRef,
      botId:         useLiveKit ? config.livekit.botPersona : (config.livekit.botPersona || 'zara-bot'),
    });
    log.debug('✓ ContextBuilder');

    responseParser = createResponseParser({ maxReplyChars: 300 });
    log.debug('✓ ResponseParser');

    groqAdapter = createGroqAdapter({
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

    gateCheck = createGroqGateCheck({ groqAdapter, botName: config.livekit.botDisplayName });
    log.debug('✓ GroqGateCheck');

    joinGreeting = createJoinGreetingService({
      redis,
      groqAdapter,
      personaMemory: persona,
      botPersona:    useLiveKit ? config.livekit.botPersona : (config.livekit.botPersona || 'zara-bot'),
    });
    joinGreeting.init();
    log.debug('✓ JoinGreetingService');

    moderation = createModerationService({ groqKey: config.groq.apiKey });
    log.debug('✓ ModerationService');

    commentFilter = createCommentFilter({
      minLength:            config.commentFilter.minLength,
      maxLength:            config.commentFilter.maxLength,
      rateLimitWindowMs:    config.commentFilter.rateLimitWindowMs,
      rateLimitMaxMessages: config.commentFilter.rateLimitMaxMessages,
      blockedUserIds,
    });
    log.debug('✓ CommentFilter');

    commentListener = createCommentListener();
    log.debug('✓ CommentListener');

    if (useLiveKit) {
      const audioStage = Number(process.env.AUDIO_PIPELINE_STAGE ?? '0');
      audioPipeline = createAudioPipeline({
        stage:      audioStage,
        groqApiKey: process.env.WHISPER_API_KEY ?? config.groq.apiKey,
        sttMinRms:  config.livekit.sttMinRms,
      });
      await audioPipeline.init();
    }

    if (useLiveKit) {
      livekitConnector = createLiveKitConnector({
        url:                 config.livekit.url,
        apiKey:              config.livekit.apiKey,
        apiSecret:           config.livekit.apiSecret,
        tokenApiUrl:         config.livekit.tokenApiUrl,
        roomName:            config.livekit.roomName,
        botIdentity:         config.livekit.botIdentity,
        botDisplayName:      config.livekit.botDisplayName,
        reconnectAttempts:   config.livekit.reconnect.attempts,
        reconnectBaseMs:     config.livekit.reconnect.baseMs,
        reconnectMaxMs:      config.livekit.reconnect.maxMs,
        connectTimeoutMs:    config.livekit.connectTimeoutMs,
        disconnectTimeoutMs: config.livekit.disconnectTimeoutMs,
      });
      log.debug('✓ LiveKitConnector');
    }

    if (useSocketIO) {
      socketIOConnector = createSocketIOConnector({
        url:                  config.socket.url,
        path:                 config.socket.path,
        reconnectionAttempts: config.socket.reconnectionAttempts,
        timeout:              config.socket.timeout,
        liveId:               config.socket.liveId,
        userId:               config.socket.userId,
        broadcasterId:        config.socket.broadcasterId,
        redis,
      });
      log.debug('✓ SocketIOConnector');
    }

    replyPublisher = createReplyPublisher({
      roomRef,
      connectorRef,
      botIdentity:    useSocketIO ? String(config.socket.userId) : config.livekit.botIdentity,
      botDisplayName: useSocketIO ? String(config.socket.userId) : config.livekit.botDisplayName,
      sendMode:       useSocketIO ? 'socket_io' : 'chat',
    });
    log.debug('✓ ReplyPublisher');

    if (useLiveKit) {
      transcriptProcessor = createTranscriptProcessor({
        context,
        behavior,
        gateCheck,
        roomRef,
        botIdentity:    config.livekit.botIdentity,
        botDisplayName: config.livekit.botDisplayName,
        blockedUserIds,
      });
      transcriptProcessor.init();
      log.debug('✓ TranscriptProcessor');
    }

    commentProcessor = createCommentProcessor({
      context,
      behavior,
    });
    commentProcessor.init();
    log.debug('✓ CommentProcessor');

    replyProcessor = createReplyProcessor({
      context,
      moderation,
    });
    replyProcessor.init();
    log.debug('✓ ReplyProcessor');

    log.info('Wiring EventBus...');
    wireEvents();
    log.info('✓ EventBus wired');

    if (useLiveKit) {
      log.info({ room: config.livekit.roomName }, 'Connecting to LiveKit room...');
      await livekitConnector.connect();
      if (livekitConnector.getRoom) roomRef.room = livekitConnector.getRoom();
    }
    if (useSocketIO) {
      log.info({ url: config.socket.url }, 'Connecting to Socket.io server...');
      connectorRef.connector = socketIOConnector;
      await socketIOConnector.connect();
    }

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
    transcriptProcessor?.destroy();
    commentProcessor?.destroy();
    replyProcessor?.destroy();
    joinGreeting?.destroy();
    contextBuilder?.destroy();
    replyPublisher?.destroy();
    commentFilter?.destroy();
    commentListener?.destroy();
    audioPipeline?.destroy();

    if (livekitConnector) {
      await livekitConnector.disconnect().catch((err) => log.warn({ err }, 'LiveKitConnector disconnect error'));
    }
    if (socketIOConnector) {
      await socketIOConnector.disconnect().catch((err) => log.warn({ err }, 'SocketIOConnector disconnect error'));
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
