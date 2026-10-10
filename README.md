# SmartRate ⚡

[![npm version](https://img.shields.io/badge/npm-v1.0.0-blue.svg)](https://www.npmjs.com/package/smartrate)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-153%20passed-brightgreen.svg)]()
[![coverage](https://img.shields.io/badge/coverage-96.9%25-brightgreen.svg)]()
[![node](https://img.shields.io/badge/node-%3E%3D18.0.0-orange.svg)]()

**SmartRate** is a high-performance, production-grade distributed rate limiting library for Express.js. 

It uniquely decouples rate-limiting algorithms from storage engines using the **Atomic Reducer Pattern**, featuring **connection-isolated Optimistic Concurrency Control (OCC)** for Redis without requiring custom Lua scripts.

---

## Highlights

* 🚀 **1-Line Express Integration:** Simple, declarative `rateLimit({ ... })` facade matching modern Express conventions.
* 🧠 **Single Source of Truth:** Algorithms are pure JavaScript mathematical reducers (`compute(state, now) => { nextState, result }`). Zero business logic duplicated into database scripts.
* 🛡️ **Zero-Race Redis Concurrency:** Connection-isolated Optimistic Concurrency Control (`WATCH / MULTI / EXEC`) with exponential backoff and randomized jitter.
* 🧩 **4 Pluggable Algorithms:** Token Bucket, Sliding Window Log, Fixed Window, and Leaky Bucket.
* 🔌 **Interchangeable Storage:** Switch seamlessly between zero-dependency `MemoryStore` (testing/single-node) and distributed `RedisStore` (multi-process clusters).
* 🌐 **Smart IP Sanitization:** Automatic handling of reverse proxies (`X-Forwarded-For`), IPv6 localhost (`::1`), and IPv4-mapped IPv6 (`::ffff:`).
* 📊 **Production Tested:** 153 unit, integration, and worker-thread concurrency stress tests with 96.9% code coverage.
* 📘 **TypeScript Ready:** Full type definitions (`index.d.ts`) included out of the box.

---

## Installation

```bash
npm install smartrate
```

*Note: `express` is a peer dependency. If using Redis, ensure `redis` (v4+) or `ioredis` is installed.*

---

## Quick Start

### 1. In-Memory Rate Limiter (Default)
Ideal for single-instance applications, testing, or development environments:

```javascript
const express = require("express");
const { rateLimit } = require("smartrate");

const app = express();

// Limit each IP to 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
});

app.use(limiter);

app.get("/", (req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(3000, () => console.log("Server running on port 3000"));
```

---

### 2. Distributed Redis Rate Limiter (Token Bucket)
Ideal for distributed microservices, Docker clusters, or Kubernetes pods:

```javascript
const express = require("express");
const { createClient } = require("redis");
const { rateLimit } = require("smartrate");

async function main() {
  const app = express();
  app.set("trust proxy", true); // Required when behind proxies (Nginx, Cloudflare)

  // 1. Connect Redis client
  const redisClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
  await redisClient.connect();

  // 2. Attach rate limiter
  const limiter = rateLimit({
    redis: redisClient,
    algorithm: "token-bucket",
    capacity: 10,       // Burst capacity: up to 10 requests
    refillRate: 1,      // Refill 1 token per second
  });

  app.use(limiter);

  app.get("/api/data", (req, res) => {
    res.json({ data: "Protected payload" });
  });

  app.listen(3000);
}

main();
```

---

## Supported Algorithms

SmartRate lets you pick the right algorithmic trade-off for each endpoint:

| Algorithm | Option Name | Best For | Storage State |
|---|---|---|---|
| **Fixed Window** | `"fixed-window"` *(default)* | Low-overhead, general web API protection. | `{"count": 5, "windowStart": 1728000000000}` |
| **Token Bucket** | `"token-bucket"` | APIs that need to tolerate sudden legitimate traffic spikes while smoothing out steady-state usage. | `{"tokens": 8.5, "lastRefill": 1728000000000}` |
| **Sliding Window Log** | `"sliding-window-log"` | High-security endpoints (e.g. `/auth/login`, `/payments`) requiring microsecond precision with zero boundary bursts. | `[1728000001000, 1728000002500]` |
| **Leaky Bucket** | `"leaky-bucket"` | Traffic shaping and protecting sensitive downstream queues from sudden surges. | `{"queue": [...], "lastLeakTime": 1728000000000}` |

```javascript
// Example: High-security sliding window log on authentication
const authLimiter = rateLimit({
  redis: redisClient,
  algorithm: "sliding-window-log",
  limit: 5,
  windowMs: 15 * 60 * 1000, // 5 attempts per 15 minutes
});

app.post("/api/auth/login", authLimiter, loginHandler);
```

---

## Custom Client Identification

By default, requests are identified by client IP formatted into Redis as `rateLimit:user:<ip>`. You can customize the identifier using `keyGenerator`:

```javascript
// Rate limit by authenticated User ID:
const userLimiter = rateLimit({
  redis: redisClient,
  limit: 50,
  keyGenerator: (req) => `user:${req.user?.id || req.ip}`,
});

// Rate limit by API Key:
const apiKeyLimiter = rateLimit({
  redis: redisClient,
  limit: 1000,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (req) => `api:${req.headers["x-api-key"] || "anonymous"}`,
});
```

---

## HTTP Response Headers

SmartRate automatically attaches standard rate-limiting headers:

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1728000060
```

When a request exceeds the quota, SmartRate halts execution and responds with `429 Too Many Requests`:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json; charset=utf-8

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

### High-Availability Graceful Degradation (`failOpen`)
If your Redis server becomes unreachable, SmartRate can gracefully allow traffic through without breaking your API:

```javascript
const limiter = rateLimit({
  redis: redisClient,
  failOpen: true, // If Redis fails, allows request with X-RateLimit-Degraded: true
});
```

---

## Architecture: The Atomic Reducer Pattern

```text
HTTP Request
    ↓
RateLimiter Middleware (Express)
    ↓
Algorithm (e.g. TokenBucket, SlidingWindowLog)
    ↓  [Atomic Reducer: compute(currentState, now) => { nextState, result }]
Storage Interface (mutate, get, set, delete)
    ↓
RedisStore (Connection-isolated Optimistic Concurrency Control)
    ↓
Redis Instance
```

For a comprehensive explanation of how this architecture prevents race conditions and how the Factory Pattern was designed for senior system design interviews, see:
* 📖 [Configuration Guide (`configuration.md`)](./configuration.md)
* 🏛️ [Factory & Facade Pattern Architecture Guide (`factoryPattern.md`)](./factoryPattern.md)
* ⚡ [Concurrency & Race Condition Analysis (`raceCondition.md`)](./raceCondition.md)

---

## Running Tests

SmartRate has zero external test framework dependencies, running natively on Node.js's built-in test runner:

```bash
# Run all unit, integration, and worker-thread concurrency tests
npm test

# Run tests with code coverage report
node --test --experimental-test-coverage "src/test/**/*.test.js" "src/test/**/*.integration.js"
```

---

## License

[MIT](./LICENSE) © 2026 vishuvd1122