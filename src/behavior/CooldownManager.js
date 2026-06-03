import logger from '../utils/logger.js';

const log = logger.child({ module: 'CooldownManager' });

const KEY_PREFIX = 'bot:cooldown:';

/**
 * Manages per-room reply cooldowns in Redis.
 *
 * After the bot replies in a room, setCooldown() sets a short-lived Redis key.
 * isOnCooldown() checks for that key — if it exists, the bot stays silent until
 * the TTL expires. This prevents reply storms when many events arrive at once.
 */
export class CooldownManager {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {object} [config]
   * @param {number} [config.cooldownSeconds] - Silence window after each reply (default 10s)
   */
  constructor(redis, { cooldownSeconds = 10 } = {}) {
    if (!redis) throw new Error('CooldownManager: redis client is required');
    this.redis = redis;
    this.ttl   = cooldownSeconds;
  }

  /**
   * Returns true if the room is currently under cooldown.
   * @param {string} roomId
   * @returns {Promise<boolean>}
   */
  async isOnCooldown(roomId) {
    const key    = `${KEY_PREFIX}${roomId}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Arms the cooldown for this room.
   * The key expires automatically after config.cooldownSeconds.
   * @param {string} roomId
   */
  async setCooldown(roomId) {
    const key = `${KEY_PREFIX}${roomId}`;
    await this.redis.set(key, '1', 'EX', this.ttl);
    log.debug({ roomId, ttlSeconds: this.ttl }, 'Cooldown armed');
  }

  /**
   * Clears the cooldown immediately.
   * Useful for testing or admin overrides.
   * @param {string} roomId
   */
  async clearCooldown(roomId) {
    await this.redis.del(`${KEY_PREFIX}${roomId}`);
    log.debug({ roomId }, 'Cooldown cleared');
  }
}
