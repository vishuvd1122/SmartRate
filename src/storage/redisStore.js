const StorageInterface = require("./storageInterface");

class RedisStore extends StorageInterface {
  constructor(redisClient) {
    super();
    this.client = redisClient; // expect a redis/ioredis client instance
  }

  _ensureClient() {
    if (!this.client) {
      throw new Error("Redis client not configured");
    }
  }

  async get(key) {
    this._ensureClient();
    const raw = await this.client.get(key);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return raw;
    }
  }

  async set(key, value, ttlMs) {
    this._ensureClient();
    const strVal = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (ttlMs) {
      return this.client.set(key, strVal, "PX", ttlMs);
    }
    return this.client.set(key, strVal);
  }

  async delete(key) {
    this._ensureClient();
    return this.client.del(key);
  }

  async reset(key) {
    return this.delete(key);
  }

  async increment(key, amount = 1, ttlMs) {
    this._ensureClient();
    if (ttlMs) {
      const multi = this.client.multi();
      multi.incrby(key, amount);
      multi.pexpire(key, ttlMs);
      const results = await multi.exec();
      return results[0][1];
    }
    return this.client.incrby(key, amount);
  }

  /**
   * Atomically mutates the JSON state stored in Redis.
   */
  async mutate(key, reducerFn, ttlMs) {
    this._ensureClient();
    const raw = await this.client.get(key);
    let current = null;
    if (raw) {
      try {
        current = JSON.parse(raw);
      } catch {
        current = raw;
      }
    }

    const { nextState, result } = reducerFn(current);

    if (nextState !== undefined) {
      const strVal = typeof nextState === "object" ? JSON.stringify(nextState) : String(nextState);
      if (ttlMs) {
        await this.client.set(key, strVal, "PX", ttlMs);
      } else {
        await this.client.set(key, strVal);
      }
    }

    return result;
  }

  async eval(script, keys = [], args = []) {
    this._ensureClient();
    return this.client.eval(script, keys.length, ...keys, ...args);
  }
}

module.exports = RedisStore;

