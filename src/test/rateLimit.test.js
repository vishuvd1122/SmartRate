const test = require("node:test");
const assert = require("node:assert");

const rateLimit = require("../rateLimit");
const FakeRedisClient = require("./helpers/fakeRedisClient");
const FakeClock = require("./helpers/fakeClock");
const TokenBucket = require("../algorithms/tokenBucket");
const SlidingWindowLog = require("../algorithms/slidingWindowLog");
const FixedWindow = require("../algorithms/fixedWindow");
const LeakyBucket = require("../algorithms/leakyBucket");
const RedisStore = require("../storage/redisStore");
const MemoryStore = require("../storage/memoryStore");

function createMockResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(key, val) {
      this.headers[key] = val;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("rateLimit(): default initialization uses MemoryStore and FixedWindow", async () => {
  const clock = new FakeClock(1000000);
  const limiter = rateLimit({
    limit: 2,
    windowMs: 60000,
    clock,
  });

  assert.strictEqual(typeof limiter, "function");
  assert.ok(limiter.store instanceof MemoryStore);
  assert.ok(limiter.algorithm instanceof FixedWindow);

  const req = { ip: "10.0.0.1" };
  const res1 = createMockResponse();
  let nextCalled1 = false;
  await limiter(req, res1, () => {
    nextCalled1 = true;
  });

  assert.strictEqual(nextCalled1, true);
  assert.strictEqual(res1.headers["X-RateLimit-Remaining"], 1);

  // Second request - allowed
  const res2 = createMockResponse();
  let nextCalled2 = false;
  await limiter(req, res2, () => {
    nextCalled2 = true;
  });
  assert.strictEqual(nextCalled2, true);
  assert.strictEqual(res2.headers["X-RateLimit-Remaining"], 0);

  // Third request - blocked (429)
  const res3 = createMockResponse();
  let nextCalled3 = false;
  await limiter(req, res3, () => {
    nextCalled3 = true;
  });
  assert.strictEqual(nextCalled3, false);
  assert.strictEqual(res3.statusCode, 429);
  assert.strictEqual(res3.body.error, "Too Many Requests");
});

test("rateLimit(): resolves 'token-bucket' algorithm and supports capacity / refillRate", async () => {
  const clock = new FakeClock(1000000);
  const limiter = rateLimit({
    algorithm: "token-bucket",
    capacity: 3,
    refillRate: 1, // 1 token per second
    clock,
  });

  assert.ok(limiter.algorithm instanceof TokenBucket);
  assert.strictEqual(limiter.algorithm.capacity, 3);

  const req = { ip: "192.168.1.1" };
  const res = createMockResponse();
  let nextCalled = false;
  await limiter(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.headers["X-RateLimit-Limit"], 3);
  assert.strictEqual(res.headers["X-RateLimit-Remaining"], 2);
});

test("rateLimit(): resolves 'sliding-window-log' algorithm", async () => {
  const clock = new FakeClock(1000000);
  const limiter = rateLimit({
    algorithm: "sliding-window-log",
    limit: 5,
    windowMs: 30000,
    clock,
  });

  assert.ok(limiter.algorithm instanceof SlidingWindowLog);
  assert.strictEqual(limiter.algorithm.limit, 5);
  assert.strictEqual(limiter.algorithm.window, 30000);
});

test("rateLimit(): resolves 'leaky-bucket' algorithm", async () => {
  const clock = new FakeClock(1000000);
  const limiter = rateLimit({
    algorithm: "leaky-bucket",
    capacity: 10,
    leakRate: 2,
    clock,
  });

  assert.ok(limiter.algorithm instanceof LeakyBucket);
  assert.strictEqual(limiter.algorithm.capacity, 10);
});

test("rateLimit(): automatically instantiates RedisStore when redis client is provided", async () => {
  const fakeRedis = new FakeRedisClient();
  const clock = new FakeClock(1000000);

  const limiter = rateLimit({
    redis: fakeRedis,
    algorithm: "token-bucket",
    capacity: 5,
    refillRate: 0.5,
    clock,
  });

  assert.ok(limiter.store instanceof RedisStore);
  assert.strictEqual(limiter.store.prefix, "rateLimit:");

  const req = { ip: "127.0.0.1" };
  const res = createMockResponse();
  let nextCalled = false;
  await limiter(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true);
  // Verify key in fakeRedis was stored with rateLimit: prefix and user IP
  assert.ok(fakeRedis.storage.has("rateLimit:user:127.0.0.1"));
});

test("rateLimit(): respects custom store instance if provided", async () => {
  const customStore = new MemoryStore();
  const limiter = rateLimit({
    store: customStore,
    limit: 5,
  });

  assert.strictEqual(limiter.store, customStore);
});

test("rateLimit(): supports custom keyGenerator", async () => {
  const limiter = rateLimit({
    limit: 5,
    keyGenerator: (req) => `api_key:${req.headers["x-api-key"]}`,
  });

  let capturedKey = null;
  limiter.algorithm.check = async (id) => {
    capturedKey = id;
    return { allowed: true, limit: 5, remaining: 4, resetAt: 1060000 };
  };

  const req = { headers: { "x-api-key": "secret_abc" } };
  const res = createMockResponse();
  await limiter(req, res, () => {});

  assert.strictEqual(capturedKey, "api_key:secret_abc");
});

