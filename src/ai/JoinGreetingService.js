import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';

const log = logger.child({ module: 'JoinGreetingService' });

export function createJoinGreetingService(config) {
  const { groqAdapter, personaMemory, botPersona } = config;

  if (!groqAdapter)    throw new Error('JoinGreetingService: groqAdapter is required');
  if (!personaMemory)  throw new Error('JoinGreetingService: personaMemory is required');
  if (!botPersona)     throw new Error('JoinGreetingService: botPersona is required');

  let hasGreeted = false;

  async function onRoomConnected({ roomId }) {
    if (hasGreeted) {
      log.debug({ roomId }, 'Join greeting already sent or scheduled, skipping');
      return;
    }
    hasGreeted = true;

    log.info({ roomId }, 'Triggering join greeting in 3 seconds');

    setTimeout(async () => {
      try {
        const persona = personaMemory.getPersona(botPersona);
        const systemPrompt = `You are ${persona.displayName} from ${persona.location}. You just joined the live stream room as a viewer.
Write a very short, simple, polite and natural greeting in Hinglish (Hindi written in English alphabet).
Keep it extremely simple and natural, like "Namaste, kaise hain aap?" or "Namaste, kaise ho aap?".
Do NOT use literal translations, technical terms, or complex/weird vocabulary (e.g. do not use words like "abhivyakti", "darr", etc.).
Keep it under 6 words. Reply with ONLY the greeting string.`;

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
