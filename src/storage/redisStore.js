// Redis-backed store placeholder

// const Redis = require('ioredis');
const StorageInterface = require('./storageInterface');

class RedisStore extends StorageInterface {
  constructor(redisClient /* optional */) {
    super();
    this.client = redisClient; // expect a redis client instance
  }

  async increment(key, value = 1) {
    if (!this.client) throw new Error('Redis client not configured');
    return this.client.incrby(key, value);
  }

  async get(key) {
    if (!this.client) return null;
    return this.client.get(key);
  }

  async reset(key) {
    if (!this.client) return;
    return this.client.del(key);
  }
}

module.exports = RedisStore;
