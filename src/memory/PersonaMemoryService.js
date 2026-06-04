import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'PersonaMemoryService' });

const PERSONAS_DIR = resolve(process.cwd(), 'config', 'personas');

export function createPersonaMemory() {
  
  const cache = new Map();

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

    if (persona.botId !== botId) {
      throw new Error(
        `PersonaMemory: botId mismatch in ${filePath} — file says "${persona.botId}", expected "${botId}"`
      );
    }

    validatePersona(persona, botId);

    log.info({ botId, displayName: persona.displayName }, 'Persona loaded');
    return persona;
  }

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

  function getPersona(botId) {
    if (!cache.has(botId)) {
      const persona = load(botId);
      cache.set(botId, persona);
    }
    return cache.get(botId);
  }

  function preload(botId) {
    getPersona(botId);
  }

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
