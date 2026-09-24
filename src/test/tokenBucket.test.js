const test = require("node:test");
const assert = require("node:assert");

const MemoryStore = require("../storage/memoryStore");
const TokenBucket = require("../algorithms/tokenBucket");
const RateLimiter = require("../middleware/rateLimiter");
const FakeClock = require("./helpers/fakeClock");

test("first request should be allowed and consume 1 token", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 5,
            refillRate: 1 // 1 token per second
        },
        store,
        clock
    );

    const result = await limiter.check("client-1");

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 4);
    assert.strictEqual(result.limit, 5);
});

test("should allow requests until capacity is exhausted", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 3,
            refillRate: 1
        },
        store,
        clock
    );

    // Consume 3 tokens
    const r1 = await limiter.check("client-1");
    const r2 = await limiter.check("client-1");
    const r3 = await limiter.check("client-1");

    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 2);

    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    assert.strictEqual(r3.allowed, true);
    assert.strictEqual(r3.remaining, 0);

    // 4th request should be blocked
    const r4 = await limiter.check("client-1");
    assert.strictEqual(r4.allowed, false);
    assert.strictEqual(r4.remaining, 0);
});

test("should refill tokens over time", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 2,
            refillRate: 1 // 1 token every 1000 ms
        },
        store,
        clock
    );

    // Drain both tokens
    await limiter.check("client-1");
    await limiter.check("client-1");

    // Immediately blocked
    const blocked = await limiter.check("client-1");
    assert.strictEqual(blocked.allowed, false);

    // Advance time by 1000 ms (1 second) -> 1 token refilled
    clock.advance(1000);

    const afterOneSec = await limiter.check("client-1");
    assert.strictEqual(afterOneSec.allowed, true);
    assert.strictEqual(afterOneSec.remaining, 0); // consumed the 1 refilled token

    // Next request immediately blocked again
    const blockedAgain = await limiter.check("client-1");
    assert.strictEqual(blockedAgain.allowed, false);
});

test("tokens should never exceed capacity after long idle time", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 3,
            refillRate: 1
        },
        store,
        clock
    );

    // Consume 1 token
    await limiter.check("client-1");

    // Advance time by 1 hour (3600 seconds)
    clock.advance(3600 * 1000);

    // Next request should see capacity capped at 3, consuming 1 leaves 2
    const result = await limiter.check("client-1");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 2);
});

test("should handle concurrent requests atomically without exceeding capacity", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 5,
            refillRate: 1
        },
        store,
        clock
    );

    // Send 20 simultaneous requests
    const promises = Array.from({ length: 20 }, () => limiter.check("concurrent-client"));
    const results = await Promise.all(promises);

    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 15);
});

test("works with RateLimiter middleware and sets correct headers", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new TokenBucket(
        {
            capacity: 2,
            refillRate: 1 // 1 token per second
        },
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
        json(body) { this.body = body; return this; }
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
    assert.strictEqual(nextCount, 2); // next not called
    assert.strictEqual(res3.statusCode, 429);
    assert.strictEqual(res3.headers["Retry-After"], 1); // 1 second until 1 token refilled
    assert.deepStrictEqual(res3.body, {
        error: "Too Many Requests",
        message: "Rate limit exceeded"
    });
});

test("should reject invalid capacity and refillRate options", () => {
    const store = new MemoryStore();

    assert.throws(() => {
        new TokenBucket({ capacity: 0 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: -5 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: 5.5 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: 5, refillRate: 0 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: 5, cost: 0 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: 5, cost: -1 }, store);
    });

    assert.throws(() => {
        new TokenBucket({ capacity: 5, cost: 6 }, store); // cost > capacity
    });
});

test("should support weighted tokens with static cost option", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const limiter = new TokenBucket(
        {
            capacity: 5,
            refillRate: 1, // 1 token per 1000ms
            cost: 2        // each request costs 2 tokens
        },
        store,
        clock
    );

    // Request 1: 5 tokens available, costs 2 -> allowed, 3 remaining
    const r1 = await limiter.check("client-weighted");
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 3);

    // Request 2: 3 tokens available, costs 2 -> allowed, 1 remaining
    const r2 = await limiter.check("client-weighted");
    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    // Request 3: 1 token available, but costs 2 -> BLOCKED
    const r3 = await limiter.check("client-weighted");
    assert.strictEqual(r3.allowed, false);
    assert.strictEqual(r3.remaining, 1);
    // Needs 1 more token to reach cost of 2 -> 1000 ms wait
    assert.strictEqual(r3.resetAt, 1000000 + 1000);

    // Advance clock by 1000 ms -> 1 token refilled, total tokens = 2
    clock.advance(1000);

    // Request 4: now 2 tokens available, costs 2 -> allowed, 0 remaining
    const r4 = await limiter.check("client-weighted");
    assert.strictEqual(r4.allowed, true);
    assert.strictEqual(r4.remaining, 0);
});

