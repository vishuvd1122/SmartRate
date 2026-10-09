const MemoryStore = require("./storage/memoryStore");
const RedisStore = require("./storage/redisStore");
const FixedWindow = require("./algorithms/fixedWindow");
const TokenBucket = require("./algorithms/tokenBucket");
const SlidingWindowLog = require("./algorithms/slidingWindowLog");
const LeakyBucket = require("./algorithms/leakyBucket");
const RateLimiter = require("./middleware/rateLimiter");

/**
 * High-level factory function providing an express-rate-limit style API.
 * Encapsulates store resolution, algorithm instantiation, and middleware creation
 * into a single intuitive configuration call.
 *
 * @param {Object} [options={}] - Rate limiter configuration options
 * @param {number} [options.limit=5] - Maximum requests allowed per window (alias: max, capacity)
 * @param {number} [options.windowMs=60000] - Window duration in milliseconds (alias: window)
 * @param {string|Object} [options.algorithm="fixed-window"] - Algorithm type or custom algorithm instance
 * @param {Object} [options.redis] - Redis client instance (automatically creates RedisStore)
 * @param {Object} [options.store] - Explicit StorageInterface instance (MemoryStore, RedisStore, etc.)
 * @param {string} [options.prefix="rateLimit:"] - Key prefix for Redis store
 * @param {Function} [options.keyGenerator] - Custom function (req) => identifier
 * @param {boolean} [options.failOpen=false] - Whether to allow requests on storage failure
 * @param {number} [options.cost=1] - Cost per request
 * @param {number} [options.refillRate] - Refill rate for Token Bucket (tokens/sec)
 * @param {number} [options.leakRate] - Leak rate for Leaky Bucket (units/sec)
 * @returns {Function} Express middleware (req, res, next)
 */
function rateLimit(options = {}) {
  // 1. Resolve Storage
  let store;
  if (options.store) {
    store = options.store;
  } else if (options.redis || options.client) {
    const redisClient = options.redis || options.client;
    store = new RedisStore(redisClient, {
      prefix: options.prefix !== undefined ? options.prefix : "rateLimit:",
      maxRetries: options.maxRetries !== undefined ? options.maxRetries : 3,
      retryDelayMs: options.retryDelayMs !== undefined ? options.retryDelayMs : 10,
      ...options.redisOptions,
    });
  } else {
    store = new MemoryStore();
  }

  // 2. Resolve Window & Limits
  const limit =
    options.limit !== undefined
      ? options.limit
      : options.max !== undefined
      ? options.max
      : options.capacity !== undefined
      ? options.capacity
      : 5;

  const windowMs =
    options.windowMs !== undefined
      ? options.windowMs
      : options.window !== undefined
      ? options.window
      : 60000;

  const cost = options.cost !== undefined ? options.cost : 1;

  // 3. Resolve Algorithm
  let algorithm;
  if (
    typeof options.algorithm === "object" &&
    options.algorithm !== null &&
    typeof options.algorithm.check === "function"
  ) {
    algorithm = options.algorithm;
  } else {
    const algoType = String(options.algorithm || "fixed-window")
      .toLowerCase()
      .replace(/[-_]/g, "");

    switch (algoType) {
      case "tokenbucket": {
        const capacity = options.capacity !== undefined ? options.capacity : limit;
        const refillRate =
          options.refillRate !== undefined
            ? options.refillRate
            : capacity / (windowMs / 1000);

        algorithm = new TokenBucket(
          {
            capacity,
            refillRate,
            cost,
            ...options.algorithmOptions,
          },
          store,
          options.clock
        );
        break;
      }

      case "slidingwindowlog":
      case "slidinglog": {
        algorithm = new SlidingWindowLog(
          {
            limit,
            window: windowMs,
            cost,
            ...options.algorithmOptions,
          },
          store,
          options.clock
        );
        break;
      }

      case "leakybucket": {
        const capacity = options.capacity !== undefined ? options.capacity : limit;
        const leakRate =
          options.leakRate !== undefined
            ? options.leakRate
            : capacity / (windowMs / 1000);

        algorithm = new LeakyBucket(
          {
            capacity,
            leakRate,
            cost,
            ...options.algorithmOptions,
          },
          store,
          options.clock
        );
        break;
      }

      case "fixedwindow":
      default: {
        algorithm = new FixedWindow(
          {
            limit,
            window: windowMs,
            cost,
            ...options.algorithmOptions,
          },
          store,
          options.clock
        );
        break;
      }
    }
  }

  // 4. Resolve Key Generator (default: rateLimit:user:<cleanIp>)
  const keyGenerator =
    options.keyGenerator ||
    ((req) => `rateLimit:user:${RateLimiter.getClientIp(req)}`);

  // 5. Instantiate RateLimiter Middleware
  const limiter = new RateLimiter(algorithm, {
    keyGenerator,
    clock: options.clock,
    failOpen: options.failOpen,
  });

  const middleware = limiter.middleware();

  // Expose underlying instances for testing or programmatic introspection
  middleware.limiter = limiter;
  middleware.store = store;
  middleware.algorithm = algorithm;

  return middleware;
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;

