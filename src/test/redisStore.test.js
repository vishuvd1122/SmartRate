const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const RedisStore = require("../storage/redisStore");
const FakeRedisClient = require("./helpers/fakeRedisClient");
const FakeClock = require("./helpers/fakeClock");
const { StorageError, ConcurrencyContentionError } = require("../errors/errors");

const FixedWindow = require("../algorithms/fixedWindow");
const TokenBucket = require("../algorithms/tokenBucket");
const SlidingWindowLog = require("../algorithms/slidingWindowLog");
const LeakyBucket = require("../algorithms/leakyBucket");
const RateLimiter = require("../middleware/rateLimiter");

// ============================================================================
// 1. RedisStore Initialization & Configuration
// ============================================================================

test("RedisStore: should initialize with sensible default options", () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  assert.strictEqual(store.client, client);
  assert.strictEqual(store.prefix, "smartrate:");
  assert.strictEqual(store.maxRetries, 3);
  assert.strictEqual(store.retryDelayMs, 10);
  assert.strictEqual(store.ownsClient, false);
});

test("RedisStore: should accept custom configuration options", () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, {
    prefix: "api:ratelimit:",
    maxRetries: 5,
    retryDelayMs: 5,
    ownsClient: true,
  });

  assert.strictEqual(store.prefix, "api:ratelimit:");
  assert.strictEqual(store.maxRetries, 5);
  assert.strictEqual(store.retryDelayMs, 5);
  assert.strictEqual(store.ownsClient, true);
});

test("RedisStore: _resolveKey should apply prefix and avoid duplicate prefixing", () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "smartrate:" });

  assert.strictEqual(store._resolveKey("user123"), "smartrate:user123");
  assert.strictEqual(store._resolveKey("smartrate:user123"), "smartrate:user123");

  const noPrefixStore = new RedisStore(client, { prefix: "" });
  assert.strictEqual(noPrefixStore._resolveKey("user123"), "user123");
});

test("RedisStore: should throw StorageError if client is not configured", async () => {
  const store = new RedisStore(null);
  await assert.rejects(
    async () => {
      await store.get("key");
    },
    (err) => err instanceof StorageError && /Redis client not configured/.test(err.message)
  );
});

// ============================================================================
// 2. Client Isolation & Unsafe Fallback Rejection (Issue 1 & 2)
// ============================================================================

test("RedisStore: fails fast if client does not support transaction isolation", async () => {
  // A raw client without executeIsolated or duplicate
  const unsafeClient = {
    get: async () => null,
    set: async () => "OK",
    watch: async () => "OK",
    multi: () => ({ set: () => {}, exec: async () => ["OK"] }),
  };

  const store = new RedisStore(unsafeClient);

  await assert.rejects(
    async () => {
      await store.mutate("testKey", () => ({ nextState: { count: 1 }, result: {} }));
    },
    (err) =>
      err instanceof StorageError &&
      /does not support transaction isolation/.test(err.message)
  );
});

test("RedisStore: connection error during duplicate() propagates as StorageError (Issue 3)", async () => {
  // Client without executeIsolated, providing only duplicate()
  const client = {
    duplicate: () => ({
      connect: async () => {
        throw new Error("ECONNREFUSED: Redis offline");
      },
    }),
  };

  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.mutate("testKey", () => ({ nextState: { count: 1 }, result: {} }));
    },
    (err) => err instanceof StorageError && /ECONNREFUSED/.test(err.cause?.message || err.message)
  );
});

// ============================================================================
// 3. Serialization & Corrupted State Semantics (Issue 5 & 22)
// ============================================================================

test("RedisStore: get() throws StorageError on corrupted JSON state (never returns null)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "test:" });

  await client.set("test:corruptKey", "INVALID_JSON_CORRUPTED{{{");

  await assert.rejects(
    async () => {
      await store.get("corruptKey");
    },
    (err) =>
      err instanceof StorageError &&
      /Corrupted state encountered in Redis/.test(err.message)
  );
});

test("RedisStore: mutate() throws StorageError on corrupted JSON state (never returns null)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "test:" });

  await client.set("test:corruptKey", "{ corrupt JSON broken");

  await assert.rejects(
    async () => {
      await store.mutate("corruptKey", (curr) => ({ nextState: curr, result: {} }));
    },
    (err) =>
      err instanceof StorageError &&
      /Corrupted state encountered in Redis/.test(err.message)
  );
});

test("RedisStore: throws StorageError when value is not JSON serializable (Issue 22)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  const circular = {};
  circular.self = circular;

  await assert.rejects(
    async () => {
      await store.set("circKey", circular);
    },
    (err) => err instanceof StorageError && /not JSON-serializable/.test(err.message)
  );
});

// ============================================================================
// 4. Reducer Error Isolation (Issue 8)
// ============================================================================

test("RedisStore: custom reducer error is directly rethrown without wrapping in StorageError", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  class CustomBusinessError extends Error {
    constructor(msg) {
      super(msg);
      this.name = "CustomBusinessError";
    }
  }

  await assert.rejects(
    async () => {
      await store.mutate("userKey", () => {
        throw new CustomBusinessError("Validation failed inside algorithm reducer");
      });
    },
    (err) => {
      assert.strictEqual(err.name, "CustomBusinessError");
      assert.ok(!(err instanceof StorageError), "Reducer error must not be wrapped in StorageError");
      return true;
    }
  );
});

// ============================================================================
// 5. Connection Lifecycle & Ownership (Issue 12 & 13)
// ============================================================================

test("RedisStore: close() does not disconnect client when ownsClient is false (default)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { ownsClient: false });

  await store.close();
  assert.strictEqual(client.connected, true, "Injected client should remain connected");
});

test("RedisStore: close() disconnects client when ownsClient is true", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { ownsClient: true });

  await store.close();
  assert.strictEqual(client.connected, false, "Client should be disconnected when ownsClient is true");
});

// ============================================================================
// 6. Basic CRUD & Increment TTL Semantics (Issue 6 & 7)
// ============================================================================

test("RedisStore: get, set, delete, and reset operations with valid JSON serialization", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "test:" });

  // 1. get non-existent key returns null
  const missing = await store.get("missingKey");
  assert.strictEqual(missing, null);

  // 2. set and get object
  const userObj = { count: 3, windowStart: 1000 };
  await store.set("clientA", userObj, 5000);
  const fetched = await store.get("clientA");
  assert.deepStrictEqual(fetched, userObj);

  // Verify prefix was applied in underlying Redis storage
  const rawUnderlying = await client.get("test:clientA");
  assert.strictEqual(typeof rawUnderlying, "string");
  assert.deepStrictEqual(JSON.parse(rawUnderlying), userObj);

  // 3. delete key
  const delRes = await store.delete("clientA");
  assert.strictEqual(delRes, 1);
  assert.strictEqual(await store.get("clientA"), null);

  // 4. reset key
  await store.set("clientB", { val: 42 });
  assert.notStrictEqual(await store.get("clientB"), null);
  await store.reset("clientB");
  assert.strictEqual(await store.get("clientB"), null);
});

test("RedisStore: increment does not extend existing TTL on continuous traffic (Issue 6 & 7)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "test:" });

  // 1st increment creates key with 60000ms TTL
  const val1 = await store.increment("counterA", 1, 60000);
  assert.strictEqual(val1, 1);

  const initialExpiresAt = client.storage.get("test:counterA").expiresAt;
  assert.ok(initialExpiresAt > 0, "Key should have active TTL");

  // 2nd increment should NOT extend expiresAt
  const val2 = await store.increment("counterA", 1, 60000);
  assert.strictEqual(val2, 2);

  const secondExpiresAt = client.storage.get("test:counterA").expiresAt;
  assert.strictEqual(
    secondExpiresAt,
    initialExpiresAt,
    "Second increment must not refresh or extend the TTL"
  );
});

test("RedisStore: eval executes with prefixed keys", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { prefix: "test:" });

  const evalRes = await store.eval("return 1", ["myKey"], ["arg1"]);
  assert.strictEqual(evalRes, "OK");
});

// ============================================================================
// 7. Connection Isolation: Cross-Key Independence (Issue 1 & 25)
// ============================================================================

test("Connection Isolation: concurrent operations on different keys never block or clobber each other", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);

  const limiter = new FixedWindow({ limit: 5, window: 60000 }, store, clock);

  // Concurrently hit 10 DIFFERENT keys simultaneously
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => limiter.check(`user-${i}`))
  );

  // Every single distinct user should be allowed on their first request
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(results[i].allowed, true);
    assert.strictEqual(results[i].remaining, 4);
  }
});

// ============================================================================
// 8. Algorithm Integration: All 4 Algorithms Work Seamlessly
// ============================================================================

test("FixedWindow + RedisStore: basic allow and block flow", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);

  const limiter = new FixedWindow({ limit: 3, window: 60000 }, store, clock);

  const r1 = await limiter.check("client1");
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);

  const r2 = await limiter.check("client1");
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  const r3 = await limiter.check("client1");
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  const r4 = await limiter.check("client1");
  assert.strictEqual(r4.allowed, false);
  assert.strictEqual(r4.remaining, 0);
});

test("FixedWindow + RedisStore: window reset over time", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);

  const limiter = new FixedWindow({ limit: 2, window: 60000 }, store, clock);

  await limiter.check("client1");
  await limiter.check("client1");
  const blocked = await limiter.check("client1");
  assert.strictEqual(blocked.allowed, false);

  clock.advance(60001);

  const afterReset = await limiter.check("client1");
  assert.strictEqual(afterReset.allowed, true);
  assert.strictEqual(afterReset.remaining, 1);
});

test("TokenBucket + RedisStore: token consumption and refill", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(0);

  const limiter = new TokenBucket(
    { capacity: 5, tokensPerInterval: 1, interval: 1000 },
    store,
    clock
  );

  for (let i = 0; i < 5; i++) {
    const res = await limiter.check("user-tb");
    assert.strictEqual(res.allowed, true);
  }

  const blocked = await limiter.check("user-tb");
  assert.strictEqual(blocked.allowed, false);

  clock.advance(2000);

  const refilled1 = await limiter.check("user-tb");
  assert.strictEqual(refilled1.allowed, true);

  const refilled2 = await limiter.check("user-tb");
  assert.strictEqual(refilled2.allowed, true);

  const emptyAgain = await limiter.check("user-tb");
  assert.strictEqual(emptyAgain.allowed, false);
});

test("TokenBucket + RedisStore: weighted request cost", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(0);

  const limiter = new TokenBucket(
    { capacity: 10, refillRate: 1, cost: 4 },
    store,
    clock
  );

  const r1 = await limiter.check("user-weighted");
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 6);

  const r2 = await limiter.check("user-weighted");
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 2);

  const r3 = await limiter.check("user-weighted");
  assert.strictEqual(r3.allowed, false);
});

test("SlidingWindowLog + RedisStore: timestamps stored and pruned in Redis JSON state", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);

  const limiter = new SlidingWindowLog(
    { limit: 3, window: 10000 },
    store,
    clock
  );

  const r1 = await limiter.check("user-swl");
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);

  clock.advance(1000);
  const r2 = await limiter.check("user-swl");
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  clock.advance(1000);
  const r3 = await limiter.check("user-swl");
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  clock.advance(1000);
  const r4 = await limiter.check("user-swl");
  assert.strictEqual(r4.allowed, false);

  clock.set(11001);
  const r5 = await limiter.check("user-swl");
  assert.strictEqual(r5.allowed, true);
});

test("LeakyBucket + RedisStore: FIFO queue leaking over time in Redis", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);

  const limiter = new LeakyBucket(
    { capacity: 3, leakInterval: 1000 },
    store,
    clock
  );

  const r1 = await limiter.check("user-lb");
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);

  const r2 = await limiter.check("user-lb");
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  const r3 = await limiter.check("user-lb");
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  const r4 = await limiter.check("user-lb");
  assert.strictEqual(r4.allowed, false);

  clock.advance(2000);

  const r5 = await limiter.check("user-lb");
  assert.strictEqual(r5.allowed, true);
  assert.strictEqual(r5.remaining, 1);
});

// ============================================================================
// 9. Concurrency & Contention under Parallel Load (Issue 23, 24, 26, 27)
// ============================================================================

test("Concurrency: FixedWindow handles 30 concurrent requests with atomic precision", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 35, retryDelayMs: 2 });
  const clock = new FakeClock(1000);

  const limiter = new FixedWindow({ limit: 10, window: 60000 }, store, clock);

  const results = await Promise.all(
    Array.from({ length: 30 }, () => limiter.check("concurrent-client"))
  );

  const allowedCount = results.filter((r) => r.allowed).length;
  const blockedCount = results.filter((r) => !r.allowed).length;

  assert.strictEqual(allowedCount, 10, "Exactly 10 requests should be allowed");
  assert.strictEqual(blockedCount, 20, "Exactly 20 requests should be blocked");

  const finalState = await store.get("concurrent-client");
  assert.strictEqual(finalState.count, 10);
});

test("Concurrency: Duplicated clients (distributed connections) properly detect conflicts", async () => {
  const clientA = new FakeRedisClient();
  const clientB = clientA.duplicate();

  const storeA = new RedisStore(clientA, { maxRetries: 10, retryDelayMs: 2 });
  const storeB = new RedisStore(clientB, { maxRetries: 10, retryDelayMs: 2 });
  const clock = new FakeClock(1000);

  const limiterA = new FixedWindow({ limit: 4, window: 60000 }, storeA, clock);
  const limiterB = new FixedWindow({ limit: 4, window: 60000 }, storeB, clock);

  const calls = [
    limiterA.check("shared-user"),
    limiterB.check("shared-user"),
    limiterA.check("shared-user"),
    limiterB.check("shared-user"),
    limiterA.check("shared-user"),
    limiterB.check("shared-user"),
    limiterA.check("shared-user"),
    limiterB.check("shared-user"),
  ];

  const results = await Promise.all(calls);
  const allowed = results.filter((r) => r.allowed).length;
  const blocked = results.filter((r) => !r.allowed).length;

  assert.strictEqual(allowed, 4, "Overall limit of 4 should be strictly preserved across connections");
  assert.strictEqual(blocked, 4, "Excess 4 requests should be blocked");
});

test("Contention: mutate throws ConcurrencyContentionError when contention exceeds maxRetries", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 2, retryDelayMs: 1 });
  const clock = new FakeClock(1000);
  const limiter = new FixedWindow({ limit: 5, window: 60000 }, store, clock);

  client.forceWatchConflict = true;

  await assert.rejects(
    async () => {
      await limiter.check("contention-client");
    },
    (err) => err instanceof ConcurrencyContentionError
  );
});

// ============================================================================
// 10. RateLimiter Middleware & failOpen Integration (Issue 19 & 20)
// ============================================================================

test("RateLimiter Middleware: allowed requests receive headers and pass to next()", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);
  const algorithm = new FixedWindow({ limit: 5, window: 60000 }, store, clock);

  const limiter = new RateLimiter(algorithm, { clock });
  const middleware = limiter.middleware();

  const req = { ip: "192.168.1.100" };
  const headers = {};
  const res = {
    setHeader(name, val) {
      headers[name] = val;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  await middleware(req, res, next);

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(headers["X-RateLimit-Limit"], 5);
  assert.strictEqual(headers["X-RateLimit-Remaining"], 4);
  assert.strictEqual(headers["X-RateLimit-Reset"], Math.ceil((1000 + 60000) / 1000));
});

test("RateLimiter Middleware: blocked requests return 429 and Retry-After", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);
  const algorithm = new FixedWindow({ limit: 1, window: 60000 }, store, clock);

  const limiter = new RateLimiter(algorithm, { clock });
  const middleware = limiter.middleware();

  const req = { ip: "192.168.1.200" };
  const headers = {};
  let statusCode = 200;
  let jsonResponse = null;

  const res = {
    setHeader(name, val) {
      headers[name] = val;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonResponse = body;
    },
  };

  // 1st request -> allowed
  await middleware(req, res, () => {});

  // 2nd request -> blocked
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(statusCode, 429);
  assert.strictEqual(headers["X-RateLimit-Remaining"], 0);
  assert.strictEqual(headers["Retry-After"], 60);
  assert.strictEqual(jsonResponse.error, "Too Many Requests");
});

test("RateLimiter Middleware: failOpen=false passes StorageError to Express error handler (HTTP 500)", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);
  const algorithm = new FixedWindow({ limit: 5, window: 60000 }, store, clock);

  const limiter = new RateLimiter(algorithm, { failOpen: false });
  const middleware = limiter.middleware();

  client.shouldThrow = new Error("ECONNREFUSED");

  let caughtError = null;
  await middleware({ ip: "10.0.0.1" }, {}, (err) => {
    caughtError = err;
  });

  assert.ok(caughtError instanceof StorageError);
});

test("RateLimiter Middleware: failOpen=true gracefully permits request when StorageError occurs", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);
  const clock = new FakeClock(1000);
  const algorithm = new FixedWindow({ limit: 5, window: 60000 }, store, clock);

  const limiter = new RateLimiter(algorithm, { failOpen: true });
  const middleware = limiter.middleware();

  client.shouldThrow = new Error("ECONNREFUSED: Redis down");

  const headers = {};
  const res = {
    setHeader(name, val) {
      headers[name] = val;
    },
  };
  let nextCalled = false;
  await middleware({ ip: "10.0.0.2" }, res, (err) => {
    assert.strictEqual(err, undefined);
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true, "Request should pass through to route handler");
  assert.strictEqual(headers["X-RateLimit-Degraded"], "true");
});

// ============================================================================
// 10. Issue #1: increment() Contract & Semantics
// ============================================================================

test("RedisStore increment: new key created with amount and sets ttlMs", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  const res = await store.increment("counterA", 5, 5000);
  assert.strictEqual(res, 5);

  const ttl = await client.pttl("smartrate:counterA");
  assert.ok(ttl > 0 && ttl <= 5000, `Expected TTL around 5000ms, got ${ttl}`);
});

test("RedisStore increment: existing key increments amount and strictly preserves remaining TTL", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // 1st call creates key with 10,000ms TTL
  await store.increment("counterB", 2, 10000);
  const ttlBefore = await client.pttl("smartrate:counterB");
  assert.ok(ttlBefore > 0);

  // 2nd call increments with a different ttlMs (which must be ignored because key already exists)
  const res2 = await store.increment("counterB", 3, 50000);
  assert.strictEqual(res2, 5);

  const ttlAfter = await client.pttl("smartrate:counterB");
  // Remaining TTL should be preserved around 10000ms, NOT extended to 50000ms
  assert.ok(ttlAfter <= 10000, `TTL was incorrectly extended: ${ttlAfter}`);
});

test("RedisStore increment: amount = 0 returns current value without modifying", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await store.increment("counterC", 10);
  const val = await store.increment("counterC", 0);
  assert.strictEqual(val, 10);
});

test("RedisStore increment: negative amount decrements value correctly", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await store.increment("counterD", 10);
  const val = await store.increment("counterD", -4);
  assert.strictEqual(val, 6);
});

test("RedisStore increment: throws StorageError when key contains non-numeric string", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await client.set("smartrate:textKey", "not_a_number");

  await assert.rejects(
    async () => {
      await store.increment("textKey", 1);
    },
    (err) => err instanceof StorageError && /contains non-numeric value/.test(err.message)
  );
});

test("RedisStore increment: throws StorageError when amount argument is NaN or not a number", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.increment("counterKey", NaN);
    },
    (err) => err instanceof StorageError && /valid number/.test(err.message)
  );

  await assert.rejects(
    async () => {
      await store.increment("counterKey", "five");
    },
    (err) => err instanceof StorageError && /valid number/.test(err.message)
  );
});

// ============================================================================
// 11. Issue #6: Strict Serialization Contract
// ============================================================================

test("RedisStore serialization: throws StorageError for BigInt values", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.set("bigintKey", BigInt(12345));
    },
    (err) => err instanceof StorageError && /contains non-serializable type/.test(err.message)
  );

  await assert.rejects(
    async () => {
      await store.mutate("bigintKeyMutate", () => ({ nextState: BigInt(99), result: {} }));
    },
    (err) => err instanceof StorageError && /contains non-serializable type/.test(err.message)
  );
});

test("RedisStore serialization: throws StorageError for Symbol values", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.set("symbolKey", Symbol("test"));
    },
    (err) => err instanceof StorageError && /contains non-serializable type/.test(err.message)
  );
});

test("RedisStore serialization: throws StorageError for Function values", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.set("fnKey", () => {});
    },
    (err) => err instanceof StorageError && /contains non-serializable type/.test(err.message)
  );
});

test("RedisStore serialization: throws StorageError for circular objects", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  const circular = {};
  circular.self = circular;

  await assert.rejects(
    async () => {
      await store.set("circularKey", circular);
    },
    (err) => err instanceof StorageError && /not JSON-serializable/.test(err.message)
  );
});

// ============================================================================
// 12. Issue #14: TTL + OCC Requirements
// ============================================================================

test("TTL + OCC: Test A - normal mutation updates state and applies TTL according to contract", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await store.mutate("userA", () => ({ nextState: { count: 1 }, result: { allowed: true } }), 10000);
  const ttl1 = await client.pttl("smartrate:userA");
  assert.ok(ttl1 > 0 && ttl1 <= 10000);

  // Subsequent mutation succeeds and preserves/refreshes window TTL
  await store.mutate("userA", (curr) => ({ nextState: { count: curr.count + 1 }, result: { allowed: true } }), 10000);
  const ttl2 = await client.pttl("smartrate:userA");
  assert.ok(ttl2 > 0 && ttl2 <= 10000);
});

test("TTL + OCC: Test B - initial creation applies TTL correctly", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  assert.strictEqual(await client.get("smartrate:newKey"), null);
  await store.mutate("newKey", () => ({ nextState: { created: true }, result: "ok" }), 5000);

  const raw = await client.get("smartrate:newKey");
  assert.deepStrictEqual(JSON.parse(raw), { created: true });
  const ttl = await client.pttl("smartrate:newKey");
  assert.ok(ttl > 0 && ttl <= 5000);
});

test("TTL + OCC: Test C - concurrent mutation retries and maintains valid state and TTL", async () => {
  const client = new FakeRedisClient();
  const store1 = new RedisStore(client);
  const store2 = new RedisStore(client);

  const res = await Promise.all([
    store1.mutate("concurrentKey", (curr) => {
      const count = curr ? curr.count + 1 : 1;
      return { nextState: { count }, result: count };
    }, 60000),
    store2.mutate("concurrentKey", (curr) => {
      const count = curr ? curr.count + 1 : 1;
      return { nextState: { count }, result: count };
    }, 60000),
  ]);

  assert.deepStrictEqual(res.sort(), [1, 2]);
  const finalState = JSON.parse(await client.get("smartrate:concurrentKey"));
  assert.strictEqual(finalState.count, 2);
  const ttl = await client.pttl("smartrate:concurrentKey");
  assert.ok(ttl > 0 && ttl <= 60000);
});

test("TTL + OCC: Test D - expiration between WATCH/GET and EXEC correctly creates fresh state", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 3 });

  // Key exists initially
  await client.set("smartrate:expiringKey", JSON.stringify({ count: 5 }));

  let callCount = 0;
  await store.mutate("expiringKey", (curr) => {
    callCount++;
    if (callCount === 1) {
      // Simulate key expired and another process wrote a new key before EXEC
      client.set("smartrate:expiringKey", JSON.stringify({ count: 1 }));
    }
    return {
      nextState: { count: (curr?.count || 0) + 1 },
      result: (curr?.count || 0) + 1,
    };
  }, 10000);

  assert.strictEqual(callCount, 2, "Should have conflicted on 1st attempt and retried on 2nd");
  const finalState = JSON.parse(await client.get("smartrate:expiringKey"));
  // 1 (written by simulating process) + 1 (from 2nd retry attempt) = 2
  assert.strictEqual(finalState.count, 2);
});

test("TTL + OCC: Test E - expired key recreation does not inherit stale window state", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // Initial window
  await store.mutate("staleTestKey", () => ({ nextState: { count: 100 }, result: {} }), 10);

  // Key expires in Redis
  await client.del("smartrate:staleTestKey");

  // New window should see null/missing state, not stale 100
  let receivedCurrent = "NOT_CALLED";
  await store.mutate("staleTestKey", (curr) => {
    receivedCurrent = curr;
    return { nextState: { count: 1 }, result: {} };
  });

  assert.strictEqual(receivedCurrent, null);
  const state = JSON.parse(await client.get("smartrate:staleTestKey"));
  assert.strictEqual(state.count, 1);
});

// ============================================================================
// 13. Issue #16: Deterministic Forced-Conflict Test
// ============================================================================

test("Forced Conflict: Client A WATCH/GET, Client B modifies key, Client A EXEC fails, retries, and commits", async () => {
  const client = new FakeRedisClient();
  const storeA = new RedisStore(client, { maxRetries: 3, retryDelayMs: 2 });
  const storeB = new RedisStore(client);

  await storeA.set("targetKey", { balance: 100 });

  let attempt = 0;
  const result = await storeA.mutate("targetKey", (curr) => {
    attempt++;
    if (attempt === 1) {
      // Synchronously simulate Client B modifying targetKey right after Client A's GET
      client.storage.set("smartrate:targetKey", {
        value: JSON.stringify({ balance: 150 }),
        expiresAt: null,
      });
      client._bumpVersion("smartrate:targetKey");
    }
    return {
      nextState: { balance: curr.balance + 10 },
      result: curr.balance + 10,
    };
  });

  // Attempt 1: read 100 -> Client B wrote 150 -> EXEC failed (version mismatch).
  // Attempt 2: retried -> read 150 -> calculated 150 + 10 = 160 -> EXEC succeeded.
  assert.strictEqual(attempt, 2, "Reducer should run twice due to OCC conflict retry");
  assert.strictEqual(result, 160, "Result should be based on latest state (150 + 10)");

  const finalStored = JSON.parse(await client.get("smartrate:targetKey"));
  assert.strictEqual(finalStored.balance, 160);
});

// ============================================================================
// 14. Issue #17: Retry Exhaustion Test
// ============================================================================

test("Retry Exhaustion: exactly maxRetries + 1 attempts executed before throwing ConcurrencyContentionError without corrupting state", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 3, retryDelayMs: 1 });

  await store.set("exhaustionKey", { count: 42 });

  // Force every exec() to conflict
  client.forceWatchConflict = true;

  let invocationCount = 0;
  await assert.rejects(
    async () => {
      await store.mutate("exhaustionKey", (curr) => {
        invocationCount++;
        return { nextState: { count: curr.count + 1 }, result: {} };
      });
    },
    (err) => err instanceof ConcurrencyContentionError && /exceeded max retries \(3\)/.test(err.message)
  );

  // Exactly attempt 0, 1, 2, 3 = 4 invocations
  assert.strictEqual(invocationCount, 4);

  // Verify stored state in Redis was untouched and not corrupted
  const state = JSON.parse(await client.get("smartrate:exhaustionKey"));
  assert.strictEqual(state.count, 42, "Original state must remain uncorrupted");
});

// ============================================================================
// 15. Issue #18: Connection Lifecycle Tests
// ============================================================================

test("Connection Lifecycle: connection is released on successful mutation", async () => {
  let releaseCalled = false;
  const client = {
    executeIsolated: async (fn) => {
      const mockConn = {
        watch: async () => "OK",
        get: async () => JSON.stringify({ count: 1 }),
        multi: () => ({ set: () => {}, exec: async () => ["OK"] }),
        unwatch: async () => {
          releaseCalled = true;
          return "OK";
        },
      };
      return fn(mockConn);
    },
  };

  const store = new RedisStore(client);
  await store.mutate("connKey", (curr) => ({ nextState: { count: 2 }, result: "ok" }));
  assert.strictEqual(releaseCalled, true, "UNWATCH must be called in finally block");
});

test("Connection Lifecycle: connection is released when reducer throws an error", async () => {
  let unwatchCalled = false;
  const client = {
    executeIsolated: async (fn) => {
      const mockConn = {
        watch: async () => "OK",
        get: async () => JSON.stringify({ count: 1 }),
        unwatch: async () => {
          unwatchCalled = true;
          return "OK";
        },
      };
      return fn(mockConn);
    },
  };

  const store = new RedisStore(client);
  await assert.rejects(
    async () => {
      await store.mutate("connKey", () => {
        throw new Error("Reducer business error");
      });
    },
    (err) => err.message === "Reducer business error"
  );

  assert.strictEqual(unwatchCalled, true, "UNWATCH must be called even when reducer throws");
});

test("Connection Lifecycle: connection is released when Redis operations fail", async () => {
  let unwatchCalled = false;
  const client = {
    executeIsolated: async (fn) => {
      const mockConn = {
        watch: async () => "OK",
        get: async () => {
          throw new Error("ECONNRESET");
        },
        unwatch: async () => {
          unwatchCalled = true;
          return "OK";
        },
      };
      return fn(mockConn);
    },
  };

  const store = new RedisStore(client);
  await assert.rejects(
    async () => {
      await store.mutate("connKey", () => ({ nextState: {}, result: {} }));
    },
    (err) => err instanceof StorageError
  );

  assert.strictEqual(unwatchCalled, true, "UNWATCH must be called on Redis failure");
});

test("Connection Lifecycle: connection is released when retry limit is exhausted", async () => {
  let unwatchCount = 0;
  const client = {
    executeIsolated: async (fn) => {
      const mockConn = {
        watch: async () => "OK",
        get: async () => null,
        multi: () => ({ set: () => {}, exec: async () => null }), // always conflict
        unwatch: async () => {
          unwatchCount++;
          return "OK";
        },
      };
      return fn(mockConn);
    },
  };

  const store = new RedisStore(client, { maxRetries: 2, retryDelayMs: 1 });
  await assert.rejects(
    async () => {
      await store.mutate("connKey", () => ({ nextState: { x: 1 }, result: {} }));
    },
    (err) => err instanceof ConcurrencyContentionError
  );

  // maxRetries = 2 -> 3 attempts -> unwatch called 3 times
  assert.strictEqual(unwatchCount, 3);
});

// ============================================================================
// 16. Issue #15: Multi-Worker / Multi-Thread Concurrency Test
// ============================================================================

test("Multi-Worker Concurrency: 4 worker threads executing 100 concurrent requests allow exactly 5 and reject 95", async () => {
  const centralClient = new FakeRedisClient();
  const workerCount = 4;
  const requestsPerWorker = 25;
  const workerPromises = [];

  for (let w = 0; w < workerCount; w++) {
    const workerIsolatedClient = centralClient.duplicate();
    const worker = new Worker(path.join(__dirname, "helpers/concurrencyWorker.js"), {
      workerData: {
        identifier: "user_multi_process",
        limit: 5,
        windowMs: 60000,
        requestCount: requestsPerWorker,
      },
    });

    const p = new Promise((resolve, reject) => {
      worker.on("message", async (msg) => {
        if (msg.type === "cmd") {
          try {
            let result;
            if (msg.method === "get") {
              result = await workerIsolatedClient.get(...msg.args);
            } else if (msg.method === "set") {
              result = await workerIsolatedClient.set(...msg.args);
            } else if (msg.method === "del") {
              result = await workerIsolatedClient.del(...msg.args);
            } else if (msg.method === "watch") {
              result = await workerIsolatedClient.watch(...msg.args);
            } else if (msg.method === "unwatch") {
              result = await workerIsolatedClient.unwatch();
            } else if (msg.method === "pttl") {
              result = await workerIsolatedClient.pttl(...msg.args);
            } else if (msg.method === "multi_exec") {
              const multi = workerIsolatedClient.multi();
              for (const op of msg.args[0]) {
                if (op.cmd === "set") multi.set(...op.args);
                else if (op.cmd === "del") multi.del(...op.args);
              }
              result = await multi.exec();
            }
            worker.postMessage({ type: "resp", id: msg.id, result });
          } catch (err) {
            worker.postMessage({
              type: "resp",
              id: msg.id,
              error: { name: err.name, message: err.message },
            });
          }
        } else if (msg.type === "done") {
          worker.terminate();
          resolve(msg);
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.error));
        }
      });
      worker.on("error", (err) => {
        worker.terminate();
        reject(err);
      });
    });

    workerPromises.push(p);
  }

  const results = await Promise.all(workerPromises);
  const totalAllowed = results.reduce((acc, r) => acc + r.allowed, 0);
  const totalBlocked = results.reduce((acc, r) => acc + r.blocked, 0);

  assert.strictEqual(totalAllowed, 5, "Exactly 5 requests must be allowed across all worker threads");
  assert.strictEqual(totalBlocked, 95, "Exactly 95 requests must be blocked across all worker threads");

  // Check state in Redis
  const rawState = await centralClient.get("smartrate:user_multi_process");
  const finalState = JSON.parse(rawState);
  assert.strictEqual(finalState.count, 5, "Final count in Redis state must be exactly 5");
});

// ============================================================================
// 17. Final Hardening: Reducer Contract & Timestamp Reuse
// ============================================================================

test("Reducer Contract: reducerFn receives (currentState, now) and reuses same timestamp across OCC retries", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 3, retryDelayMs: 2 });

  await store.set("timestampKey", { count: 0 });

  const capturedTimestamps = [];
  let attempt = 0;

  const result = await store.mutate("timestampKey", (curr, now) => {
    attempt++;
    capturedTimestamps.push(now);
    assert.strictEqual(typeof now, "number");
    assert.ok(now > 0);

    if (attempt === 1) {
      // Force conflict on first attempt
      client.storage.set("smartrate:timestampKey", {
        value: JSON.stringify({ count: 1 }),
        expiresAt: null,
      });
      client._bumpVersion("smartrate:timestampKey");
    }

    return {
      nextState: { count: curr.count + 1 },
      result: { count: curr.count + 1, now },
    };
  });

  assert.strictEqual(attempt, 2, "Reducer should run twice (attempt 1 conflict, attempt 2 commit)");
  assert.strictEqual(capturedTimestamps.length, 2);
  assert.strictEqual(
    capturedTimestamps[0],
    capturedTimestamps[1],
    "Logical timestamp MUST be reused across OCC retries"
  );
  assert.strictEqual(result.now, capturedTimestamps[0]);
});

// ============================================================================
// 18. Final Hardening: Strict Serialization & Undefined Handling
// ============================================================================

test("Serialization Semantics: set() rejects undefined with StorageError", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  await assert.rejects(
    async () => {
      await store.set("undefinedKey", undefined);
    },
    (err) => err instanceof StorageError && /Cannot set undefined/.test(err.message)
  );
});

test("Serialization Semantics: mutate() preserves undefined as 'no write' signal", async () => {
  let setCalled = false;
  let unwatchCalled = false;

  const client = {
    executeIsolated: async (fn) => {
      const mockConn = {
        watch: async () => "OK",
        get: async () => JSON.stringify({ existing: "value" }),
        multi: () => ({
          set: () => {
            setCalled = true;
          },
          exec: async () => ["OK"],
        }),
        unwatch: async () => {
          unwatchCalled = true;
          return "OK";
        },
      };
      return fn(mockConn);
    },
  };

  const store = new RedisStore(client);
  const result = await store.mutate("noWriteKey", (curr) => {
    return { nextState: undefined, result: { skipped: true } };
  });

  assert.deepStrictEqual(result, { skipped: true });
  assert.strictEqual(setCalled, false, "SET must not be called when nextState is undefined");
  assert.strictEqual(unwatchCalled, true, "UNWATCH must be called on no-write signal");
});

// ============================================================================
// 19. Final Hardening: increment() Contract & Invariant #8
// ============================================================================

test("RedisStore increment: existing value equal to increment amount does NOT mistake key for new", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // Key already exists with value 5
  await client.set("smartrate:matchKey", "5");

  // Increment by 5 -> total becomes 10 (not 5)
  const newVal = await store.increment("matchKey", 5);
  assert.strictEqual(newVal, 10);

  const raw = await client.get("smartrate:matchKey");
  assert.strictEqual(raw, "10");
});

test("RedisStore increment: existing key without TTL remains without TTL", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // Set key without any expiration
  await client.set("smartrate:noTtlCounter", "10");
  assert.strictEqual(await client.pttl("smartrate:noTtlCounter"), -1);

  // Increment without ttlMs
  const newVal = await store.increment("noTtlCounter", 1);
  assert.strictEqual(newVal, 11);

  // Key should still have no TTL (-1)
  const ttl = await client.pttl("smartrate:noTtlCounter");
  assert.strictEqual(ttl, -1);
});

test("RedisStore increment: expired key is recreated as new key with fresh TTL", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // Create key with TTL of 10ms
  await store.increment("expiredCounter", 1, 10);

  // Simulate expiration
  await client.del("smartrate:expiredCounter");

  // Increment again with fresh TTL
  const nextVal = await store.increment("expiredCounter", 1, 60000);
  assert.strictEqual(nextVal, 1, "Counter should restart at 1 after expiration");

  const ttl = await client.pttl("smartrate:expiredCounter");
  assert.ok(ttl > 0 && ttl <= 60000);
});

test("Invariant #8: 100 concurrent increments against a counter starting at 0 must result in exactly 100", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 20, retryDelayMs: 2 });

  await store.set("hundredCounter", "0");

  const incrementPromises = [];
  for (let i = 0; i < 100; i++) {
    incrementPromises.push(store.increment("hundredCounter", 1));
  }

  const results = await Promise.all(incrementPromises);

  // Verify all 100 calls succeeded and returned unique counter values from 1 to 100
  assert.strictEqual(results.length, 100);
  const sortedResults = results.slice().sort((a, b) => a - b);
  assert.strictEqual(sortedResults[0], 1);
  assert.strictEqual(sortedResults[99], 100);

  // Final value in Redis must be exactly 100
  const finalRaw = await client.get("smartrate:hundredCounter");
  assert.strictEqual(Number(finalRaw), 100, "Final counter in Redis must be exactly 100");
});

// ============================================================================
// 20. Final Hardening: Rate-Limit Correctness Invariant #9
// ============================================================================

test("Invariant #9: Given a limit of N, concurrent requests must not cause more than N successful state transitions", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 20, retryDelayMs: 2 });
  const clock = new FakeClock(1000);

  const limitN = 10;
  const totalRequests = 100;
  const algorithm = new FixedWindow({ limit: limitN, window: 60000 }, store, clock);

  const limiter = new RateLimiter(algorithm, { clock });
  const middleware = limiter.middleware();

  let allowedCount = 0;
  let blockedCount = 0;

  const reqPromises = [];
  for (let i = 0; i < totalRequests; i++) {
    const req = { ip: "user_invariant_9" };
    let status = 200;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json() {},
      setHeader() {},
    };

    reqPromises.push(
      middleware(req, res, () => {}).then(() => {
        if (status === 200) allowedCount++;
        else if (status === 429) blockedCount++;
      })
    );
  }

  await Promise.all(reqPromises);

  assert.strictEqual(allowedCount, limitN, `Exactly ${limitN} requests must be allowed`);
  assert.strictEqual(blockedCount, totalRequests - limitN, `Exactly ${totalRequests - limitN} requests must be blocked`);

  // Stored counter must be exactly limitN
  const rawState = await client.get("smartrate:user_invariant_9");
  const storedState = JSON.parse(rawState);
  assert.strictEqual(storedState.count, limitN, `Stored state count must be exactly ${limitN}`);
});

// ============================================================================
// 21. Final Hardening: Tested Client APIs (node-redis vs ioredis)
// ============================================================================

test("Client Compatibility: node-redis (v4+) API contract is verified", async () => {
  let executedIsolated = false;
  let watchedKey = null;
  let execCalled = false;
  let quitCalled = false;

  class MockNodeRedisWatchError extends Error {
    constructor() {
      super("WatchError");
      this.name = "WatchError";
    }
  }

  const mockNodeRedisClient = {
    async executeIsolated(fn) {
      executedIsolated = true;
      const isolated = {
        async watch(k) {
          watchedKey = k;
          return "OK";
        },
        async get(k) {
          return JSON.stringify({ count: 1 });
        },
        multi() {
          return {
            set(k, v, px, ttl) {},
            async exec() {
              execCalled = true;
              return ["OK"];
            },
          };
        },
        async unwatch() {
          return "OK";
        },
      };
      return fn(isolated);
    },
    async quit() {
      quitCalled = true;
      return "OK";
    },
  };

  const store = new RedisStore(mockNodeRedisClient, { ownsClient: true });
  const result = await store.mutate("nodeRedisKey", (curr) => ({
    nextState: { count: curr.count + 1 },
    result: { count: curr.count + 1 },
  }));

  assert.strictEqual(result.count, 2);
  assert.strictEqual(executedIsolated, true, "executeIsolated() must be called for node-redis");
  assert.strictEqual(watchedKey, "smartrate:nodeRedisKey");
  assert.strictEqual(execCalled, true);

  await store.close();
  assert.strictEqual(quitCalled, true, "quit() must be called when ownsClient is true");
});

test("Client Compatibility: ioredis API contract is verified", async () => {
  let duplicateCalled = false;
  let connected = false;
  let disconnected = false;
  let watchedKey = null;

  const mockIoredisClient = {
    duplicate() {
      duplicateCalled = true;
      return {
        async connect() {
          connected = true;
        },
        async watch(k) {
          watchedKey = k;
          return "OK";
        },
        async get(k) {
          return JSON.stringify({ count: 5 });
        },
        multi() {
          return {
            set(k, v, px, ttl) {},
            async exec() {
              // ioredis returns array of [err, result] pairs
              return [[null, "OK"]];
            },
          };
        },
        async unwatch() {
          return "OK";
        },
        disconnect() {
          disconnected = true;
        },
      };
    },
  };

  const store = new RedisStore(mockIoredisClient);
  const result = await store.mutate("ioredisKey", (curr) => ({
    nextState: { count: curr.count + 1 },
    result: { count: curr.count + 1 },
  }));

  assert.strictEqual(result.count, 6);
  assert.strictEqual(duplicateCalled, true, "duplicate() must be called for ioredis");
  assert.strictEqual(connected, true, "connect() must be called on duplicated client");
  assert.strictEqual(watchedKey, "smartrate:ioredisKey");
  assert.strictEqual(disconnected, true, "disconnect() must be called in finally cleanup");
});

// ============================================================================
// 22. Absolute Expiration Deadline Preservation & update() Timestamp Propagation
// ============================================================================

test("RedisStore increment: expiration deadline does not move forward when existing key is incremented", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client);

  // Initialize key with 5,000ms TTL
  await store.increment("strictDeadlineKey", 1, 5000);
  const itemBefore = client.storage.get("smartrate:strictDeadlineKey");
  assert.ok(itemBefore && itemBefore.expiresAt > 0);
  const initialDeadline = itemBefore.expiresAt;

  // Wait a small delay to simulate time progression
  await new Promise((r) => setTimeout(r, 20));

  // Increment key again without ttl
  const val2 = await store.increment("strictDeadlineKey", 2);
  assert.strictEqual(val2, 3);

  const itemAfter = client.storage.get("smartrate:strictDeadlineKey");
  assert.strictEqual(
    itemAfter.expiresAt,
    initialDeadline,
    "Absolute expiration deadline MUST NOT move forward when incrementing existing key"
  );

  // Increment key again with a huge ttlMs (which must be ignored because key exists)
  await store.increment("strictDeadlineKey", 1, 999999);
  const itemAfterIgnored = client.storage.get("smartrate:strictDeadlineKey");
  assert.strictEqual(
    itemAfterIgnored.expiresAt,
    initialDeadline,
    "ttlMs must be ignored for existing keys to prevent deadline extension"
  );
});

test("RedisStore update: propagates (currentState, now) and passes now through to mutate with retry timestamp reuse", async () => {
  const client = new FakeRedisClient();
  const store = new RedisStore(client, { maxRetries: 3, retryDelayMs: 2 });

  await store.set("updateTestKey", { count: 10 });

  const capturedTimestamps = [];
  let attempt = 0;

  const result = await store.update("updateTestKey", (curr, now) => {
    attempt++;
    capturedTimestamps.push(now);
    assert.strictEqual(typeof now, "number");
    assert.ok(now > 0);

    if (attempt === 1) {
      // Force conflict on first attempt
      client.storage.set("smartrate:updateTestKey", {
        value: JSON.stringify({ count: 15 }),
        expiresAt: null,
      });
      client._bumpVersion("smartrate:updateTestKey");
    }

    return {
      state: { count: curr.count + 5 },
      result: { updatedCount: curr.count + 5, timestamp: now },
    };
  });

  assert.strictEqual(attempt, 2, "update() should retry on OCC conflict");
  assert.strictEqual(capturedTimestamps.length, 2);
  assert.strictEqual(
    capturedTimestamps[0],
    capturedTimestamps[1],
    "update() must reuse the exact same logical timestamp across retries"
  );
  assert.strictEqual(result.updatedCount, 20, "15 (concurrent state) + 5 = 20");
  assert.strictEqual(result.timestamp, capturedTimestamps[0]);

  const finalStored = JSON.parse(await client.get("smartrate:updateTestKey"));
  assert.strictEqual(finalStored.count, 20);
});

test("RedisStore eval: executes script with dual client signature compatibility (ioredis vs node-redis)", async () => {
  let modeCalled = null;

  // Mock client that expects node-redis v4 object signature
  const nodeRedisEvalClient = {
    async eval(script, options) {
      if (typeof options === "object" && Array.isArray(options.keys)) {
        modeCalled = "node-redis";
        return "NODE_REDIS_OK";
      }
      throw new Error("ERR wrong number of arguments for 'eval' command");
    },
  };

  const store1 = new RedisStore(nodeRedisEvalClient);
  const res1 = await store1.eval("return redis.call('PING')", ["myKey"], ["arg1"]);
  assert.strictEqual(res1, "NODE_REDIS_OK");
  assert.strictEqual(modeCalled, "node-redis");

  // Mock client that expects ioredis positional signature
  modeCalled = null;
  const ioredisEvalClient = {
    async eval(script, numKeys, ...rest) {
      if (typeof numKeys === "number") {
        modeCalled = "ioredis";
        return "IOREDIS_OK";
      }
      throw new Error("Invalid signature");
    },
  };

  const store2 = new RedisStore(ioredisEvalClient);
  const res2 = await store2.eval("return redis.call('PING')", ["myKey"], ["arg1"]);
  assert.strictEqual(res2, "IOREDIS_OK");
  assert.strictEqual(modeCalled, "ioredis");
});

test("RedisStore: correctly formats TTL for node-redis ({ PX }) and ioredis ('PX', ttlMs)", async () => {
  let capturedNodeRedisOptions = null;
  const nodeRedisClient = {
    async executeIsolated(fn) {
      return fn({
        async watch() { return "OK"; },
        async get() { return null; },
        multi() {
          return {
            set(k, v, options) { capturedNodeRedisOptions = options; },
            async exec() { return ["OK"]; }
          };
        },
        async unwatch() { return "OK"; }
      });
    }
  };

  const store1 = new RedisStore(nodeRedisClient);
  await store1.mutate("testKey", () => ({ nextState: { a: 1 }, result: true }), 15000);
  assert.deepStrictEqual(capturedNodeRedisOptions, { PX: 15000 });

  let capturedIoredisArgs = [];
  const ioredisClient = {
    duplicate() {
      return {
        async watch() { return "OK"; },
        async get() { return null; },
        multi() {
          return {
            set(k, v, ...args) { capturedIoredisArgs = args; },
            async exec() { return ["OK"]; }
          };
        },
        async unwatch() { return "OK"; },
        async quit() { return "OK"; }
      };
    }
  };

  const store2 = new RedisStore(ioredisClient);
  await store2.mutate("testKey", () => ({ nextState: { a: 1 }, result: true }), 25000);
  assert.deepStrictEqual(capturedIoredisArgs, ["PX", 25000]);
});



