# SmartRate: Production-Grade Node.js Rate Limiter ⚡

[![npm version](https://img.shields.io/badge/npm-v1.0.0-blue.svg)](https://www.npmjs.com/package/smartrate)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-153%20passed-brightgreen.svg)]()
[![coverage](https://img.shields.io/badge/coverage-96.9%25-brightgreen.svg)]()
[![node](https://img.shields.io/badge/node-%3E%3D18.0.0-orange.svg)]()

**SmartRate** is a high-performance, production-grade distributed rate limiting library for Express.js. 

It uniquely decouples rate-limiting algorithms from storage engines using the **Atomic Reducer Pattern**, delivering **connection-isolated Optimistic Concurrency Control (OCC)** for Redis without requiring custom Lua scripts or database-level stored procedures.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Express Middleware](#express-middleware)
- [In-Memory Rate Limiting](#in-memory-rate-limiting)
- [Distributed Rate Limiting](#distributed-rate-limiting)
- [Rate Limiting with Redis](#rate-limiting-with-redis)
- [Rate Limiting Algorithms](#rate-limiting-algorithms)
  - [Fixed Window Algorithm](#fixed-window-algorithm)
  - [Token Bucket Algorithm](#token-bucket-algorithm)
  - [Sliding Window Rate Limiting](#sliding-window-rate-limiting)
  - [Leaky Bucket Algorithm](#leaky-bucket-algorithm)
- [Custom Key Generation (Client Identification)](#custom-key-generation-client-identification)
- [HTTP Response Headers & RFC Compliance](#http-response-headers--rfc-compliance)
- [TypeScript Support](#typescript-support)
- [Architecture & Design Pattern](#architecture--design-pattern)
- [Running Tests](#running-tests)
- [License](#license)

---

## Features

* 🚀 **Express Middleware Ready:** Drop-in `rateLimit({ ... })` middleware matching idiomatic Express patterns.
* 🛡️ **Zero-Race Concurrency:** Connection-isolated Optimistic Concurrency Control (`WATCH / MULTI / EXEC`) prevents overselling quotas under heavy load.
* 🧠 **Single Source of Truth:** Algorithms are pure JavaScript mathematical reducers (`compute(state, now) => { nextState, result }`). No Lua scripts to deploy or debug.
* 🧩 **4 Pluggable Algorithms:** Token Bucket, Sliding Window Log, Fixed Window, and Leaky Bucket.
* 🔌 **Interchangeable Storage:** Switch between zero-dependency `MemoryStore` and distributed `RedisStore` seamlessly.
* 🌐 **Smart IP Sanitization:** Automatic handling of reverse proxies (`X-Forwarded-For`), IPv6 loopback (`::1`), and IPv4-mapped IPv6 (`::ffff:`).
* 📘 **TypeScript Ready:** Shipped with complete, self-contained typings (`index.d.ts`).
* 📊 **Production Tested:** 153 unit, integration, and worker-thread concurrency tests passing with 96.9% coverage.

---

## Installation

```bash
npm install smartrate
```

> **Note:** `express` is a peer dependency (`^4.18.0 || ^5.0.0`). If using Redis for distributed setups, install `redis` (v4+) or `ioredis`.

---

## Express Middleware

SmartRate integrates directly as standard **Express middleware**. You can apply it globally to protect an entire application, or scope it to specific high-traffic or security-sensitive routes.

### Global Middleware Example

```javascript
const express = require("express");
const { rateLimit } = require("smartrate");

const app = express();

// Apply global rate limiting: max 100 requests per 15 minutes per IP
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
  })
);

app.get("/api/public", (req, res) => {
  res.json({ message: "Hello from protected API!" });
});

app.listen(3000, () => console.log("Server running on port 3000"));
```

### Route-Specific Middleware Example

```javascript
const express = require("express");
const { rateLimit } = require("smartrate");

const app = express();

// Strict rate limiter for sensitive authentication endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5, // Max 5 login attempts per 15 minutes
});

// Relaxed limiter for standard read operations
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // Max 60 requests per minute
});

app.post("/api/auth/login", loginLimiter, (req, res) => {
  res.json({ message: "Login endpoint" });
});

app.get("/api/items", apiLimiter, (req, res) => {
  res.json({ items: ["laptop", "phone"] });
});
```

---

## In-Memory Rate Limiting

**In-memory rate limiting** is ideal for single-instance Node.js applications, serverless functions, development environments, and microservices where an external Redis cache is not required.

When no `redis` client or `store` is specified, SmartRate automatically defaults to `MemoryStore`. `MemoryStore` uses an internal asynchronous per-key promise queue to guarantee strict atomicity without external dependencies.

```javascript
const express = require("express");
const { rateLimit, MemoryStore } = require("smartrate");

const app = express();

// In-Memory rate limiter using default options
const limiter = rateLimit({
  limit: 20,              // 20 requests
  windowMs: 60 * 1000,    // per 1 minute
  algorithm: "fixed-window",
});

app.use(limiter);

app.get("/status", (req, res) => {
  res.json({ status: "healthy" });
});
```

---

## Distributed Rate Limiting

In modern cloud environments, Node.js applications run across multiple processes, Docker containers, or Kubernetes pods behind a load balancer (e.g. AWS ALB, Nginx, Cloudflare). 

In-memory rate limiters fail in distributed setups because each node maintains isolated counters, allowing clients to exceed their quotas by round-robining requests across server instances.

SmartRate provides **distributed rate limiting** by coordinating state through a shared Redis store. Instead of error-prone distributed locking, SmartRate uses **connection-isolated Optimistic Concurrency Control (OCC)**:

```text
Node Instance A ───┐
                   ├──> [WATCH key] ──> [Compute in Pure JS] ──> [MULTI / EXEC] ──> Redis
Node Instance B ───┘
```

If two instances attempt to mutate the same client's rate limit concurrently, Redis detects the conflict on `EXEC`, and SmartRate automatically retries with exponential backoff and randomized jitter.

---

## Rate Limiting with Redis

SmartRate provides first-class support for **rate limiting with Redis** through `RedisStore`. It works with both `redis` (node-redis v4+) and `ioredis`.

### Working Redis Example (`node-redis` v4+)

```javascript
const express = require("express");
const { createClient } = require("redis");
const { rateLimit } = require("smartrate");

async function startServer() {
  const app = express();
  app.set("trust proxy", true); // Required when behind reverse proxies

  // 1. Connect Redis client
  const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });
  redisClient.on("error", (err) => console.error("Redis Client Error:", err));
  await redisClient.connect();

  // 2. Configure distributed Redis rate limiter
  const distributedLimiter = rateLimit({
    redis: redisClient,
    prefix: "rateLimit:prod:", // Key prefix in Redis
    algorithm: "token-bucket",
    capacity: 20,              // Allow burst up to 20 requests
    refillRate: 2,             // Refill 2 tokens per second
    maxRetries: 3,             // Max OCC conflict retries
  });

  app.use(distributedLimiter);

  app.get("/api/data", (req, res) => {
    res.json({ data: "Protected payload from distributed cluster" });
  });

  app.listen(3000, () => console.log("Distributed server running on port 3000"));
}

startServer();
```

### High Availability: Graceful Degradation (`failOpen`)

If your Redis cluster experiences an outage, SmartRate can gracefully "fail open" so that your API stays available:

```javascript
const limiter = rateLimit({
  redis: redisClient,
  failOpen: true, // If Redis is down, allow request through with degraded header
});
```

---

## Rate Limiting Algorithms

SmartRate includes 4 algorithms, each designed for specific throughput and security requirements:

| Algorithm | Configuration Name | Best Suited For | Concurrency Profile |
| :--- | :--- | :--- | :--- |
| **Fixed Window** | `"fixed-window"` *(default)* | Standard API rate limiting, low memory overhead | Single counter with TTL |
| **Token Bucket** | `"token-bucket"` | APIs requiring burst tolerance with smooth steady-state throughput | Continuous refill calculation |
| **Sliding Window Log** | `"sliding-window-log"` | Critical security endpoints (logins, payment processing) | Microsecond boundary precision |
| **Leaky Bucket** | `"leaky-bucket"` | Traffic shaping and queue protection for downstream services | Fixed egress processing rate |

---

### Fixed Window Algorithm

The **Fixed Window Algorithm** divides time into static increments (e.g. 1 minute, 1 hour). A counter increments with each request and resets at the beginning of each window.

* **Pros:** Extremely lightweight and fast with constant `O(1)` storage overhead.
* **Cons:** Potential burst of requests at window boundaries (e.g., sending max limit at the end of minute 1 and again at the start of minute 2).

```javascript
const fixedLimiter = rateLimit({
  algorithm: "fixed-window",
  limit: 100,          // 100 requests
  windowMs: 60 * 1000, // per 60 seconds
});

app.use("/api", fixedLimiter);
```

---

### Token Bucket Algorithm

The **Token Bucket Algorithm** maintains a bucket holding up to a maximum `capacity` of tokens. Tokens are continuously added at a specified `refillRate` (tokens per second). Each incoming request consumes a token.

* **Pros:** Handles legitimate traffic bursts gracefully while enforcing an average rate limit over time. Supports weighted request costs (e.g., heavy batch operations costing multiple tokens).
* **Cons:** Slightly more metadata stored per key than Fixed Window.

```javascript
const tokenBucketLimiter = rateLimit({
  algorithm: "token-bucket",
  capacity: 10,       // Max burst of 10 requests
  refillRate: 1,      // Refill 1 token per second (60 tokens/min steady state)
  cost: 1,            // Cost per request
});

app.use("/api/search", tokenBucketLimiter);
```

---

### Sliding Window Rate Limiting

**Sliding window rate limiting** solves the boundary burst problem of the fixed window approach. SmartRate implements **Sliding Window Log**, which records exact request timestamps. When a new request arrives, timestamps older than `now - windowMs` are pruned, and the remaining log length is evaluated against the limit.

* **Pros:** 100% boundary accuracy. No possibility of double-limit bursts across window transitions.
* **Cons:** Memory usage scales with the number of allowed requests in the active window.

```javascript
const slidingLimiter = rateLimit({
  algorithm: "sliding-window-log",
  limit: 5,                  // Max 5 attempts
  windowMs: 15 * 60 * 1000,  // Moving 15-minute window
});

// Protect critical endpoints against brute force attacks
app.post("/api/auth/reset-password", slidingLimiter, handlePasswordReset);
```

---

### Leaky Bucket Algorithm

The **Leaky Bucket Algorithm** represents incoming requests entering a bucket that leaks at a constant rate. If the inflow exceeds capacity, the bucket overflows and requests are dropped.

* **Pros:** Ideal for traffic shaping, ensuring that sensitive downstream systems (like third-party payment gateways or database write queues) receive requests at a smooth, constant frequency.
* **Cons:** May introduce latency or reject bursts if the leak rate is configured too aggressively.

```javascript
const leakyLimiter = rateLimit({
  algorithm: "leaky-bucket",
  capacity: 15,       // Max queue depth
  leakRate: 2,        // Drips 2 requests per second
});

app.use("/api/webhooks", leakyLimiter);
```

---

## Custom Key Generation (Client Identification)

By default, SmartRate identifies callers using their client IP address (`req.ip`), with built-in normalization for reverse proxies and IPv6 loopback addresses.

You can customize the key generator to limit by **User ID**, **API Key**, or **Organization**:

```javascript
// 1. Rate limit by Authenticated User ID
const userLimiter = rateLimit({
  limit: 50,
  keyGenerator: (req) => `user:${req.user?.id || req.ip}`,
});

// 2. Rate limit by API Key from HTTP Header
const apiKeyLimiter = rateLimit({
  limit: 1000,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (req) => `apikey:${req.headers["x-api-key"] || "anonymous"}`,
});

// 3. Rate limit by Tenant / Organization
const tenantLimiter = rateLimit({
  limit: 5000,
  keyGenerator: (req) => `tenant:${req.headers["x-organization-id"] || req.ip}`,
});
```

---

## HTTP Response Headers & RFC Compliance

SmartRate attaches standard rate-limiting headers to every response:

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1728000060
```

When a client exceeds the allowed limit, SmartRate interrupts the request pipeline and returns an **HTTP 429 Too Many Requests** response with the `Retry-After` header:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json; charset=utf-8

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

---

## TypeScript Support

SmartRate includes complete, self-contained TypeScript declarations out of the box with zero external `@types/*` peer dependencies:

```typescript
import express, { Request, Response } from "express";
import rateLimit, { TokenBucket, MemoryStore, RateLimitMiddleware } from "smartrate";

const app = express();

const limiter: RateLimitMiddleware = rateLimit({
  limit: 50,
  windowMs: 60000,
  algorithm: "token-bucket",
});

app.use(limiter);
```

---

## Architecture & Design Pattern

SmartRate uses the **Atomic Reducer Pattern** to maintain architectural consistency across all storage backends:

```text
HTTP Request
    ↓
RateLimiter Middleware (Express)
    ↓
Algorithm (e.g. TokenBucket, SlidingWindowLog)
    ↓  [Atomic Reducer: compute(currentState, now) => { nextState, result }]
Storage Adapter (MemoryStore / RedisStore)
    ↓
Redis / Memory
```

For senior engineers and system design interview preparation, check out our in-depth design documents:
* 📖 [Configuration Guide (`configuration.md`)](./configuration.md)
* 🏛️ [Factory & Facade Pattern Architecture Guide (`factoryPattern.md`)](./factoryPattern.md)
* ⚡ [Race Condition & Concurrency Analysis (`raceCondition.md`)](./raceCondition.md)

---

## Running Tests

SmartRate runs natively on Node.js's built-in test runner with zero third-party test dependencies:

```bash
# Run all 153 unit, integration, and worker-thread concurrency tests
npm test

# Run tests with code coverage report
node --test --experimental-test-coverage "src/test/**/*.test.js" "src/test/**/*.integration.js"
```

---

## License

[MIT](./LICENSE) © 2026 vishuvd1122
