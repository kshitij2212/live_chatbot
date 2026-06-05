import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'JoinGreetingService' });

export function createJoinGreetingService(config) {
  const { groqAdapter, personaMemory, botPersona } = config;

  if (!groqAdapter)    throw new Error('JoinGreetingService: groqAdapter is required');
  if (!personaMemory)  throw new Error('JoinGreetingService: personaMemory is required');
  if (!botPersona)     throw new Error('JoinGreetingService: botPersona is required');

  async function onRoomConnected({ roomId }) {
    log.info({ roomId }, 'Triggering join greeting in 3 seconds');

    setTimeout(async () => {
      try {
        const persona = personaMemory.getPersona(botPersona);
        const systemPrompt = `You are ${persona.displayName} from ${persona.location}. You just joined the live stream room as a viewer.
Write a very short, casual, respectful and generic greeting in Hinglish (Hindi written in English alphabet). Keep it extremely short (under 7 words, e.g. "Hey! Kaise ho?" or "Hi bro, kya chal raha hai?").
Do not use emojis excessively. Reply with ONLY the greeting string.`;

        const messages = [{ role: 'system', content: systemPrompt }];
        const completion = await groqAdapter.complete(messages, { maxTokens: 60, temperature: 0.7 });
        const text = completion?.choices?.[0]?.message?.content?.trim()?.replace(/"/g, '') ?? '';

        if (text) {
          log.info({ text, roomId }, 'Publishing join greeting');
          bus.emit(Events.REPLY_READY, {
            roomId,
            text,
            trigger: { userId: 'system', username: 'system' }
          });
        }
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
