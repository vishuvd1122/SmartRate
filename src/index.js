const rateLimit = require("./rateLimit.js");
const RateLimiter = require("./middleware/rateLimiter.js");

// Storage engines
const StorageInterface = require("./storage/storageInterface.js");
const RedisStore = require("./storage/redisStore.js");
const MemoryStore = require("./storage/memoryStore.js");

// Algorithms
const BaseAlgorithm = require("./algorithms/baseAlgorithm.js");
const FixedWindow = require("./algorithms/fixedWindow.js");
const TokenBucket = require("./algorithms/tokenBucket.js");
const SlidingWindowLog = require("./algorithms/slidingWindowLog.js");
const LeakyBucket = require("./algorithms/leakyBucket.js");

// Clock & Errors
const SystemClock = require("./clock/systemClock.js");
const {
  RateLimitError,
  StorageError,
  ConcurrencyContentionError,
} = require("./errors/errors.js");

/**
 * Demo server for local testing when run directly via:
 * `node src/index.js` or `npm run dev`
 */
async function startServer() {
  const express = require("express");
  const { createClient } = require("redis");

  const app = express();
  app.use(express.json());
  app.set("trust proxy", true);

  // 1. Initialize Redis Client
  const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisClient.on("error", (err) => console.error("Redis Client Error:", err));

  try {
    await redisClient.connect();
    console.log("Connected to Redis successfully");
  } catch (err) {
    console.error("Failed to connect to Redis:", err.message);
    process.exit(1);
  }

  // 2. Configure and attach RateLimiter middleware using the rateLimit factory
  const limiter = rateLimit({
    redis: redisClient,
    algorithm: "token-bucket",
    capacity: 5,
    refillRate: 0.25, // 1 token every 4 seconds
  });
  app.use(limiter);

  app.get("/", (req, res) => {
    res.json({
      success: true,
      message: "Request is approved!",
    });
  });

  const PORT = process.env.PORT || 6969;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Start server when run directly: `node src/index.js`
if (require.main === module) {
  startServer();
}

// Primary export: high-level factory function
module.exports = rateLimit;
module.exports.rateLimit = rateLimit;

// Core Middleware
module.exports.RateLimiter = RateLimiter;

// Base Classes & Interfaces
module.exports.StorageInterface = StorageInterface;
module.exports.BaseAlgorithm = BaseAlgorithm;
module.exports.SystemClock = SystemClock;

// Storage Backends
module.exports.RedisStore = RedisStore;
module.exports.MemoryStore = MemoryStore;

// Concrete Algorithms
module.exports.FixedWindow = FixedWindow;
module.exports.TokenBucket = TokenBucket;
module.exports.SlidingWindowLog = SlidingWindowLog;
module.exports.LeakyBucket = LeakyBucket;

// Errors
module.exports.RateLimitError = RateLimitError;
module.exports.StorageError = StorageError;
module.exports.ConcurrencyContentionError = ConcurrencyContentionError;
