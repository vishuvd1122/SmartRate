const test = require("node:test");
const assert = require("node:assert");

const MemoryStore = require("../storage/memoryStore");
const FixedWindow = require("../algorithms/fixedWindow");
const FakeClock = require ("./helpers/fakeClock")

test("first request should be allowed", async () => {
    const store = new MemoryStore();

    const limiter = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store
    );

    const result = await limiter.check("client-1");

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 4);
});




test("requests under the limit should be allowed", async () => {
    const store = new MemoryStore();

    const limiter = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store
    );

    for (let i = 1; i <= 4; i++) {
        const result = await limiter.check("client-1");

        assert.strictEqual(result.allowed, true);
        assert.strictEqual(result.remaining, 5 - i);
    }
});


test("request reaching the limit should be allowed", async () => {
    const store = new MemoryStore();

    const limiter = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store
    );

    for (let i = 0; i < 5; i++) {
        const result = await limiter.check("client-1");

        assert.strictEqual(result.allowed, true);
    }

    const result = await limiter.check("client-1");

    assert.strictEqual(result.allowed, false);
});



test("blocked requests should not increase the count", async () => {
    const store = new MemoryStore();

    const limiter = new FixedWindow(
        {
            limit: 2,
            window: 60000
        },
        store
    );

    await limiter.check("client-1");
    await limiter.check("client-1");

    const blocked = await limiter.check("client-1");

    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.remaining, 0);

    const state = await store.get("client-1");

    assert.strictEqual(state.count, 2);
});




test("different clients should have independent limits", async () => {
    const store = new MemoryStore();

    const limiter = new FixedWindow(
        {
            limit: 2,
            window: 60000
        },
        store
    );

    await limiter.check("client-A");
    await limiter.check("client-A");

    const blocked = await limiter.check("client-A");

    assert.strictEqual(blocked.allowed, false);

    const clientB = await limiter.check("client-B");

    assert.strictEqual(clientB.allowed, true);
    assert.strictEqual(clientB.remaining, 1);
});


test("should reject an invalid limit", () => {
    const store = new MemoryStore();

    assert.throws(() => {
        new FixedWindow(
            {
                limit: 0,
                window: 60000
            },
            store
        );
    });
});



test("should reject a negative limit", () => {
    const store = new MemoryStore();

    assert.throws(() => {
        new FixedWindow(
            {
                limit: -5,
                window: 60000
            },
            store
        );
    });
});



test("should reject a decimal limit", () => {
    const store = new MemoryStore();

    assert.throws(() => {
        new FixedWindow(
            {
                limit: 5.5,
                window: 60000
            },
            store
        );
    });
});



test("should reject an invalid window", () => {
    const store = new MemoryStore();

    assert.throws(() => {
        new FixedWindow(
            {
                limit: 5,
                window: 0
            },
            store
        );
    });
});



test("should reject an invalid store", () => {
    assert.throws(() => {
        new FixedWindow(
            {
                limit: 5,
                window: 60000
            },
            {}
        );
    });
});



test("window should reset after expiration", async () => {
    const store = new MemoryStore();

    const clock = new FakeClock(1000000);

    const limiter = new FixedWindow(
        {
            limit: 2,
            window: 60000
        },
        store,
        clock
    );

    const first = await limiter.check("client-1");
    const second = await limiter.check("client-1");

    assert.strictEqual(first.allowed, true);
    assert.strictEqual(second.allowed, true);

    const blocked = await limiter.check("client-1");

    assert.strictEqual(blocked.allowed, false);

    // Move exactly to the window boundary.
    clock.advance(60000);

    const afterReset = await limiter.check("client-1");

    assert.strictEqual(afterReset.allowed, true);
    assert.strictEqual(afterReset.remaining, 1);
});



test("window should expire exactly at the boundary", async () => {
    const store = new MemoryStore();

    const clock = new FakeClock(1000000);

    const limiter = new FixedWindow(
        {
            limit: 1,
            window: 60000
        },
        store,
        clock
    );

    const first = await limiter.check("client-1");

    assert.strictEqual(first.allowed, true);

    const blocked = await limiter.check("client-1");

    assert.strictEqual(blocked.allowed, false);

    clock.advance(59999);

    const stillBlocked = await limiter.check("client-1");

    assert.strictEqual(stillBlocked.allowed, false);

    clock.advance(1);

    const reset = await limiter.check("client-1");

    assert.strictEqual(reset.allowed, true);
});



test("reset time should be calculated correctly", async () => {
    const store = new MemoryStore();

    const clock = new FakeClock(1000000);

    const limiter = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store,
        clock
    );

    const result = await limiter.check("client-1");

    assert.strictEqual(
        result.resetAt,
        1060000
    );
});