# SmartRate Configuration Guide

SmartRate provides both a simple, high-level Express middleware factory (`rateLimit()`) and modular low-level primitives (`Store`, `Algorithm`, `RateLimiter`).

---

## 1. Quick Start

### Basic In-Memory Rate Limiting
For single-instance apps or testing environments (no database required):

```javascript
const express = require("express");
const { rateLimit } = require("smartrate");

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,               // 100 requests per 15 minutes
});

// Apply globally to all routes
app.use(limiter);

app.get("/", (req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(3000);
```

---

### Distributed Redis Rate Limiting
For production deployments across multiple Node.js processes or clusters:

```javascript
const express = require("express");
const { createClient } = require("redis");
const { rateLimit } = require("smartrate");

async function main() {
  const app = express();
  app.set("trust proxy", true); // Required behind reverse proxies (Nginx, Cloudflare)

  // 1. Connect to Redis
  const redisClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
  await redisClient.connect();

  // 2. Configure Rate Limiter
  const limiter = rateLimit({
    redis: redisClient,
    algorithm: "token-bucket",
    capacity: 10,
    refillRate: 1, // 1 token refilled per second
  });

  app.use(limiter);

  app.listen(3000);
}

main();
```

---

## 2. Configuration Options Reference (`rateLimit`)

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` / `max` / `capacity` | `number` | `5` | Maximum number of requests or tokens allowed within the window. |
| `windowMs` / `window` | `number` | `60000` (1 min) | Duration of the rate limit window in milliseconds. |
| `algorithm` | `string \| Object` | `"fixed-window"` | The rate limiting algorithm to use: `"fixed-window"`, `"token-bucket"`, `"sliding-window-log"`, or `"leaky-bucket"`. |
| `redis` | `Object` | `undefined` | A connected Redis client instance (`redis` v4+ or `ioredis`). Automatically creates an isolated `RedisStore`. |
| `store` | `StorageInterface` | `MemoryStore` | Explicit storage instance (if providing custom storage). |
| `prefix` | `string` | `"rateLimit:"` | Key prefix for keys stored in Redis. |
| `keyGenerator` | `Function` | Default IP Generator | Function mapping `(req) => string` identifier. Defaults to client IP normalized to `rateLimit:user:<cleanIp>`. |
| `failOpen` | `boolean` | `false` | When `true`, storage connectivity errors allow the request through with an `X-RateLimit-Degraded: true` header instead of throwing a 500 error. |
| `cost` | `number` | `1` | Number of tokens/slots consumed per request. |
| `refillRate` | `number` | `capacity / (windowMs / 1000)` | Used by `token-bucket`: tokens refilled per second. |
| `leakRate` | `number` | `capacity / (windowMs / 1000)` | Used by `leaky-bucket`: requests processed / leaked per second. |
| `clock` | `Object` | `SystemClock` | Clock provider implementing `now()`. Useful for testing time-dependent behavior with fake clocks. |

---

## 3. Algorithm Configurations

### A. Fixed Window (`algorithm: "fixed-window"`)
Resets request counts at regular time boundaries (e.g., every 60 seconds).

```javascript
const limiter = rateLimit({
  algorithm: "fixed-window",
  limit: 60,
  windowMs: 60 * 1000, // 60 requests per minute
});
```

* **Best for:** Lightweight, low-overhead rate limiting with minimal memory footprint.
* **Storage format:** `{"count": 5, "windowStart": 1728000000000}`.

---

### B. Token Bucket (`algorithm: "token-bucket"`)
Maintains a bucket of tokens that refilled at a continuous rate. Allows bursts up to `capacity` while enforcing an average rate over time.

```javascript
const limiter = rateLimit({
  redis: redisClient,
  algorithm: "token-bucket",
  capacity: 10,       // Burst capacity: up to 10 requests immediately
  refillRate: 2,      // Refills 2 tokens per second (120 req/min steady state)
});
```

* **Best for:** APIs that need to tolerate sudden legitimate traffic spikes while smoothing out steady-state usage.
* **Storage format:** `{"tokens": 8.5, "lastRefill": 1728000000000}`.

---

### C. Sliding Window Log (`algorithm: "sliding-window-log"`)
Tracks the exact timestamp of every request in a sliding window. Eliminates window-boundary burst vulnerabilities with microsecond precision.

```javascript
const limiter = rateLimit({
  redis: redisClient,
  algorithm: "sliding-window-log",
  limit: 20,
  windowMs: 60 * 1000, // Strict 20 requests in any rolling 60-second window
});
```

* **Best for:** High-security endpoints (e.g. `/api/auth/login`, `/api/payments`) where burst exploits must be strictly prevented.
* **Storage format:** `[1728000001000, 1728000002500, ...]`.

---

### D. Leaky Bucket (`algorithm: "leaky-bucket"`)
Enforces a smooth, constant output rate regardless of incoming burst volume. Requests accumulate in a bucket and "leak" at a fixed rate.

```javascript
const limiter = rateLimit({
  algorithm: "leaky-bucket",
  capacity: 15,
  leakRate: 3, // 3 units processed per second
});
```

* **Best for:** Protecting downstream services that cannot tolerate sudden spikes and require traffic shaping.
* **Storage format:** `{"water": 4, "lastLeak": 1728000000000}`.

---

## 4. Client Identification & Key Formatting

By default, SmartRate normalizes IP addresses and stores keys under the format:
```text
rateLimit:user:<ip address>
```

### Custom Client Key Generators
You can identify clients using API keys, authenticated user IDs, or custom attributes:

#### 1. By Authenticated User ID
```javascript
const userLimiter = rateLimit({
  redis: redisClient,
  limit: 100,
  windowMs: 60 * 1000,
  keyGenerator: (req) => `user:${req.user?.id || req.ip}`,
});
```

#### 2. By API Key
```javascript
const apiKeyLimiter = rateLimit({
  redis: redisClient,
  limit: 1000,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (req) => `api_key:${req.headers["x-api-key"] || "anonymous"}`,
});
```

#### 3. Route-Specific IP Limiter
```javascript
const routeLimiter = rateLimit({
  redis: redisClient,
  limit: 5,
  windowMs: 60 * 1000,
  keyGenerator: (req) => `endpoint:${req.path}:ip:${RateLimiter.getClientIp(req)}`,
});
```

---

## 5. Route-Specific Rate Limits

You can instantiate multiple limiters for different tiers or sensitive endpoints:

```javascript
// Global API limiter (relaxed)
const globalLimiter = rateLimit({
  redis: redisClient,
  limit: 100,
  windowMs: 60 * 1000,
});

// Authentication limiter (strict)
const authLimiter = rateLimit({
  redis: redisClient,
  algorithm: "sliding-window-log",
  limit: 5,
  windowMs: 15 * 60 * 1000, // 5 attempts per 15 minutes
});

app.use("/api", globalLimiter);
app.post("/api/auth/login", authLimiter, handleLogin);
app.post("/api/auth/register", authLimiter, handleRegister);
```

---

## 6. HTTP Response Headers

SmartRate automatically returns standard rate limiting headers on all responses:

| Header | Description | Example |
|---|---|---|
| `X-RateLimit-Limit` | The maximum requests allowed in the current window | `10` |
| `X-RateLimit-Remaining` | Remaining requests available before hitting limit | `4` |
| `X-RateLimit-Reset` | Unix timestamp (in seconds) when the limit resets | `1728000060` |
| `Retry-After` | Seconds to wait before retrying (sent on `429 Too Many Requests`) | `34` |
| `X-RateLimit-Degraded` | Sent only when `failOpen: true` and storage fails | `"true"` |

### 429 Error Response Payload
When the rate limit is exceeded, SmartRate halts execution and responds with:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json; charset=utf-8

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

---

## 7. Advanced: Low-Level Modular API

For architectures that use dependency injection or require direct access to internal reducers, you can instantiate the underlying classes directly:

```javascript
const {
  RedisStore,
  MemoryStore,
  TokenBucket,
  SlidingWindowLog,
  FixedWindow,
  RateLimiter
} = require("smartrate");

// 1. Storage
const store = new RedisStore(redisClient, {
  prefix: "rateLimit:",
  maxRetries: 5,
  retryDelayMs: 10,
});

// 2. Algorithm
const algorithm = new TokenBucket(
  {
    capacity: 10,
    refillRate: 1,
  },
  store
);

// 3. Middleware
const limiter = new RateLimiter(algorithm, {
  keyGenerator: (req) => `user:${RateLimiter.getClientIp(req)}`,
  failOpen: true,
});

app.use(limiter.middleware());
```
