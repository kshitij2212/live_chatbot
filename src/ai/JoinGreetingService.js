import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'JoinGreetingService' });

export function createJoinGreetingService(config) {
  const { redis, groqAdapter, personaMemory, botPersona } = config;

  if (!groqAdapter)    throw new Error('JoinGreetingService: groqAdapter is required');
  if (!personaMemory)  throw new Error('JoinGreetingService: personaMemory is required');
  if (!botPersona)     throw new Error('JoinGreetingService: botPersona is required');

  let hasGreeted = false;

  async function onRoomConnected({ roomId, room }) {
    if (hasGreeted) {
      log.debug({ roomId }, 'Join greeting already sent or scheduled, skipping');
      return;
    }
    hasGreeted = true;

    log.info({ roomId }, 'Triggering join greeting in 3 seconds');

    setTimeout(async () => {
      try {
        let targetUser = '';

        if (room && room.remoteParticipants) {
          for (const [, participant] of room.remoteParticipants) {
            let name = (participant.name || participant.identity)?.trim();
            if (name && !name.toLowerCase().includes('bot')) {
              // If it is numeric (user ID), check Redis cache for username
              if (/^\d+$/.test(name) && redis) {
                try {
                  const cachedUser = await redis.get(`user:${name}`);
                  if (cachedUser) {
                    const userObj = JSON.parse(cachedUser);
                    if (userObj && userObj.username) {
                      name = userObj.username.trim();
                    }
                  }
                } catch (err) {
                  log.warn({ err, userId: name }, 'Failed to fetch user details from Redis cache');
                }
              }
              if (!/^\d+$/.test(name)) {
                targetUser = name.split(' ')[0];
              }
              break;
            }
          }
        }

        let text = '';
        if (targetUser) {
          text = `Namaste ${targetUser} Ji, kaise ho aap?`;
        } else {
          text = 'Namaste, kaise ho aap?';
        }

        log.info({ text, roomId }, 'Publishing join greeting');
        bus.emit(Events.REPLY_READY, {
          roomId,
          text,
          trigger: { userId: 'system', username: 'system' }
        });
      } catch (err) {
        log.error({ err, roomId }, 'Failed to generate join greeting');
      }
    }, 3000);
  }

  function init() {
    bus.on(Events.ROOM_CONNECTED, onRoomConnected);
    log.info('JoinGreetingService initialised');
  }

  function destroy() {
    bus.off(Events.ROOM_CONNECTED, onRoomConnected);
    log.debug('JoinGreetingService destroyed');
  }

  return { init, destroy };
}
