/**
 * RedisClient
 *
 * Project-wide ioredis singleton.
 *
 * Roxstar main repo already uses ioredis — this wrapper reuses the same
 * library without introducing a second Redis connection or a second client
 * instance. BotRunner calls createRedisClient() once on startup and passes
 * the returned client to every service that needs it.
 *
 * Why a singleton and not a direct ioredis import?
 *  - One connection shared across all memory services
 *  - Startup readiness check (PING) before the bot joins any room
 *  - Consistent error logging across the project
 *  - Easy to swap the underlying library later if Roxstar migrates
 */

import Redis  from 'ioredis';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'RedisClient' });

/**
 * Create and connect an ioredis client.
 * Resolves when Redis responds to PING — guarantees the connection is live
 * before BotRunner continues startup.
 *
 * @param {string} url - Redis connection URL (e.g. redis://localhost:6379)
 * @returns {Promise<Redis>} Connected ioredis instance
 */
export async function createRedisClient(url) {
  if (!url?.trim()) {
    throw new Error('RedisClient: missing required config field "url"');
  }

  const client = new Redis(url, {
    // Don't hammer Redis with retries on startup failure —
    // let BotRunner's catch block handle it and exit cleanly.
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
    lazyConnect:          true,   // connect explicitly below, not on construction
  });

  client.on('error',       (err) => log.error({ err },    'Redis error'));
  client.on('reconnecting', ()   => log.warn({},           'Redis reconnecting'));
  client.on('ready',        ()   => log.info({ url },      'Redis ready'));

  await client.connect();

  // Verify the connection is actually live before returning
  const pong = await client.ping();
  if (pong !== 'PONG') {
    throw new Error('RedisClient: PING check failed after connect');
  }

  log.info({ url }, 'RedisClient connected');
  return client;
}