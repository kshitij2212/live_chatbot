import bus, { Events } from '../core/EventBus.js';
import logger          from '../utils/logger.js';
import { classifyTarget } from './UtteranceTargetFilter.js';

const log = logger.child({ module: 'TranscriptProcessor' });

export function createTranscriptProcessor(config) {
  const { context, behavior, gateCheck, botIdentity, botDisplayName } = config;

  if (!context)      throw new Error('TranscriptProcessor: context is required');
  if (!behavior)     throw new Error('TranscriptProcessor: behavior is required');
  if (!botIdentity)  throw new Error('TranscriptProcessor: botIdentity is required');

  async function onTranscriptReady({ roomId, text, speakerId }) {
    if (!text?.trim()) return;

    const cleanText = text.trim();

    const blacklist = /^(thank\s*you|bye|yeah|yes|ok|okay|yep|yup|nope|uh|um|uhh|umm|hmm|hm|mhm|erm|err|aa|ah|ahh|oh|ohh|eh|ee|oo|ooh|आँ|आं|हाँ|हां|हम्म|अह|ओ|ए|हे|अरे|अर्रे)$/i;

    const isZhaal = /^[झाल\s,;.!?-]+$/.test(cleanText);

    if (blacklist.test(cleanText) || isZhaal || cleanText.length <= 2) {
      log.debug({ roomId, text: cleanText }, 'Ignored short/filler/blacklisted transcript (likely noise/mumble)');
      return;
    }

    const targetResult = classifyTarget(text, [botIdentity, botDisplayName]);
    if (targetResult.shouldProcess === false) {
      log.info({ text, target: targetResult.target }, 'Transcript filtered out — addressing someone else / ambient');
      return;
    }

    if (targetResult.shouldProcess === true && targetResult.target === 'allowed') {

      if (gateCheck) {
        const gateResult = await gateCheck.check(text);
        if (gateResult.directed === 'person') {
          log.info({ text }, 'Groq gate determined utterance is directed at another person — ignoring');
          return;
        }
      }
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
  }

  function init() {
    bus.on(Events.TRANSCRIPT_READY, onTranscriptReady);
    log.info('TranscriptProcessor initialised');
  }

  function destroy() {
    bus.off(Events.TRANSCRIPT_READY, onTranscriptReady);
    log.debug('TranscriptProcessor destroyed');
  }

  return { init, destroy };
}
