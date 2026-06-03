/**
 * PersonaMemoryService
 *
 * Loads bot persona configs from config/personas/*.json and serves them
 * by botId. No Redis — personas are static config, not runtime state.
 *
 * Multi-persona ready: each bot has its own JSON file with a unique botId.
 * BotRunner passes the botId at startup; everything downstream calls
 * getPersona(botId) to get the full persona object.
 *
 * config/personas/
 *   arjun.json
 *   riya.json
 *   rocky.json
 *
 * Each file must have a "botId" field matching the filename (by convention).
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'PersonaMemoryService' });

// Resolved at module load time — personas/ is always relative to project root
const PERSONAS_DIR = resolve(process.cwd(), 'config', 'personas');

/**
 * @typedef {object} PersonaReplyStyle
 * @property {number}   maxSentences
 * @property {boolean}  useEmojis
 * @property {string}   emojiFrequency   - 'rare' | 'occasional' | 'frequent'
 * @property {boolean}  usesFillerWords
 * @property {string[]} exampleReplies
 */

/**
 * @typedef {object} Persona
 * @property {string}            botId
 * @property {string}            displayName
 * @property {string}            location
 * @property {number}            age
 * @property {string}            language
 * @property {object}            personality
 * @property {string[]}          interests
 * @property {string}            backstory
 * @property {PersonaReplyStyle} replyStyle
 */

export function createPersonaMemory() {
  // Cache: botId → Persona object
  // Loaded lazily on first getPersona() call, then cached for the process lifetime.
  const cache = new Map();

  /**
   * Load and parse a persona JSON file by botId.
   * Throws if the file doesn't exist or is malformed.
   *
   * @param {string} botId
   * @returns {Persona}
   */
  function load(botId) {
    const filePath = join(PERSONAS_DIR, `${botId}.json`);

    let raw;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`PersonaMemory: persona file not found for botId "${botId}" at ${filePath}`);
    }

    let persona;
    try {
      persona = JSON.parse(raw);
    } catch (err) {
      throw new Error(`PersonaMemory: failed to parse persona JSON for botId "${botId}": ${err.message}`);
    }

    // Sanity check — botId in file must match the filename
    if (persona.botId !== botId) {
      throw new Error(
        `PersonaMemory: botId mismatch in ${filePath} — file says "${persona.botId}", expected "${botId}"`
      );
    }

    validatePersona(persona, botId);

    log.info({ botId, displayName: persona.displayName }, 'Persona loaded');
    return persona;
  }

  /**
   * Basic validation — catch missing required fields early, not mid-conversation.
   * @param {object} persona
   * @param {string} botId
   */
  function validatePersona(persona, botId) {
    const required = ['botId', 'displayName', 'location', 'language', 'personality', 'interests', 'backstory', 'replyStyle'];
    for (const field of required) {
      if (persona[field] == null) {
        throw new Error(`PersonaMemory: persona "${botId}" is missing required field "${field}"`);
      }
    }
    if (!Array.isArray(persona.interests) || persona.interests.length === 0) {
      throw new Error(`PersonaMemory: persona "${botId}" interests must be a non-empty array`);
    }
    if (!Array.isArray(persona.replyStyle?.exampleReplies)) {
      throw new Error(`PersonaMemory: persona "${botId}" replyStyle.exampleReplies must be an array`);
    }
  }

  /**
   * Get a persona by botId. Loads from disk on first call, then returns cached.
   *
   * @param {string} botId
   * @returns {Persona}
   */
  function getPersona(botId) {
    if (!cache.has(botId)) {
      const persona = load(botId);
      cache.set(botId, persona);
    }
    return cache.get(botId);
  }

  /**
   * Pre-load a persona into cache at startup.
   * BotRunner calls this so any config errors surface immediately,
   * not mid-stream on the first LLM call.
   *
   * @param {string} botId
   */
  function preload(botId) {
    getPersona(botId);
  }

  /**
   * List all available persona IDs by scanning the personas directory.
   * Useful for admin tooling / debug endpoints.
   *
   * @returns {string[]}
   */
  function listAvailable() {
    try {
      return readdirSync(PERSONAS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch (err) {
      log.error({ err }, 'PersonaMemory: failed to list personas');
      return [];
    }
  }

  return { getPersona, preload, listAvailable };
}