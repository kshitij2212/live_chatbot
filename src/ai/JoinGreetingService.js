import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'JoinGreetingService' });

export function createJoinGreetingService(config) {
  const { redis, groqAdapter, personaMemory, botPersona } = config;

  if (!groqAdapter)    throw new Error('JoinGreetingService: groqAdapter is required');
  if (!personaMemory)  throw new Error('JoinGreetingService: personaMemory is required');
  if (!botPersona)     throw new Error('JoinGreetingService: botPersona is required');

  let localGreetCount = 0;
  let isGreetingPending = false;

  async function onRoomConnected({ roomId, room }) {
    if (isGreetingPending) {
      log.debug({ roomId }, 'Join greeting already pending, skipping');
      return;
    }
    isGreetingPending = true;

    let greetCount = localGreetCount;
    if (redis) {
      try {
        const val = await redis.get(`bot:${botPersona}:room:${roomId}:greetCount`);
        if (val !== null) {
          greetCount = parseInt(val, 10);
        }
      } catch (err) {
        log.warn({ err, roomId }, 'Failed to check greet count from Redis');
      }
    }

    if (greetCount >= 3) {
      log.debug({ roomId, greetCount }, 'Max greetings reached (1 original + 2 backs), skipping');
      isGreetingPending = false;
      return;
    }

    log.info({ roomId, greetCount }, 'Triggering join greeting in 3 seconds');

    setTimeout(async () => {
      isGreetingPending = false;
      try {
        let text = '';
        if (greetCount > 0) {
          text = "Hey I'm back";
        } else {
          let targetUser = '';

          if (room && room.remoteParticipants) {
            for (const [, participant] of room.remoteParticipants) {
              const identity = participant.identity?.trim() || '';
              let name = (participant.name || participant.identity)?.trim();
              if (name && !name.toLowerCase().includes('bot') && !identity.toLowerCase().includes('bot')) {
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

          if (botPersona.includes('shivam')) {
            if (targetUser) {
              text = `Hello ${targetUser} Ji`;
            } else {
              text = 'Hello';
            }
          } else if (botPersona.includes('abhishek')) {
            if (targetUser) {
              text = `Hey ${targetUser}`;
            } else {
              text = 'Hey';
            }
          } else {
            if (targetUser) {
              text = `Namaste ${targetUser} Ji`;
            } else {
              text = 'Namaste, kaise ho aap?';
            }
          }
        }

        const newCount = greetCount + 1;
        localGreetCount = newCount;
        if (redis) {
          try {
            await redis.set(`bot:${botPersona}:room:${roomId}:greetCount`, String(newCount), 'EX', 43200);
          } catch (err) {
            log.warn({ err, roomId }, 'Failed to update greet count in Redis');
          }
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
