const StorageInterface = require("./storageInterface");
const { StorageError, ConcurrencyContentionError } = require("../errors/errors");

/**
 * Internal error wrapper to safely transport reducer/algorithm exceptions
 * across async client isolation boundaries without confusing them with Redis storage errors.
 */
class ReducerExecutionError extends Error {
  constructor(originalError) {
    super();
    this.originalError = originalError;
  }
}

/**
 * RedisStore: Production-grade Redis storage adapter for SmartRate.
 * Implements connection-isolated Optimistic Concurrency Control (WATCH / MULTI / EXEC)
 * to provide atomic, distributed rate limiting across all algorithms.
 *
 * Supported Redis Clients:
 * - node-redis (v4+) via `client.executeIsolated()`
 * - ioredis via `client.duplicate()`
 *
 * Fails fast if the provided client cannot guarantee connection isolation.
 */
class RedisStore extends StorageInterface {
  /**
   * @param {Object} redisClient - An ioredis or redis (node-redis v4+) client instance.
   * @param {Object} [options={}]
   * @param {string} [options.prefix="smartrate:"] - Prefix for all Redis keys.
   * @param {number} [options.maxRetries=3] - Maximum retry attempts on concurrency conflict.
   * @param {number} [options.retryDelayMs=10] - Base delay in ms for exponential backoff with jitter.
   * @param {boolean} [options.ownsClient=false] - If true, close() shuts down the injected client.
   */
  constructor(redisClient, options = {}) {
    super();
    this.client = redisClient;
    this.prefix = options.prefix !== undefined ? options.prefix : "smartrate:";
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.retryDelayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : 10;
    this.ownsClient = options.ownsClient === true;
  }

  _ensureClient() {
    if (!this.client) {
      throw new StorageError("Redis client not configured");
    }
  }

  /**
   * Resolves a key with the configured prefix idempotently.
   * If prefix is empty or key already starts with prefix, key is unchanged.
   */
  _resolveKey(key) {
    if (!this.prefix) {
      return String(key);
    }
    const strKey = String(key);
    if (strKey.startsWith(this.prefix)) {
      return strKey;
    }
    return `${this.prefix}${strKey}`;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Serializes a JavaScript value to string for Redis storage.
   * Enforces strict serialization contract: rejects BigInt, Symbol, Function,
   * and circular structures with StorageError.
   */
  _serialize(value, key) {
    if (value === undefined) return undefined;
    if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
      throw new StorageError(`Value for key "${key}" contains non-serializable type (${typeof value})`);
    }
    try {
      return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    } catch (err) {
      throw new StorageError(`Value for key "${key}" is not JSON-serializable`, err);
    }
  }

  /**
   * Deserializes raw string from Redis.
   * Returns null if missing. Throws StorageError if data is corrupted/unparseable.
   */
  _deserialize(raw, key) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new StorageError(`Corrupted state encountered in Redis for key "${key}"`, err);
    }
  }

  /**
   * Acquires a dedicated/isolated connection for an OCC transaction.
   * - In node-redis v4+, uses `client.executeIsolated()`.
   * - In ioredis, uses `client.duplicate()` with proper lifecycle cleanup.
   * - Fails fast if the client does not support transaction isolation.
   */
  async _withIsolatedClient(fn) {
    if (typeof this.client.executeIsolated === "function") {
      return this.client.executeIsolated(fn);
    }
    if (typeof this.client.duplicate === "function") {
      const isolated = this.client.duplicate();
      if (typeof isolated.connect === "function") {
        await isolated.connect();
      }
      try {
        return await fn(isolated);
      } finally {
        if (typeof isolated.quit === "function") {
          await isolated.quit().catch(() => {});
        } else if (typeof isolated.disconnect === "function") {
          isolated.disconnect();
        }
      }
    }
    // Fail fast: do not silently downgrade to shared client for WATCH transactions
    throw new StorageError(
      "Redis client does not support transaction isolation. node-redis v4+ (executeIsolated) or ioredis (duplicate) is required."
    );
  }

  async get(key) {
    this._ensureClient();
    const resolvedKey = this._resolveKey(key);
    try {
      const raw = await this.client.get(resolvedKey);
      return this._deserialize(raw, key);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to get key "${key}" from Redis`, err);
    }
  }

  /**
   * Dispatches a SET command with TTL to either node-redis (v4+) or ioredis.
   * - In node-redis (v4+), options are passed as an object: `{ PX: ttlMs }`.
   * - In ioredis, arguments are passed as positional strings: `'PX', ttlMs`.
   *
   * @param {Object} clientOrMulti - Redis client or MULTI pipeline
   * @param {string} key - Resolved storage key
   * @param {string} value - Serialized value string
   * @param {number} [ttlMs] - Time-to-live in milliseconds
   */
  _applySet(clientOrMulti, key, value, ttlMs) {
    if (!ttlMs || ttlMs <= 0) {
      return clientOrMulti.set(key, value);
    }

    const roundedTtl = Math.ceil(ttlMs);

    // Detect node-redis (v4+) via executeIsolated or connection state properties
    const isNodeRedis =
      typeof this.client.executeIsolated === "function" ||
      this.client.isOpen !== undefined ||
      this.client.isReady !== undefined;

    if (isNodeRedis) {
      return clientOrMulti.set(key, value, { PX: roundedTtl });
    }

    // Default / ioredis style
    return clientOrMulti.set(key, value, "PX", roundedTtl);
  }

  async set(key, value, ttlMs) {
    this._ensureClient();
    if (value === undefined) {
      throw new StorageError(`Cannot set undefined for key "${key}"`);
    }
    const resolvedKey = this._resolveKey(key);
    const strVal = this._serialize(value, key);
    try {
      return await this._applySet(this.client, resolvedKey, strVal, ttlMs);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to set key "${key}" in Redis`, err);
    }
  }

  async delete(key) {
    this._ensureClient();
    const resolvedKey = this._resolveKey(key);
    try {
      return await this.client.del(resolvedKey);
    } catch (err) {
      throw new StorageError(`Failed to delete key "${key}" from Redis`, err);
    }
  }

  async reset(key) {
    return this.delete(key);
  }

  /**
   * Atomically increments a numeric key with non-refreshing TTL semantics.
   *
   * Contract:
   * - Key does not exist: initialized to `amount`. If `ttlMs > 0`, TTL is set to `ttlMs`.
   * - Key already exists: incremented by `amount`. Existing TTL is preserved (never refreshed).
   * - Non-numeric stored value: throws StorageError.
   * - Negative or zero amount: supported (decrements or returns unchanged).
   * - Concurrency: uses connection-isolated OCC with bounded retries.
   *
   * @param {string} key - Storage key.
   * @param {number} [amount=1] - Numeric amount to add.
   * @param {number} [ttlMs] - Time-to-live in ms for key creation only.
   * @returns {Promise<number>} The updated numeric counter value.
   */
  async increment(key, amount = 1, ttlMs) {
    this._ensureClient();
    if (typeof amount !== "number" || isNaN(amount)) {
      throw new StorageError(`increment amount must be a valid number, received ${amount}`);
    }

    const resolvedKey = this._resolveKey(key);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let outcome;
      try {
        outcome = await this._withIsolatedClient(async (isolatedClient) => {
          try {
            await isolatedClient.watch(resolvedKey);

            const [raw, pttl] = await Promise.all([
              isolatedClient.get(resolvedKey),
              typeof isolatedClient.pttl === "function" ? isolatedClient.pttl(resolvedKey) : -1,
            ]);

            let nextVal;
            const multi = isolatedClient.multi();

            if (raw === null || raw === undefined) {
              // Key does not exist
              nextVal = amount;
              this._applySet(multi, resolvedKey, String(nextVal), ttlMs);
            } else {
              // Key exists: validate numeric content and increment using native INCRBY
              // INCRBY strictly preserves the existing expiration deadline (zero TTL drift)
              const currentVal = Number(raw);
              if (isNaN(currentVal)) {
                throw new StorageError(`Key "${key}" contains non-numeric value "${raw}"`);
              }
              nextVal = currentVal + amount;
              multi.incrby(resolvedKey, amount);
            }

            const execResult = await multi.exec();
            if (execResult === null || execResult === undefined) {
              return { success: false, conflict: true };
            }
            return { success: true, result: nextVal };
          } catch (innerErr) {
            if (
              innerErr.name === "WatchError" ||
              innerErr?.constructor?.name === "WatchError"
            ) {
              return { success: false, conflict: true };
            }
            throw innerErr;
          } finally {
            await isolatedClient.unwatch().catch(() => {});
          }
        });
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Failed to increment key "${key}" in Redis`, err);
      }

      if (outcome.success) {
        return outcome.result;
      }

      if (outcome.conflict) {
        if (attempt === this.maxRetries) {
          throw new ConcurrencyContentionError(
            `RedisStore: Increment exceeded max retries (${this.maxRetries}) due to concurrent write contention.`
          );
        }
        const delay = this.retryDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 5);
        if (delay > 0) {
          await this._sleep(delay);
        }
      }
    }
  }

  /**
   * Atomically mutates JSON state in Redis using connection-isolated Optimistic Concurrency Control.
   *
   * @param {string} key - Storage key identifier.
   * @param {Function} reducerFn - Pure reducer: (currentState, now) => { nextState, result }.
   * @param {number} [ttlMs] - Time-to-live in milliseconds.
   * @param {number} [explicitNow] - Optional explicit timestamp for test/clock synchronization.
   * @returns {Promise<Object>} The `result` object returned by the reducer.
   */
  async mutate(key, reducerFn, ttlMs, explicitNow) {
    this._ensureClient();
    const resolvedKey = this._resolveKey(key);
    // Capture logical timestamp once per logical mutate() operation and reuse across all OCC retries
    const logicalNow = typeof explicitNow === "number" ? explicitNow : Date.now();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let outcome;

      try {
        outcome = await this._withIsolatedClient(async (isolatedClient) => {
          try {
            await isolatedClient.watch(resolvedKey);

            const raw = await isolatedClient.get(resolvedKey);
            const current = this._deserialize(raw, key);

            let nextState, result;
            try {
              const evaluated = reducerFn(current, logicalNow);

              nextState = evaluated.nextState;
              result = evaluated.result;
            } catch (fnErr) {
              throw new ReducerExecutionError(fnErr);
            }

            if (nextState === undefined) {
              await isolatedClient.unwatch().catch(() => {});
              return { success: true, result };
            }

            const strVal = this._serialize(nextState, key);

            const multi = isolatedClient.multi();
            this._applySet(multi, resolvedKey, strVal, ttlMs);

            const execResult = await multi.exec();

            // Native OCC collision detection:
            if (execResult === null || execResult === undefined) {
              return { success: false, conflict: true };
            }

            return { success: true, result };
          } catch (innerErr) {
            if (innerErr instanceof ReducerExecutionError) {
              throw innerErr;
            }
            if (
              innerErr.name === "WatchError" ||
              innerErr?.constructor?.name === "WatchError"
            ) {
              return { success: false, conflict: true };
            }
            throw innerErr;
          } finally {
            await isolatedClient.unwatch().catch(() => {});
          }
        });
      } catch (err) {
        // Reducer/algorithm errors are directly rethrown without wrapping
        if (err instanceof ReducerExecutionError) {
          throw err.originalError;
        }
        if (err instanceof StorageError) {
          throw err;
        }
        throw new StorageError(`Redis mutate failed for key "${key}"`, err);
      }

      if (outcome.success) {
        return outcome.result;
      }

      if (outcome.conflict) {
        if (attempt === this.maxRetries) {
          throw new ConcurrencyContentionError(
            `RedisStore: Mutate exceeded max retries (${this.maxRetries}) due to concurrent write contention.`
          );
        }
        // Bounded exponential backoff with small random jitter (2-10ms)
        const delay = this.retryDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 5);
        if (delay > 0) {
          await this._sleep(delay);
        }
      }
    }
  }

  async update(key, updaterFn, ttlMs, explicitNow) {
    return this.mutate(
      key,
      (currentState, now) => {
        const res = updaterFn(currentState, now);
        if (!res) return { nextState: undefined, result: res };
        return {
          nextState: res.state !== undefined ? res.state : res,
          result: res.result !== undefined ? res.result : res,
        };
      },
      ttlMs,
      explicitNow
    );
  }

  async eval(script, keys = [], args = []) {
    this._ensureClient();
    const resolvedKeys = keys.map((k) => this._resolveKey(k));
    try {
      if (typeof this.client.eval === "function") {
        try {
          return await this.client.eval(script, resolvedKeys.length, ...resolvedKeys, ...args);
        } catch (callErr) {
          return await this.client.eval(script, { keys: resolvedKeys, arguments: args });
        }
      }
      throw new StorageError("Redis client does not support eval()");
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError("Failed to execute eval script in Redis", err);
    }
  }

  async close() {
    if (this.ownsClient && this.client) {
      if (typeof this.client.quit === "function") {
        await this.client.quit().catch(() => {});
      } else if (typeof this.client.disconnect === "function") {
        this.client.disconnect();
      }
    }
  }
}

module.exports = RedisStore;