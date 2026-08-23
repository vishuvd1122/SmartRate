const test = require("node:test");
const assert = require("node:assert");

const express = require("express");
const request = require("supertest");

const FixedWindow = require("../../algorithms/fixedWindow");
const MemoryStore = require("../../storage/memoryStore");
const RateLimiter = require("../../middleware/rateLimiter");
const FakeClock = require("../helpers/fakeClock");


/*
 * ---------------------------------------------------------
 * Create a complete Express application
 *
 * Components being tested together:
 *
 * Express
 *    ↓
 * RateLimiter
 *    ↓
 * FixedWindow
 *    ↓
 * MemoryStore
 * ---------------------------------------------------------
 */
function createApp() {
    const app = express();

    /*
     * Real memory store.
     */
    const store = new MemoryStore();

    /*
     * Fake clock so tests don't have to
     * actually wait 60 seconds.
     */
    const clock = new FakeClock(1000000);

    /*
     * Fixed Window configuration:
     *
     * Maximum requests = 3
     * Window size = 60 seconds
     */
    const algorithm = new FixedWindow(
        {
            limit: 3,
            window: 60000
        },
        store,
        clock
    );

    /*
     * Create the rate limiter middleware.
     */
    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    /*
     * Used to verify whether the protected
     * route was actually executed.
     */
    let routeCallCount = 0;

    /*
     * Protected endpoint.
     */
    app.get(
        "/api/test",
        limiter.middleware(),
        (req, res) => {
            routeCallCount++;

            res.status(200).json({
                success: true
            });
        }
    );

    return {
        app,
        clock,

        /*
         * Expose route call count to tests
         * without exposing the variable itself.
         */
        getRouteCallCount: () => routeCallCount
    };
}


/*
 * =========================================================
 * TEST 1
 * =========================================================
 *
 * The first three requests should be allowed.
 *
 * Limit = 3
 *
 * Request 1 → 200
 * Request 2 → 200
 * Request 3 → 200
 */
test(
    "should allow requests until the rate limit is reached",
    async () => {

        const {
            app
        } = createApp();

        const first = await request(app)
            .get("/api/test");

        const second = await request(app)
            .get("/api/test");

        const third = await request(app)
            .get("/api/test");

        assert.strictEqual(
            first.status,
            200
        );

        assert.strictEqual(
            second.status,
            200
        );

        assert.strictEqual(
            third.status,
            200
        );
    }
);


/*
 * =========================================================
 * TEST 2
 * =========================================================
 *
 * The fourth request should be rejected.
 *
 * Request 1 → 200
 * Request 2 → 200
 * Request 3 → 200
 * Request 4 → 429
 */
test(
    "should reject requests after the rate limit is reached",
    async () => {

        const {
            app
        } = createApp();

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        const fourth = await request(app)
            .get("/api/test");

        assert.strictEqual(
            fourth.status,
            429
        );
    }
);


/*
 * =========================================================
 * TEST 3
 * =========================================================
 *
 * A blocked request should return the expected
 * JSON response body.
 */
test(
    "should return correct response body when request is blocked",
    async () => {

        const {
            app
        } = createApp();

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        const fourth = await request(app)
            .get("/api/test");

        assert.deepStrictEqual(
            fourth.body,
            {
                error: "Too Many Requests",
                message: "Rate limit exceeded"
            }
        );
    }
);


/*
 * =========================================================
 * TEST 4
 * =========================================================
 *
 * The rate-limit headers should be returned
 * on an allowed request.
 */
test(
    "should return correct rate-limit headers",
    async () => {

        const {
            app
        } = createApp();

        const response = await request(app)
            .get("/api/test");

        /*
         * Limit is 3.
         */
        assert.strictEqual(
            response.headers["x-ratelimit-limit"],
            "3"
        );

        /*
         * One request has been consumed,
         * therefore 2 remain.
         */
        assert.strictEqual(
            response.headers["x-ratelimit-remaining"],
            "2"
        );

        /*
         * resetAt = 1060000 milliseconds
         *
         * HTTP header uses seconds:
         *
         * 1060000 / 1000 = 1060
         */
        assert.strictEqual(
            response.headers["x-ratelimit-reset"],
            "1060"
        );
    }
);


/*
 * =========================================================
 * TEST 5
 * =========================================================
 *
 * A blocked request should have:
 *
 * X-RateLimit-Limit: 3
 * X-RateLimit-Remaining: 0
 * Retry-After: 60
 */
test(
    "should return correct headers when request is blocked",
    async () => {

        const {
            app
        } = createApp();

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        const blocked = await request(app)
            .get("/api/test");

        assert.strictEqual(
            blocked.status,
            429
        );

        assert.strictEqual(
            blocked.headers["x-ratelimit-limit"],
            "3"
        );

        assert.strictEqual(
            blocked.headers["x-ratelimit-remaining"],
            "0"
        );

        assert.strictEqual(
            blocked.headers["retry-after"],
            "60"
        );
    }
);


/*
 * =========================================================
 * TEST 6
 * =========================================================
 *
 * The blocked request must NOT reach the protected route.
 *
 * Three requests are allowed.
 * The fourth is rejected.
 *
 * Therefore the route should have been called
 * exactly three times.
 */
test(
    "should not execute the route when request is blocked",
    async () => {

        const {
            app,
            getRouteCallCount
        } = createApp();

        /*
         * Request 1
         */
        await request(app)
            .get("/api/test");

        /*
         * Request 2
         */
        await request(app)
            .get("/api/test");

        /*
         * Request 3
         */
        await request(app)
            .get("/api/test");

        /*
         * Request 4 → should be blocked.
         */
        const blocked = await request(app)
            .get("/api/test");

        assert.strictEqual(
            blocked.status,
            429
        );

        /*
         * The route must have executed exactly
         * three times, not four.
         */
        assert.strictEqual(
            getRouteCallCount(),
            3
        );
    }
);


/*
 * =========================================================
 * TEST 7
 * =========================================================
 *
 * The window should reset after 60 seconds.
 *
 * Before expiration:
 *
 * Request 1 → 200
 * Request 2 → 200
 * Request 3 → 200
 * Request 4 → 429
 *
 * After expiration:
 *
 * Request 5 → 200
 */
test(
    "should allow requests again after the window expires",
    async () => {

        const {
            app,
            clock
        } = createApp();

        /*
         * Consume the entire limit.
         */
        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        /*
         * Should now be blocked.
         */
        const blocked = await request(app)
            .get("/api/test");

        assert.strictEqual(
            blocked.status,
            429
        );

        /*
         * Move fake clock forward by exactly
         * one window.
         *
         * 60 seconds = 60000 milliseconds
         */
        clock.advance(60000);

        /*
         * The window should now reset.
         */
        const afterReset = await request(app)
            .get("/api/test");

        assert.strictEqual(
            afterReset.status,
            200
        );
    }
);


/*
 * =========================================================
 * TEST 8
 * =========================================================
 *
 * Verify that the boundary is handled correctly.
 *
 * 59999 ms → old window
 * 60000 ms → new window
 */
test(
    "should reset exactly at the window boundary",
    async () => {

        const {
            app,
            clock
        } = createApp();

        /*
         * Consume the entire limit.
         */
        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        await request(app)
            .get("/api/test");

        /*
         * Move forward 59999 ms.
         *
         * Window has NOT expired yet.
         */
        clock.advance(59999);

        const stillBlocked = await request(app)
            .get("/api/test");

        assert.strictEqual(
            stillBlocked.status,
            429
        );

        /*
         * Move forward the remaining 1 ms.
         *
         * Total = 60000 ms.
         */
        clock.advance(1);

        /*
         * Window should now be reset.
         */
        const afterBoundary = await request(app)
            .get("/api/test");

        assert.strictEqual(
            afterBoundary.status,
            200
        );
    }
);