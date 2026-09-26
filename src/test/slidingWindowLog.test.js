const test = require("node:test");
const assert = require("node:assert");

const MemoryStore = require("../storage/memoryStore");
const SlidingWindowLog = require("../algorithms/slidingWindowLog");
const RateLimiter = require("../middleware/rateLimiter");
const FakeClock = require("./helpers/fakeClock");

// ============================================================================
// 1. Basic Functionality & Quota Accounting
// ============================================================================

test("1.1 first request should be allowed and start the sliding log", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 60000 },
        store,
        clock
    );

    const result = await limiter.check("client-1");

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.limit, 5);
    assert.strictEqual(result.remaining, 4);
    assert.strictEqual(result.resetAt, 1000 + 60000);
});

test("1.2 sequential requests should decrement remaining until 0", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 3, window: 10000 },
        store,
        clock
    );

    const r1 = await limiter.check("client-1");
    const r2 = await limiter.check("client-1");
    const r3 = await limiter.check("client-1");

    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 2);

    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    assert.strictEqual(r3.allowed, true);
    assert.strictEqual(r3.remaining, 0);

    // 4th request must be blocked
    const r4 = await limiter.check("client-1");
    assert.strictEqual(r4.allowed, false);
    assert.strictEqual(r4.remaining, 0);
    assert.strictEqual(r4.resetAt, 1000 + 10000);
});

test("1.3 blocked requests should NOT pollute log or increment count", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 2, window: 10000 },
        store,
        clock
    );

    await limiter.check("client-1"); // 1
    await limiter.check("client-1"); // 2

    // Fire 5 blocked requests
    for (let i = 0; i < 5; i++) {
        const blocked = await limiter.check("client-1");
        assert.strictEqual(blocked.allowed, false);
        assert.strictEqual(blocked.remaining, 0);
    }

    // Advance clock so first 2 requests expire
    clock.advance(10001);

    // Quota must be completely restored to 2, proving blocked requests were not saved
    const fresh1 = await limiter.check("client-1");
    const fresh2 = await limiter.check("client-1");
    assert.strictEqual(fresh1.allowed, true);
    assert.strictEqual(fresh1.remaining, 1);
    assert.strictEqual(fresh2.allowed, true);
    assert.strictEqual(fresh2.remaining, 0);
});

// ============================================================================
// 2. Temporal Window Sliding & Expiration
// ============================================================================

test("2.1 should smoothly slide window as individual timestamps expire", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000); // window = 1000ms, limit = 3

    const limiter = new SlidingWindowLog(
        { limit: 3, window: 1000 },
        store,
        clock
    );

    // Req 1 at t=1000
    await limiter.check("client-1");

    // Req 2 at t=1300
    clock.set(1300);
    await limiter.check("client-1");

    // Req 3 at t=1600
    clock.set(1600);
    await limiter.check("client-1");

    // Req 4 at t=1800: all 3 active [1000, 1300, 1600] -> BLOCKED
    clock.set(1800);
    const blocked = await limiter.check("client-1");
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.resetAt, 2000); // 1000 + 1000

    // Advance to t=2001: t=1000 has expired, [1300, 1600] active -> 1 slot available!
    clock.set(2001);
    const r4 = await limiter.check("client-1");
    assert.strictEqual(r4.allowed, true);
    assert.strictEqual(r4.remaining, 0); // now [1300, 1600, 2001]
    assert.strictEqual(r4.resetAt, 2300); // next oldest is 1300 + 1000

    // Advance to t=2301: t=1300 has expired -> 1 slot available!
    clock.set(2301);
    const r5 = await limiter.check("client-1");
    assert.strictEqual(r5.allowed, true);
});

test("2.2 should expire timestamps exactly at the boundary condition", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000); // window = 1000ms

    const limiter = new SlidingWindowLog(
        { limit: 1, window: 1000 },
        store,
        clock
    );

    await limiter.check("client-1"); // at t=1000

    // At t=1999 (999ms elapsed): still inside window -> BLOCKED
    clock.set(1999);
    const rBlocked = await limiter.check("client-1");
    assert.strictEqual(rBlocked.allowed, false);

    // At t=2000 (1000ms elapsed, exactly at boundary): elapsed >= window -> ALLOWED
    clock.set(2000);
    const rBoundary = await limiter.check("client-1");
    assert.strictEqual(rBoundary.allowed, true);

    // At t=3001 (1001ms elapsed): expired -> ALLOWED
    clock.set(3001);
    const rAfter = await limiter.check("client-1");
    assert.strictEqual(rAfter.allowed, true);
});

test("2.3 should clear all log entries after long idle time", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 3, window: 5000 },
        store,
        clock
    );

    await limiter.check("client-1");
    await limiter.check("client-1");
    await limiter.check("client-1");

    // Advance 2 hours
    clock.advance(7200 * 1000);

    // Full quota of 3 must be available
    const fresh = await limiter.check("client-1");
    assert.strictEqual(fresh.allowed, true);
    assert.strictEqual(fresh.remaining, 2);
});

// ============================================================================
// 3. Burst Traffic & Sub-Millisecond Identical Timestamps
// ============================================================================

test("3.1 should accurately handle burst of requests in the exact same millisecond", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(5000); // Time stays fixed at 5000

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 10000 },
        store,
        clock
    );

    const results = [];
    for (let i = 0; i < 7; i++) {
        results.push(await limiter.check("burst-client"));
    }

    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 2);

    // All allowed requests share the same resetAt
    for (const r of allowed) {
        assert.strictEqual(r.resetAt, 5000 + 10000);
    }
});

test("3.2 should handle strict limit of 1", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 1, window: 5000 },
        store,
        clock
    );

    const r1 = await limiter.check("client-1");
    const r2 = await limiter.check("client-1");

    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 0);

    assert.strictEqual(r2.allowed, false);
    assert.strictEqual(r2.remaining, 0);
});

// ============================================================================
// 4. Multi-Client Isolation
// ============================================================================

test("4.1 different clients should maintain completely independent logs", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 2, window: 10000 },
        store,
        clock
    );

    // Client A exhausts quota
    await limiter.check("client-A");
    await limiter.check("client-A");
    const aBlocked = await limiter.check("client-A");
    assert.strictEqual(aBlocked.allowed, false);

    // Client B must still have full quota
    const b1 = await limiter.check("client-B");
    const b2 = await limiter.check("client-B");
    assert.strictEqual(b1.allowed, true);
    assert.strictEqual(b1.remaining, 1);
    assert.strictEqual(b2.allowed, true);
    assert.strictEqual(b2.remaining, 0);
});

test("4.2 should handle IP addresses and special identifier strings", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 2, window: 10000 },
        store,
        clock
    );

    const ipv4 = await limiter.check("192.168.1.100");
    const ipv6 = await limiter.check("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    const apiKey = await limiter.check("key:sk_live_93849182379182");

    assert.strictEqual(ipv4.allowed, true);
    assert.strictEqual(ipv6.allowed, true);
    assert.strictEqual(apiKey.allowed, true);
});

// ============================================================================
// 5. Weighted Requests (Static Cost)
// ============================================================================

test("5.1 should deduct multiple units for weighted cost", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 10000, cost: 2 },
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

    // Req 3: needs 2, but only 1 left -> BLOCKED
    const r3 = await limiter.check("weighted");
    assert.strictEqual(r3.allowed, false);
    assert.strictEqual(r3.remaining, 1);
});

test("5.2 should accurately calculate resetAt for weighted requests needing multiple slots", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000); // window = 5000ms, limit = 4, cost = 2

    const limiter = new SlidingWindowLog(
        { limit: 4, window: 5000, cost: 2 },
        store,
        clock
    );

    // Req 1 at t=1000 (consumes 2 slots, timestamps: [1000, 1000])
    await limiter.check("client-1");

    // Req 2 at t=2000 (consumes 2 slots, timestamps: [1000, 1000, 2000, 2000])
    clock.set(2000);
    await limiter.check("client-1");

    // Req 3 at t=3000 (costs 2, bucket is full: 4 slots used) -> BLOCKED
    // To satisfy cost of 2, 2 slots must expire.
    // The 2nd oldest timestamp is at index 1: validTimestamps[1] = 1000.
    // resetAt = 1000 + 5000 = 6000.
    clock.set(3000);
    const r3 = await limiter.check("client-1");
    assert.strictEqual(r3.allowed, false);
    assert.strictEqual(r3.resetAt, 6000);
});

test("5.3 request costing entire limit should consume bucket in one shot", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 10000, cost: 5 },
        store,
        clock
    );

    // Req 1: consumes all 5
    const r1 = await limiter.check("all-in");
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 0);

    // Req 2: blocked
    const r2 = await limiter.check("all-in");
    assert.strictEqual(r2.allowed, false);
});

// ============================================================================
// 6. Concurrency & Race Condition Elimination
// ============================================================================

test("6.1 should handle 50 concurrent requests atomically without exceeding limit", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 60000 },
        store,
        clock
    );

    // 50 requests in parallel
    const promises = Array.from({ length: 50 }, () => limiter.check("concurrent-user"));
    const results = await Promise.all(promises);

    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 45);
});

test("6.2 concurrent requests at the exact boundary millisecond", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 5, window: 10000 },
        store,
        clock
    );

    // Exhaust 5 slots at t=1000
    await Promise.all(Array.from({ length: 5 }, () => limiter.check("boundary-concurrency")));

    // Move to exact boundary t=11000
    clock.set(11000);

    // Fire 20 simultaneous requests
    const promises = Array.from({ length: 20 }, () => limiter.check("boundary-concurrency"));
    const results = await Promise.all(promises);

    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 15);
});

test("6.3 concurrent weighted requests should not exceed capacity", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const limiter = new SlidingWindowLog(
        { limit: 10, window: 60000, cost: 2 },
        store,
        clock
    );

    // 20 concurrent requests each costing 2 (needs 40 slots, only 10 available -> exactly 5 must pass)
    const promises = Array.from({ length: 20 }, () => limiter.check("weighted-concurrency"));
    const results = await Promise.all(promises);

    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(blocked.length, 15);
});

// ============================================================================
// 7. Express Middleware Integration & HTTP Headers
// ============================================================================

test("7.1 middleware sets correct headers and passes through on allowed request", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const algorithm = new SlidingWindowLog(
        { limit: 2, window: 10000 },
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

    const req = { ip: "10.0.0.1" };
    let nextCalled = 0;
    const next = () => { nextCalled++; };

    // Request 1: allowed
    const res1 = createRes();
    await middleware(req, res1, next);
    assert.strictEqual(nextCalled, 1);
    assert.strictEqual(res1.headers["X-RateLimit-Limit"], 2);
    assert.strictEqual(res1.headers["X-RateLimit-Remaining"], 1);
    assert.strictEqual(res1.headers["X-RateLimit-Reset"], 11); // ceil((1000+10000)/1000)

    // Request 2: allowed
    const res2 = createRes();
    await middleware(req, res2, next);
    assert.strictEqual(nextCalled, 2);
    assert.strictEqual(res2.headers["X-RateLimit-Remaining"], 0);

    // Request 3: blocked (429)
    const res3 = createRes();
    await middleware(req, res3, next);
    assert.strictEqual(nextCalled, 2); // next NOT called
    assert.strictEqual(res3.statusCode, 429);
    assert.strictEqual(res3.headers["Retry-After"], 10);
    assert.deepStrictEqual(res3.body, {
        error: "Too Many Requests",
        message: "Rate limit exceeded",
    });
});

test("7.2 middleware uses custom key generator when provided", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000);

    const algorithm = new SlidingWindowLog(
        { limit: 1, window: 10000 },
        store,
        clock
    );

    const rateLimiter = new RateLimiter(algorithm, {
        clock,
        keyGenerator: (req) => req.headers["authorization"] || req.ip,
    });
    const middleware = rateLimiter.middleware();

    const createRes = () => ({
        headers: {},
        statusCode: null,
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    });

    let nextCount = 0;
    const next = () => { nextCount++; };

    // Different Auth tokens should have independent limits even on same IP
    await middleware({ ip: "1.1.1.1", headers: { authorization: "Bearer userA" } }, createRes(), next);
    await middleware({ ip: "1.1.1.1", headers: { authorization: "Bearer userB" } }, createRes(), next);

    assert.strictEqual(nextCount, 2);
});

// ============================================================================
// 8. Parameter Validation & Edge Case Inputs
// ============================================================================

test("8.1 should support options.capacity and options.windowMs aliases", () => {
    const store = new MemoryStore();
    const limiter = new SlidingWindowLog({ capacity: 10, windowMs: 5000 }, store);
    assert.strictEqual(limiter.limit, 10);
    assert.strictEqual(limiter.window, 5000);
});

test("8.2 should reject invalid constructor options with clear errors", () => {
    const store = new MemoryStore();

    assert.throws(() => new SlidingWindowLog(null, store), /options must be an object/);
    assert.throws(() => new SlidingWindowLog({ limit: 0, window: 1000 }, store), /limit must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: -5, window: 1000 }, store), /limit must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: 3.14, window: 1000 }, store), /limit must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: "5", window: 1000 }, store), /limit must be a positive integer/);

    assert.throws(() => new SlidingWindowLog({ limit: 5, window: 0 }, store), /window must be a positive number/);
    assert.throws(() => new SlidingWindowLog({ limit: 5, window: -100 }, store), /window must be a positive number/);
    assert.throws(() => new SlidingWindowLog({ limit: 5, window: NaN }, store), /window must be a positive number/);

    assert.throws(() => new SlidingWindowLog({ limit: 5, window: 1000, cost: 0 }, store), /cost must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: 5, window: 1000, cost: -1 }, store), /cost must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: 5, window: 1000, cost: 2.5 }, store), /cost must be a positive integer/);
    assert.throws(() => new SlidingWindowLog({ limit: 5, window: 1000, cost: 6 }, store), /cost cannot exceed limit/);
});

test("8.3 getTtlMs should return window duration", () => {
    const store = new MemoryStore();
    const limiter = new SlidingWindowLog({ limit: 10, window: 45000 }, store);
    assert.strictEqual(limiter.getTtlMs(Date.now()), 45000);
});
