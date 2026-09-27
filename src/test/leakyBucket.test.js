const test = require("node:test");
const assert = require("node:assert");

const MemoryStore = require("../storage/memoryStore");
const LeakyBucket = require("../algorithms/leakyBucket");
const RateLimiter = require("../middleware/rateLimiter");
const FakeClock = require("./helpers/fakeClock");

test("first request should be allowed and enqueued", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 3, leakInterval: 1000 },
        store,
        clock
    );

    const result = await limiter.check("client-1");

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.limit, 3);
    assert.strictEqual(result.remaining, 2);
    assert.strictEqual(result.resetAt, 1000 + 1000); // 1 item in queue * 1000ms
});

test("should allow requests until queue reaches capacity and block on overflow", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 3, leakInterval: 1000 },
        store,
        clock
    );

    // Enqueue 3 requests at t=1000
    const r1 = await limiter.check("client-1");
    const r2 = await limiter.check("client-1");
    const r3 = await limiter.check("client-1");

    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 2);

    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    assert.strictEqual(r3.allowed, true);
    assert.strictEqual(r3.remaining, 0);

    // 4th request overflows the bucket queue
    const r4 = await limiter.check("client-1");
    assert.strictEqual(r4.allowed, false);
    assert.strictEqual(r4.remaining, 0);
    assert.strictEqual(r4.resetAt, 1000 + 1000); // next item leaks at 2000
});

test("should leak items from the queue at a constant rate", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 2, leakInterval: 1000 }, // leaks 1 item every 1000ms
        store,
        clock
    );

    // Fill queue (capacity 2) at t=1000
    await limiter.check("client-1");
    await limiter.check("client-1");

    // Immediately blocked
    const blocked = await limiter.check("client-1");
    assert.strictEqual(blocked.allowed, false);

    // Advance 1000ms -> 1 item leaks out of the FIFO queue!
    clock.advance(1000); // t = 2000

    // Now 1 slot is free
    const afterLeak = await limiter.check("client-1");
    assert.strictEqual(afterLeak.allowed, true);
    assert.strictEqual(afterLeak.remaining, 0);

    // Immediately full again -> next is blocked
    const blockedAgain = await limiter.check("client-1");
    assert.strictEqual(blockedAgain.allowed, false);
});

test("should completely drain queue after idle period", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 3, leakInterval: 1000 },
        store,
        clock
    );

    // Fill queue
    await limiter.check("client-1");
    await limiter.check("client-1");
    await limiter.check("client-1");

    // Advance 1 hour
    clock.advance(3600 * 1000);

    // Queue is empty, full capacity available
    const fresh = await limiter.check("client-1");
    assert.strictEqual(fresh.allowed, true);
    assert.strictEqual(fresh.remaining, 2);
});

test("different clients should have separate queues", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 1, leakInterval: 1000 },
        store,
        clock
    );

    const c1 = await limiter.check("client-1");
    const c2 = await limiter.check("client-2");

    assert.strictEqual(c1.allowed, true);
    assert.strictEqual(c2.allowed, true);

    const c1Blocked = await limiter.check("client-1");
    assert.strictEqual(c1Blocked.allowed, false);
});

test("should support weighted requests using cost option", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 5, leakInterval: 1000, cost: 2 },
        store,
        clock
    );

    // Req 1: costs 2 -> allowed, 3 remaining
    const r1 = await limiter.check("weighted");
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 3);

    // Req 2: costs 2 -> allowed, 1 remaining
    const r2 = await limiter.check("weighted");
    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    // Req 3: needs 2, but only 1 slot left -> BLOCKED
    const r3 = await limiter.check("weighted");
    assert.strictEqual(r3.allowed, false);
    assert.strictEqual(r3.remaining, 1);
});

test("should handle concurrent requests atomically without exceeding capacity", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new LeakyBucket(
        { capacity: 5, leakInterval: 1000 },
        store,
        clock
    );

    // Send 30 parallel requests
    const promises = Array.from({ length: 30 }, () => limiter.check("concurrent-client"));
    const results = await Promise.all(promises);

    const allowed = results.filter((r) => r.allowed);
    const blocked = results.filter((r) => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 25);
});

test("works with RateLimiter middleware and sets correct headers", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const algorithm = new LeakyBucket(
        { capacity: 2, leakInterval: 1000 },
        store,
        clock
    );

    const rateLimiter = new RateLimiter(algorithm, { clock });
    const middleware = rateLimiter.middleware();

    const createRes = () => ({
        headers: {},
        statusCode: null,
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    });

    const req = { ip: "192.168.1.1" };
    let nextCount = 0;
    const next = () => { nextCount++; };

    // Request 1: allowed
    const res1 = createRes();
    await middleware(req, res1, next);
    assert.strictEqual(nextCount, 1);
    assert.strictEqual(res1.headers["X-RateLimit-Limit"], 2);
    assert.strictEqual(res1.headers["X-RateLimit-Remaining"], 1);

    // Request 2: allowed
    const res2 = createRes();
    await middleware(req, res2, next);
    assert.strictEqual(nextCount, 2);
    assert.strictEqual(res2.headers["X-RateLimit-Remaining"], 0);

    // Request 3: blocked (429)
    const res3 = createRes();
    await middleware(req, res3, next);
    assert.strictEqual(nextCount, 2);
    assert.strictEqual(res3.statusCode, 429);
    assert.strictEqual(res3.headers["Retry-After"], 1);
});

test("should support options.leakRate and options.window aliases", () => {
    const store = new MemoryStore();

    // 2 req/sec -> leakInterval = 500ms
    const l1 = new LeakyBucket({ capacity: 10, leakRate: 2 }, store);
    assert.strictEqual(l1.leakInterval, 500);

    // window: 10000ms for capacity 5 -> leakInterval = 2000ms
    const l2 = new LeakyBucket({ capacity: 5, window: 10000 }, store);
    assert.strictEqual(l2.leakInterval, 2000);
});

test("should reject invalid constructor options", () => {
    const store = new MemoryStore();

    assert.throws(() => new LeakyBucket(null, store));
    assert.throws(() => new LeakyBucket({ capacity: 0 }, store));
    assert.throws(() => new LeakyBucket({ capacity: -5 }, store));
    assert.throws(() => new LeakyBucket({ capacity: 2.5 }, store));
    assert.throws(() => new LeakyBucket({ capacity: 5, leakRate: 0 }, store));
    assert.throws(() => new LeakyBucket({ capacity: 5, cost: 0 }, store));
    assert.throws(() => new LeakyBucket({ capacity: 5, cost: 6 }, store));
});
