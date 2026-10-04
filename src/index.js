const express = require("express");
const { createClient } = require("redis");

const RedisStore = require("./storage/redisStore.js");
const FixedWindow = require("./algorithms/fixedWindow.js");
const TokenBucket = require("./algorithms/tokenBucket.js");
const SlidingWindowLog = require("./algorithms/slidingWindowLog.js");
const RateLimiter = require("./middleware/rateLimiter.js");

async function startServer() {
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

  // 2. Initialize RedisStore with connection isolation
  const store = new RedisStore(redisClient, {
    prefix: "rateLimit:",
    maxRetries: 3,
    retryDelayMs: 10,
  });

  // 3. Configure the rate limiting algorithm
  const tokenBucket = new TokenBucket(
    {
      capacity: 5,
      refillRate: 0.25, // 1 token per second
    },
    store
  );

  // 4. Attach RateLimiter middleware with key format: rateLimit:user:<ip address>
  const rateLimiter = new RateLimiter(tokenBucket, {
    keyGenerator: (req) => `rateLimit:user:${RateLimiter.getClientIp(req)}`,
  });
  app.use(rateLimiter.middleware());

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

startServer();
