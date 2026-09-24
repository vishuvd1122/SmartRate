# SmartRate Function Definitions & Architecture Reference

This document provides a comprehensive reference of **all functions, methods, and constructors** implemented across the **SmartRate** codebase.

For every function, it details:
1. **Defined In**: The exact source file.
2. **Called By / Used In**: Where in the project this function is called.
3. **Use & Purpose**: What the function does.
4. **Why It Is Important**: Its architectural and operational significance.
5. **Position in Request Flow**: When it executes during the server lifecycle (Setup Phase vs. Runtime Request Flow).

---

## Table of Contents
- [1. Middleware Layer](#1-middleware-layer)
- [2. Algorithm Layer (Base & Implementations)](#2-algorithm-layer)
- [3. Storage Layer (Interface, Memory & Redis)](#3-storage-layer)
- [4. Clock Layer (System & Test Helpers)](#4-clock-layer)
- [5. Client Identifier Layer](#5-client-identifier-layer)
- [6. Utilities and Errors](#6-utilities-and-errors)
- [7. Request Flow Lifecycle Diagram](#7-request-flow-lifecycle-diagram)

---

## 1. Middleware Layer

### `RateLimiter.constructor(algorithm, options)`
* **Defined In:** `src/middleware/rateLimiter.js`
* **Called By / Used In:** Application setup code (`src/index.js`, tests, factory).
* **Use & Purpose:** Initializes the rate-limiter middleware instance by validating and storing the algorithm instance, the client `keyGenerator` function (defaulting to client IP), and the clock instance (defaulting to `SystemClock`).
* **Why It Is Important:** Acts as the dependency-injection container for the HTTP middleware layer. Ensures fail-fast validation if the algorithm does not implement `check()`, if the key generator is not a function, or if the clock does not implement `now()`.
* **Position in Request Flow:** **Setup Phase (Initialization).** Runs once when the application starts or tests configure the rate limiter.

---

### `RateLimiter.prototype.middleware()`
* **Defined In:** `src/middleware/rateLimiter.js`
* **Called By / Used In:** Express application router (`app.use(rateLimiter.middleware())`).
* **Use & Purpose:** Returns an Express-compatible asynchronous middleware function `async (req, res, next)`.
* **Why It Is Important:** It is the primary entry point for HTTP traffic. It intercepts incoming requests, derives the client identifier, delegates limit checks to the algorithm, sets standard HTTP rate-limiting headers, and either passes control to `next()` or terminates with HTTP 429 Too Many Requests.
* **Position in Request Flow:** **Runtime Phase (Request Entry).** The returned inner function executes on every incoming HTTP request before any protected route handlers.

---

### `RateLimiter.prototype.setHeaders(res, result)`
* **Defined In:** `src/middleware/rateLimiter.js`
* **Called By / Used In:** Called internally inside `RateLimiter.prototype.middleware()`.
* **Use & Purpose:** Sets the standard rate-limit headers on the Express response object:
  - `X-RateLimit-Limit`: Maximum requests permitted.
  - `X-RateLimit-Remaining`: Number of requests remaining in the active window.
  - `X-RateLimit-Reset`: Unix timestamp in seconds when the window resets.
* **Why It Is Important:** Adheres to RFC standard conventions for HTTP rate-limiting headers, giving client applications observability into their quota consumption.
* **Position in Request Flow:** **Runtime Phase (Post-Evaluation).** Executes immediately after `algorithm.check()` returns, for both allowed and blocked requests.

---

## 2. Algorithm Layer

### `BaseAlgorithm.constructor(options, storage, clock)`
* **Defined In:** `src/algorithms/baseAlgorithm.js`
* **Called By / Used In:** Invoked by subclass constructors via `super(options, storage, clock)` (e.g., in `FixedWindow`).
* **Use & Purpose:** Validates the options object, ensures the provided storage implements mutation capabilities (`mutate`, `update`, or `get`/`set`), and binds the clock.
* **Why It Is Important:** Implements the **Template Method Pattern** across all algorithms. Guarantees uniform validation and dependency injection for any rate-limiting algorithm.
* **Position in Request Flow:** **Setup Phase (Initialization).**

---

### `BaseAlgorithm.prototype.check(identifier)`
* **Defined In:** `src/algorithms/baseAlgorithm.js`
* **Called By / Used In:** `RateLimiter.prototype.middleware()`.
* **Use & Purpose:** The universal evaluation orchestrator. Retrieves the current timestamp from `this.clock.now()`, resolves the TTL via `this.getTtlMs(now)`, and delegates atomic mutation to `this.store.mutate()` by passing `(currentState) => this.compute(currentState, now)`.
* **Why It Is Important:** **Guarantees atomicity once for all algorithms.** The algorithm authors never have to write database queries, locking code, or race-condition handling—`check()` delegates that to the storage engine while calling the pure `compute()` reducer.
* **Position in Request Flow:** **Runtime Phase (Core Decision Point).** Called on every HTTP request inside the middleware.

---

### `BaseAlgorithm.prototype.getTtlMs(now)`
* **Defined In:** `src/algorithms/baseAlgorithm.js`
* **Called By / Used In:** Called inside `BaseAlgorithm.prototype.check(identifier)`.
* **Use & Purpose:** Determines the time-to-live (in milliseconds) for the storage key. Defaults to `options.window` or 60,000ms. Subclasses can override it for customized expiry.
* **Why It Is Important:** Prevents memory leaks by ensuring keys in in-memory and Redis storage automatically expire when their rate-limiting window concludes.
* **Position in Request Flow:** **Runtime Phase (Pre-Storage Mutation).**

---

### `BaseAlgorithm.prototype.compute(state, now)`
* **Defined In:** `src/algorithms/baseAlgorithm.js`
* **Called By / Used In:** Base placeholder that throws an error if a subclass fails to implement it.
* **Use & Purpose:** Defines the interface contract for pure mathematical state transitions: `(currentState, now) => { nextState, result }`.
* **Why It Is Important:** Enforces the contract that all concrete algorithms must be pure functions without asynchronous side effects.
* **Position in Request Flow:** Abstract specification.

---

### `FixedWindow.constructor(options, storage, clock)`
* **Defined In:** `src/algorithms/fixedWindow.js`
* **Called By / Used In:** Application setup (`src/index.js`, integration and unit tests).
* **Use & Purpose:** Calls `super(options, storage, clock)`, validates that `limit` is a positive integer and `window` is a positive finite number, and stores them on the instance.
* **Why It Is Important:** Enforces strict parameter boundaries for the Fixed Window algorithm (rejecting decimals, negative numbers, or invalid windows).
* **Position in Request Flow:** **Setup Phase (Initialization).**

---

### `FixedWindow.prototype.getTtlMs(now)`
* **Defined In:** `src/algorithms/fixedWindow.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Returns `this.window` (the exact window duration in milliseconds) as the storage key TTL.
* **Why It Is Important:** Ensures that the client's counter automatically expires from storage once the window has elapsed.
* **Position in Request Flow:** **Runtime Phase.**

---

### `FixedWindow.prototype.compute(state, now)`
* **Defined In:** `src/algorithms/fixedWindow.js`
* **Called By / Used In:** Executed inside `store.mutate()` callback during `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Pure mathematical reducer that:
  1. Starts a new window (`count: 1`, `windowStart: now`) if state is null or window expired (`now - state.windowStart >= this.window`).
  2. Blocks request (`allowed: false`, `remaining: 0`) if `state.count >= this.limit` without incrementing count.
  3. Increments count (`state.count + 1`, `allowed: true`) if within active window and under limit.
* **Why It Is Important:** **Core algorithm math.** Being completely synchronous and pure (no database queries, no `await`), it guarantees 100% deterministic, race-condition-free evaluation when executed inside `store.mutate()`.
* **Position in Request Flow:** **Runtime Phase (Evaluation Execution).**

---

### `TokenBucket.constructor(options, storage, clock)`
* **Defined In:** `src/algorithms/tokenBucket.js`
* **Called By / Used In:** Application setup code, tests, factory.
* **Use & Purpose:** Initializes TokenBucket instance by validating `capacity` (positive integer), `cost` (positive integer $\le$ capacity, defaulting to 1), and resolving `refillRatePerMs` from options (`refillRate`, `tokensPerInterval`/`interval`, or `window`). Calls `super(options, storage, clock)`.
* **Why It Is Important:** Configures bucket capacity, refill rate, and static token cost per request while inheriting storage coordination and validation from `BaseAlgorithm`.
* **Position in Request Flow:** **Setup Phase (Initialization).**

---

### `TokenBucket.prototype.getTtlMs(now)`
* **Defined In:** `src/algorithms/tokenBucket.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Calculates the key's TTL as `Math.ceil(this.capacity / this.refillRatePerMs)`, representing the maximum time needed for an empty bucket to refill completely to capacity.
* **Why It Is Important:** Prevents premature key eviction from storage when refill rates are slower than the default 60 seconds.
* **Position in Request Flow:** **Runtime Phase (Pre-Storage Mutation).**

---

### `TokenBucket.prototype.compute(state, now)`
* **Defined In:** `src/algorithms/tokenBucket.js`
* **Called By / Used In:** Executed inside `store.mutate()` callback during `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Pure mathematical reducer for Token Bucket:
  1. Computes refilled tokens: `tokens + elapsedMs * refillRatePerMs` (capped at `capacity`).
  2. If `tokens < this.cost`: returns `allowed: false, remaining: floor(tokens)`, and calculates `resetAt` when enough tokens (`this.cost - tokens`) will be available.
  3. If `tokens >= this.cost`: consumes `this.cost` tokens (`tokens - this.cost`), returns `allowed: true, remaining: floor(nextTokens)`, and calculates `resetAt` when the bucket will be completely full.
* **Why It Is Important:** Core mathematical logic for token bucket rate limiting with support for weighted tokens. Pure and side-effect free, guaranteeing atomic execution inside `store.mutate()`.
* **Position in Request Flow:** **Runtime Phase (Evaluation Execution).**

---

### `SlidingWindowCounter.constructor(limit, windowMs)` & `allow(key)`
* **Defined In:** `src/algorithms/slidingWindowCounter.js`
* **Called By / Used In:** Sliding Window Counter scaffold.
* **Use & Purpose:** Initializes and checks requests for sliding window counter.
* **Why It Is Important:** Placeholder scaffold for weighted window estimation.
* **Position in Request Flow:** Setup / Runtime.

---

### `SlidingWindowLog.constructor(limit, windowMs)` & `allow(key)`
* **Defined In:** `src/algorithms/slidingWindowLog.js`
* **Called By / Used In:** Sliding Window Log scaffold.
* **Use & Purpose:** Initializes and checks requests for sliding window log.
* **Why It Is Important:** Placeholder scaffold for exact timestamp log rate limiting.
* **Position in Request Flow:** Setup / Runtime.

---

### `LeakyBucket.constructor(rate)` & `allow(key)`
* **Defined In:** `src/algorithms/leakyBucket.js`
* **Called By / Used In:** Leaky Bucket scaffold.
* **Use & Purpose:** Initializes and checks requests for leaky bucket traffic shaping.
* **Why It Is Important:** Placeholder scaffold for leaky bucket.
* **Position in Request Flow:** Setup / Runtime.

---

## 3. Storage Layer

### `StorageInterface` Methods
* **Defined In:** `src/storage/storageInterface.js`
* **Methods:**
  - `get(key)`: Retrieves value for key.
  - `set(key, value, ttlMs)`: Stores value with optional TTL.
  - `delete(key)`: Deletes key.
  - `reset(key)`: Alias for `delete(key)`.
  - `increment(key, value)`: Increments numeric counter.
  - `mutate(key, reducerFn, ttlMs)`: Atomically applies a state reducer function.
  - `update(key, updaterFn, ttlMs)`: Atomically applies an update function.
  - `eval(script, keys, args)`: Executes raw atomic script/function.
* **Why It Is Important:** Defines the strict polymorphic contract that all storage engines (in-memory, Redis, Memcached, etc.) must implement.
* **Position in Request Flow:** Interface contract.

---

### `MemoryStore.constructor()`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Setup code (`src/index.js`, tests).
* **Use & Purpose:** Initializes `this.data = new Map()` for in-memory key-value storage.
* **Why It Is Important:** Allocates the local in-process memory map for high-speed rate-limiting.
* **Position in Request Flow:** **Setup Phase.**

---

### `MemoryStore.prototype.mutate(key, reducerFn, ttlMs)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Synchronously retrieves `this.data.get(key)`, calls `reducerFn(current)`, sets `this.data.set(key, nextState)`, and sets a cleanup timeout if `ttlMs` is provided. Returns the `result` object.
* **Why It Is Important:** **Core concurrency solution for in-memory storage.** Because JavaScript is single-threaded and this function contains no `await` calls between read and write, it executes atomically in a single tick of the event loop, completely eliminating race conditions.
* **Position in Request Flow:** **Runtime Phase (State Transition).**

---

### `MemoryStore.prototype.update(key, updaterFn, ttlMs)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()` (as an alternate atomic path).
* **Use & Purpose:** Synchronously reads state, executes `updaterFn(current)`, updates map with `result.state`, and returns the result.
* **Why It Is Important:** Provides backwards compatibility for algorithms expecting an `.update()` contract.
* **Position in Request Flow:** **Runtime Phase.**

---

### `MemoryStore.prototype.get(key)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Tests (inspecting recorded state, e.g. `await store.get("client-1")`).
* **Use & Purpose:** Retrieves the stored state object for a key from `this.data`.
* **Why It Is Important:** Enables inspection and verification of client counters.
* **Position in Request Flow:** Post-request verification / Diagnostic.

---

### `MemoryStore.prototype.set(key, value, ttlMs)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Manual state overrides, tests.
* **Use & Purpose:** Sets a key-value pair into the Map with an optional unreferenced timeout for TTL cleanup.
* **Why It Is Important:** Standard key-value storage setter.
* **Position in Request Flow:** Optional manual setup/override.

---

### `MemoryStore.prototype.delete(key)` & `reset(key)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Administrative reset or programmatic clearing of a client's quota.
* **Use & Purpose:** Removes a key from the Map (`this.data.delete(key)`).
* **Why It Is Important:** Allows manually unblocking an IP or resetting limits on demand.
* **Position in Request Flow:** Out-of-band / Administrative.

---

### `MemoryStore.prototype.has(key)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Diagnostics / unit tests.
* **Use & Purpose:** Checks if a key exists in `this.data`.
* **Why It Is Important:** Fast membership query.
* **Position in Request Flow:** Out-of-band.

---

### `MemoryStore.prototype.clear()`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Test cleanup between test suites.
* **Use & Purpose:** Empties all records from `this.data`.
* **Why It Is Important:** Ensures test isolation and prevents cross-test state leakage.
* **Position in Request Flow:** Test teardown.

---

### `MemoryStore.prototype.increment(key, amount, ttlMs)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Numeric counter algorithms.
* **Use & Purpose:** Atomically increments a numeric key by `amount`.
* **Why It Is Important:** General-purpose counter primitive.
* **Position in Request Flow:** Runtime counter operations.

---

### `MemoryStore.prototype.eval(fn, key, args)`
* **Defined In:** `src/storage/memoryStore.js`
* **Called By / Used In:** Advanced script execution.
* **Use & Purpose:** Executes a custom JavaScript function synchronously on `this.data`.
* **Why It Is Important:** In-memory equivalent of Redis `eval()`.
* **Position in Request Flow:** Scriptable execution.

---

### `RedisStore.constructor(redisClient)`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** Distributed application setup.
* **Use & Purpose:** Initializes RedisStore with a Redis client instance (e.g. `ioredis` or `redis`).
* **Why It Is Important:** Connects the rate-limiting library to a centralized Redis server or cluster.
* **Position in Request Flow:** **Setup Phase.**

---

### `RedisStore.prototype._ensureClient()`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** Internal helper before any Redis operation.
* **Use & Purpose:** Throws an error (`Redis client not configured`) if `this.client` is undefined.
* **Why It Is Important:** Guards against runtime failures by failing fast if Redis is uninitialized.
* **Position in Request Flow:** Runtime validation.

---

### `RedisStore.prototype.get(key)`, `set(key, value, ttlMs)`, `delete(key)`, `reset(key)`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** External state inspection and administrative management.
* **Use & Purpose:** Translates JavaScript objects to/from JSON strings and executes native Redis commands (`GET`, `SET PX`, `DEL`).
* **Why It Is Important:** Standard distributed key-value interface.
* **Position in Request Flow:** Runtime / Admin operations.

---

### `RedisStore.prototype.increment(key, amount, ttlMs)`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** Numeric atomic increments across distributed nodes.
* **Use & Purpose:** Uses Redis `MULTI` / `INCRBY` / `PEXPIRE` / `EXEC` pipeline to increment a key and set TTL atomically.
* **Why It Is Important:** Safe atomic integer counter across multiple servers.
* **Position in Request Flow:** Runtime.

---

### `RedisStore.prototype.mutate(key, reducerFn, ttlMs)`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()`.
* **Use & Purpose:** Fetches JSON state from Redis, passes it to `reducerFn()`, and saves the serialized `nextState` with optional TTL.
* **Why It Is Important:** Distributed implementation of the state-machine reducer.
* **Position in Request Flow:** **Runtime Phase (State Transition).**

---

### `RedisStore.prototype.eval(script, keys, args)`
* **Defined In:** `src/storage/redisStore.js`
* **Called By / Used In:** Custom Lua script executions.
* **Use & Purpose:** Executes Redis `EVAL` with keys and arguments.
* **Why It Is Important:** Allows executing transactional Redis Lua scripts directly on the Redis single-threaded engine.
* **Position in Request Flow:** Advanced runtime operations.

---

## 4. Clock Layer

### `SystemClock.prototype.now()`
* **Defined In:** `src/clock/systemClock.js`
* **Called By / Used In:** `BaseAlgorithm.prototype.check()`, `RateLimiter.prototype.middleware()`.
* **Use & Purpose:** Returns `Date.now()`, representing the current Unix time in milliseconds.
* **Why It Is Important:** Decouples time retrieval from algorithm logic, allowing production code to use real time while tests swap in deterministic simulated clocks.
* **Position in Request Flow:** **Runtime Phase (Timestamp Resolution).**

---

### `FakeClock.constructor(startTime)`
* **Defined In:** `src/test/helpers/fakeClock.js`
* **Called By / Used In:** Unit and integration tests (`fixedWindow.test.js`, `rateLimiter.test.js`, `rateLimiter.integration.js`).
* **Use & Purpose:** Initializes simulated time at `startTime` (defaults to 0).
* **Why It Is Important:** Enables deterministic time testing without `setTimeout` delays.
* **Position in Request Flow:** **Test Setup.**

---

### `FakeClock.prototype.now()`
* **Defined In:** `src/test/helpers/fakeClock.js`
* **Called By / Used In:** Replaces `SystemClock.prototype.now()` in tests.
* **Use & Purpose:** Returns `this.currentTime`.
* **Why It Is Important:** Returns virtual, controllable time to algorithms during test runs.
* **Position in Request Flow:** **Test Runtime.**

---

### `FakeClock.prototype.advance(milliseconds)`
* **Defined In:** `src/test/helpers/fakeClock.js`
* **Called By / Used In:** Tests simulating window expiration (e.g. `clock.advance(60000)`).
* **Use & Purpose:** Adds `milliseconds` to `this.currentTime`.
* **Why It Is Important:** Allows instantaneous testing of time-based window resets without waiting real seconds.
* **Position in Request Flow:** Test execution.

---

### `FakeClock.prototype.set(time)`
* **Defined In:** `src/test/helpers/fakeClock.js`
* **Called By / Used In:** Tests setting explicit timestamps.
* **Use & Purpose:** Manually sets `this.currentTime = time`.
* **Why It Is Important:** Jumps virtual time to specific boundaries.
* **Position in Request Flow:** Test execution.

---

## 5. Client Identifier Layer

### `identifier(req)`
* **Defined In:** `src/identifiers/identifier.js`
* **Called By / Used In:** Default `keyGenerator` in `RateLimiter.constructor`.
* **Use & Purpose:** Derives the client identity from the Express request: `req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'`.
* **Why It Is Important:** Ensures that every unique client IP has an independent rate-limiting bucket.
* **Position in Request Flow:** **Runtime Phase (Request Ingestion).** First step inside the middleware.

---

## 6. Utilities and Errors

### `now()`
* **Defined In:** `src/utils/time.js`
* **Called By / Used In:** Utility helper module.
* **Use & Purpose:** Returns `Date.now()`.
* **Why It Is Important:** Standalone helper function for raw timestamp retrieval.
* **Position in Request Flow:** Utility.

---

### `validateOptions(opts)`
* **Defined In:** `src/utils/validation.js`
* **Called By / Used In:** Configuration validation helper.
* **Use & Purpose:** Validates options object and returns options or `{}` if null.
* **Why It Is Important:** Scaffold for centralizing option schema checks.
* **Position in Request Flow:** Setup Phase.

---

### `RateLimitError.constructor(message)`
* **Defined In:** `src/errors/errors.js`
* **Called By / Used In:** Custom rate-limit exception handling.
* **Use & Purpose:** Extends native `Error` with `this.name = 'RateLimitError'` and `this.status = 429`.
* **Why It Is Important:** Provides a standardized custom error class if rate limits are thrown as exceptions instead of returning JSON.
* **Position in Request Flow:** Exception handling.

---

## 7. Request Flow Lifecycle Diagram

```
Incoming Request (GET /)
           │
           ▼
1. RateLimiter.middleware()
   │
   ├──► 2. identifier(req)  [src/identifiers/identifier.js]
   │       └── Returns client IP: "127.0.0.1"
   │
   └──► 3. BaseAlgorithm.check(identifier)  [src/algorithms/baseAlgorithm.js]
           │
           ├──► 4. SystemClock.now()  [src/clock/systemClock.js]
           │       └── Returns timestamp: 1700000000000
           │
           ├──► 5. FixedWindow.getTtlMs(now)  [src/algorithms/fixedWindow.js]
           │       └── Returns TTL: 60000 ms
           │
           └──► 6. MemoryStore.mutate(key, computeFn, ttlMs)  [src/storage/memoryStore.js]
                   │
                   └──► 7. FixedWindow.compute(state, now)  [src/algorithms/fixedWindow.js]
                           └── Evaluates window/limits & returns { nextState, result }
   │
   ▼
8. RateLimiter.setHeaders(res, result)  [src/middleware/rateLimiter.js]
   └── Sets X-RateLimit-Limit, Remaining, Reset
   │
   ├── [If allowed === true]  ──► Calls next() ──► Route Handler (200 OK)
   └── [If allowed === false] ──► Sets Retry-After ──► res.status(429).json(...)
```
