<h1 align="center">SmartRate</h1>

<p align="center">
  A modular, production-focused rate limiter for Node.js and Express.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/smartrate"><img src="https://img.shields.io/npm/v/smartrate.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/smartrate"><img src="https://img.shields.io/npm/dm/smartrate.svg" alt="npm downloads"></a>
  <img src="https://img.shields.io/badge/TypeScript-supported-blue" alt="TypeScript supported">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/npm/l/smartrate.svg" alt="license"></a>
</p>

SmartRate helps protect APIs from excessive requests with four rate-limiting algorithms and interchangeable in-memory or Redis-backed storage. It integrates with Express middleware and includes TypeScript declarations.

## Installation

```bash
npm install smartrate
```

SmartRate uses Express as a peer dependency:

```bash
npm install express
```

For distributed rate limiting with Redis, install a Redis client (`redis` v4+ or `ioredis`).

## Quick Start

```js
const express = require("express");
const { rateLimit } = require("smartrate");

const app = express();

const limiter = rateLimit({
  algorithm: "fixed-window",
  limit: 100,
  windowMs: 60 * 1000, // 100 requests per minute
});

app.use("/api", limiter);

app.get("/api/data", (req, res) => {
  res.json({ message: "Request allowed" });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
```

When a client exceeds the configured limit, SmartRate rejects the request with **HTTP 429 (Too Many Requests)**.

## Configuration

The following are the main options used to configure a limiter:

| Option | Type | Description |
| --- | --- | --- |
| `algorithm` | `string` | Algorithm to use: `fixed-window`, `token-bucket`, `sliding-window-log`, or `leaky-bucket`. |
| `limit` | `number` | Maximum requests allowed in the configured window. Used by window-based algorithms. |
| `windowMs` | `number` | Rate-limit window duration in milliseconds. |
| `capacity` | `number` | Maximum bucket capacity for Token Bucket and Leaky Bucket. |
| `refillRate` | `number` | Tokens added per second for Token Bucket. |
| `cost` | `number` | Token cost of a request for Token Bucket. |
| `leakRate` | `number` | Requests drained per second for Leaky Bucket. |
| `keyGenerator` | `function` | Returns the key used to identify and track a client. |
| `redis` | Redis client | Redis client used to enable shared storage. |
| `prefix` | `string` | Prefix for keys stored in Redis. |
| `maxRetries` | `number` | Maximum retries for Redis optimistic-concurrency conflicts. |

Use the options relevant to the selected algorithm. For example, `limit` and `windowMs` are used by Fixed Window and Sliding Window Log, while `capacity` and `refillRate` configure Token Bucket.

## Available Algorithms

Choose the algorithm that best matches your endpoint's traffic pattern.

| Algorithm | Configuration | Best for |
| --- | --- | --- |
| Fixed Window | `fixed-window` | General-purpose API limits with low storage overhead |
| Token Bucket | `token-bucket` | APIs that should allow short bursts while controlling average traffic |
| Sliding Window Log | `sliding-window-log` | More precise limits for sensitive endpoints such as login and password reset |
| Leaky Bucket | `leaky-bucket` | Controlling bursts and protecting downstream services |

### Fixed Window

Counts requests within fixed time intervals. The counter resets when the current window expires.

```js
const limiter = rateLimit({
  algorithm: "fixed-window",
  limit: 100,
  windowMs: 60 * 1000,
});
```

### Token Bucket

Allows bursts up to the bucket capacity while replenishing tokens at a steady rate.

```js
const limiter = rateLimit({
  algorithm: "token-bucket",
  capacity: 10,      // Maximum burst capacity
  refillRate: 1,     // Tokens added per second
  cost: 1,           // Tokens consumed per request
});
```

### Sliding Window Log

Tracks request timestamps over a rolling time window, avoiding the boundary-burst behavior of fixed windows.

```js
const limiter = rateLimit({
  algorithm: "sliding-window-log",
  limit: 5,
  windowMs: 15 * 60 * 1000, // 5 requests per rolling 15 minutes
});
```

### Leaky Bucket

Tracks incoming traffic against a bucket capacity and drains it at a configured rate. Requests are rejected when the bucket cannot accept more traffic.

```js
const limiter = rateLimit({
  algorithm: "leaky-bucket",
  capacity: 15,
  leakRate: 2, // Requests drained per second
});
```

## Storage

SmartRate separates rate-limiting logic from state storage. You can use the in-memory store for a single application instance or Redis when multiple instances need to share the same limits.

### In-Memory Storage

MemoryStore is used by default when Redis is not configured. It requires no external service and is suitable for local development and single-instance applications.

```js
const limiter = rateLimit({
  algorithm: "fixed-window",
  limit: 20,
  windowMs: 60 * 1000,
});
```

**Note:** Each Node.js process has its own in-memory state. If your application runs across multiple processes or servers, use Redis to share rate-limit state.

### Redis Storage

RedisStore enables shared rate-limit state across application instances. SmartRate supports `redis` (node-redis v4+) and `ioredis` clients.

Example using `redis`:

```js
const express = require("express");
const { createClient } = require("redis");
const { rateLimit } = require("smartrate");

async function startServer() {
  const app = express();

  const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisClient.on("error", (error) => {
    console.error("Redis error:", error);
  });

  await redisClient.connect();

  const limiter = rateLimit({
    redis: redisClient,
    prefix: "smartrate:",
    algorithm: "fixed-window",
    limit: 100,
    windowMs: 60 * 1000,
    maxRetries: 3,
  });

  app.use("/api", limiter);

  app.listen(3000, () => {
    console.log("Server running on port 3000");
  });
}

startServer().catch(console.error);
```

Redis operations use optimistic concurrency control with `WATCH`, `MULTI`, and `EXEC`, with retries for transaction conflicts. Rate-limit calculations remain in JavaScript; SmartRate does not require custom Redis Lua scripts.

## Identify Clients

By default, SmartRate identifies clients using their IP address. You can provide a `keyGenerator` to apply limits by authenticated user, API key, tenant, or another identifier.

```js
const userLimiter = rateLimit({
  algorithm: "fixed-window",
  limit: 50,
  windowMs: 60 * 1000,
  keyGenerator: (req) => `user:${req.user?.id || req.ip}`,
});

app.use("/api", userLimiter);
```

If your Express application is behind a trusted reverse proxy, configure Express's `trust proxy` setting appropriately so that client IP detection works as expected.

## License

MIT
