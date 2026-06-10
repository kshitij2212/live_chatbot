import logger from '../utils/logger.js';

const log = logger.child({ module: 'UtteranceTargetFilter' });

const COMMON_NAMES = new Set([
  'शितिज', 'क्षितिज', 'शितिज़', 'क्षितिज़', 'क्षितीज', 'क्षितीज़', 'शिवम', 'शवाम',
  'आरव', 'अभिषेक', 'आदित्य', 'अदिति', 'अजय', 'आकाश', 'आलोक', 'अमित', 'अनन्या', 'अनिकेत',
  'अनिल', 'अंकित', 'अंकिता', 'अर्जुन', 'आर्यन', 'आशीष', 'अशोक', 'आयुष', 'चेतन', 'दीपक',
  'देव', 'दिव्या', 'दिया', 'एकता', 'गौरव', 'हर्ष', 'हर्षल', 'हरीश', 'इशान', 'इशआन', 'ज्योति',
  'काजल', 'कमल', 'करण', 'कार्तिक', 'काव्या', 'किरण', 'कीर्ति', 'कृति', 'कुणाल', 'मनीष',
  'मनोज', 'मयंक', 'मेघा', 'मीनाक्षी', 'मोहित', 'मोनिका', 'नमन', 'नेहा', 'नीतू', 'निखिल',
  'निशा', 'नितिन', 'पल्लवी', 'पंकज', 'पायल', 'पियूष', 'पूजा', 'प्रदीप', 'प्रणव', 'प्रेरणा',
  'प्रिया', 'राहुल', 'राज', 'राजेश', 'राखी', 'राशि', 'रवि', 'ऋषभ', 'ऋतिका', 'रिया',
  'रोहित', 'सचिन', 'साहिल', 'साक्षी', 'संदीप', 'संजय', 'सीमा', 'शालिनी', 'शिखा', 'श्रेया',
  'सिमरन', 'स्नेहा', 'सोनल', 'सौरभ', 'सुनील', 'सुरेश', 'स्वाति', 'तनिष', 'तन्वी', 'तुषार',
  'वरुण', 'विकास', 'विक्रम', 'विजय', 'विनय', 'विशाल', 'विवेक', 'यश'
]);

const VOCATIVE_PREFIX_RE = /\b(?:hey|hi|hello|arre|arey|oye|oyi|yo|ae|aye)\s+/gi;

const AT_MENTION_RE = /@(\w+)/g;

const LEADING_NAME_RE = /^([A-Z][a-z]{1,15})\s*[,!]/;

function extractNames(text, botSet = new Set()) {
  const found = new Set();

  for (const match of text.matchAll(AT_MENTION_RE)) {
    found.add(match[1].toLowerCase());
  }

  for (const match of text.matchAll(VOCATIVE_PREFIX_RE)) {
    const afterPrefix = text.slice(match.index + match[0].length);
    const wordMatch = afterPrefix.match(/^([a-zA-Z\u0900-\u097F]+)/);
    if (wordMatch) {
      const candidate = wordMatch[1].toLowerCase();
      if (COMMON_NAMES.has(candidate) || botSet.has(candidate) || /^[A-Z]/.test(wordMatch[1])) {
        found.add(candidate);
      }
    }
  }

  const leadMatch = text.match(LEADING_NAME_RE);
  if (leadMatch) {
    found.add(leadMatch[1].toLowerCase());
  }

  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-z\u0900-\u097F]/g, '');
    if (clean.length >= 2 && (COMMON_NAMES.has(clean) || botSet.has(clean))) {
      found.add(clean);
    }
  }

  return found;
}

const SECOND_PERSON_RE = /\b(tu|tum|tere|tera|teri|tumhara|tumhari|tumhe|tumhein|tujhe|tujhse|aap|aapka|aapki|aapko|aapse)\b|तू|तुम|तेरे|तेरा|तेरी|तुम्हारा|तुम्हारी|तुम्हें|तुझे|तुझसे|आप|आपका|आपकी|आपको|आपसे/iu;

const IMPERATIVE_DIRECT_RE = /\b(sun|suno|bol|bolo|bata|batao|dekh|dekho|chal|chalo|arre|arey|oye|oyi)\b|सुन|सुनो|बोल|बोलो|बता|बताओ|देख|देखो|चल|chalo|अरे/iu;

const AUDIENCE_RE = /\b(all|guys|everyone|sab|sabko|sablog|sab\s*log|logo|logon|dosto|doston|friends|chat|people|y'?all|bhai\s*log|bhailog)\b|सब|सबको|सबका|सबलोग|लोग|लोगो|लोगों|दोस्तों|दोस्त|चैट|भाईलोग/iu;

const ROOM_QUESTION_RE = /\b(koi\s+batao|koi\s+bolo|anyone\s+know|koi\s+hai|kisiko\s+pata|koi\s+suno|koi\s+bata)\b|कोई\s+बताओ|कोई\s+bolo|कोई\s+है|किसीको\s+पता|किसी\s+को\s+पता|कोई\s+सुनो|कोई\s+बता/iu;

const OTHER_PERSON_TERMS = /\b(didi|bhaiya|di|sis|sister|bro|brother)\b|दीदी|भैया|दी|ब्रदर/iu;

export function classifyTarget(text, botNames = []) {
  const botSet = new Set();
  for (const name of botNames) {
    if (!name) continue;
    const lower = name.toLowerCase();
    botSet.add(lower);
    const parts = lower.split(/\s+/);
    for (const part of parts) {
      if (part.length >= 2) botSet.add(part);
    }
  }

  if (botSet.has('aman')) {
    botSet.add('अमन');
    botSet.add('आमन');
    botSet.add('अमं');
    botSet.add('अमान');
    botSet.add('हमन');
  }
  if (botSet.has('shivam')) {
    botSet.add('शिवम');
    botSet.add('शवाम');
    botSet.add('शीवम');
    botSet.add('शवंम');
    botSet.add('शेबंबाई');
    botSet.add('शेबं');
    botSet.add('शिबम');
    botSet.add('शिवं');
    botSet.add('севм');
    botSet.add('सेवम');
    botSet.add('शेबम');
    botSet.add('शिवन');
    botSet.add('शिवा');
  }
  const names  = extractNames(text, botSet);

  const mentionsBot = [...names].some((n) => botSet.has(n));
  const hasOtherPersonTerm = OTHER_PERSON_TERMS.test(text);

  // ── Step 1: Named person or address check ──
  if (names.size > 0 || hasOtherPersonTerm) {
    if (mentionsBot) {
      log.debug({ text, names: [...names] }, 'Target: bot_direct (Aman named)');
      return { target: 'bot_direct', shouldProcess: true };
    }

    // Only other people named or addressed (like didi/bhaiya), Aman not mentioned — hard ignore.
    log.debug({ text, names: [...names], hasOtherPersonTerm }, 'Target: other_person');
    return { target: 'other_person', shouldProcess: false };
  }

  // ── Default: Allow all other comments (no other names are taken) ──
  log.debug({ text }, 'Target: allowed (no other names addressed)');
  return { target: 'allowed', shouldProcess: true };
}
