const test = require("node:test");
const assert = require("node:assert");

const FixedWindow = require("../algorithms/fixedWindow");
const MemoryStore = require("../storage/memoryStore");
const FakeClock = require("./helpers/fakeClock");


test("should allow only one request when limit is 1", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new FixedWindow(
        {
            limit: 1,
            window: 60000
        },
        store,
        clock
    );

    const results = await Promise.all([
        algorithm.check("client-1"),
        algorithm.check("client-1")
    ]);

    const allowed = results.filter(
        result => result.allowed
    );

    assert.strictEqual(allowed.length, 1);
});


test("should never exceed the limit under concurrent load", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store,
        clock
    );

    const requests = [];

    for (let i = 0; i < 100; i++) {
        requests.push(
            algorithm.check("client-1")
        );
    }

    const results = await Promise.all(requests);

    const allowed = results.filter(
        result => result.allowed
    );

    const rejected = results.filter(
        result => !result.allowed
    );

    assert.strictEqual(allowed.length, 5);
    assert.strictEqual(rejected.length, 95);
});


test("should handle many concurrent requests with a larger limit", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new FixedWindow(
        {
            limit: 10,
            window: 60000
        },
        store,
        clock
    );

    const requests = [];

    for (let i = 0; i < 1000; i++) {
        requests.push(
            algorithm.check("client-1")
        );
    }

    const results = await Promise.all(requests);

    const allowed = results.filter(
        result => result.allowed
    );

    assert.strictEqual(allowed.length, 10);
});


test("different clients should have independent limits", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new FixedWindow(
        {
            limit: 3,
            window: 60000
        },
        store,
        clock
    );

    const client1Requests = [];
    const client2Requests = [];

    for (let i = 0; i < 10; i++) {
        client1Requests.push(
            algorithm.check("client-1")
        );

        client2Requests.push(
            algorithm.check("client-2")
        );
    }

    const [
        client1Results,
        client2Results
    ] = await Promise.all([
        Promise.all(client1Requests),
        Promise.all(client2Requests)
    ]);

    const client1Allowed = client1Results.filter(
        result => result.allowed
    );

    const client2Allowed = client2Results.filter(
        result => result.allowed
    );

    assert.strictEqual(client1Allowed.length, 3);
    assert.strictEqual(client2Allowed.length, 3);
});

test("should correctly handle concurrent requests at window boundary", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(1000000);

    const algorithm = new FixedWindow(
        {
            limit: 5,
            window: 60000
        },
        store,
        clock
    );

    // Consume the entire window.
    const firstRequests = [];

    for (let i = 0; i < 5; i++) {
        firstRequests.push(
            algorithm.check("client-1")
        );
    }

    const firstResults = await Promise.all(firstRequests);

    assert.strictEqual(
        firstResults.filter(result => result.allowed).length,
        5
    );

    // Move exactly to the window boundary.
    clock.advance(60000);

    // Send many requests simultaneously.
    const boundaryRequests = [];

    for (let i = 0; i < 100; i++) {
        boundaryRequests.push(
            algorithm.check("client-1")
        );
    }

    const boundaryResults = await Promise.all(
        boundaryRequests
    );

    const allowed = boundaryResults.filter(
        result => result.allowed
    );

    assert.strictEqual(allowed.length, 5);
});