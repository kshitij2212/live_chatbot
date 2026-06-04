import logger from '../utils/logger.js';

const log = logger.child({ module: 'CooldownManager' });

const KEY_PREFIX = 'bot:cooldown:';

export class CooldownManager {
  
  constructor(redis, { cooldownSeconds = 10 } = {}) {
    if (!redis) throw new Error('CooldownManager: redis client is required');
    this.redis = redis;
    this.ttl   = cooldownSeconds;
  }

  async isOnCooldown(roomId) {
    const key    = `${KEY_PREFIX}${roomId}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  async setCooldown(roomId) {
    if (this.ttl <= 0) return;
    const key = `${KEY_PREFIX}${roomId}`;
    await this.redis.set(key, '1', 'EX', this.ttl);
    log.debug({ roomId, ttlSeconds: this.ttl }, 'Cooldown armed');
  }

  async clearCooldown(roomId) {
    await this.redis.del(`${KEY_PREFIX}${roomId}`);
    log.debug({ roomId }, 'Cooldown cleared');
  }
}
