// RateLimiter
// │
// ├── Allowed requests
// │   └── next() is called
// │
// ├── Blocked requests
// │   ├── 429 returned
// │   ├── next() NOT called
// │   └── correct JSON response
// │
// ├── Headers
// │   ├── X-RateLimit-Limit
// │   ├── X-RateLimit-Remaining
// │   ├── X-RateLimit-Reset
// │   └── Retry-After
// │
// ├── Client identification
// │   ├── default IP
// │   └── custom key generator
// │
// └── Error handling
//     ├── errors forwarded to next(error)
//     └── errors NOT converted to 429


const test = require("node:test");
const assert = require("node:assert");

const RateLimiter = require("../middleware/rateLimiter");
const FakeClock = require("./helpers/fakeClock");

/*
 * Creates a fake Express response object.
 *
 * Our middleware only needs:
 * - res.setHeader()
 * - res.status()
 * - res.json()
 */
function createResponse() {
    return {
        headers: {},
        statusCode: null,
        body: null,

        setHeader(name, value) {
            this.headers[name] = value;
        },

        status(code) {
            this.statusCode = code;
            return this;
        },

        json(body) {
            this.body = body;
            return this;
        }
    };
}


/*
 * ---------------------------------------------------------
 * TEST 1
 * Allowed request should call next()
 * ---------------------------------------------------------
 */
test("allowed request should call next()", async () => {
    const algorithm = {
        check: async () => ({
            allowed: true,
            limit: 5,
            remaining: 4,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    let nextCalled = false;

    const next = () => {
        nextCalled = true;
    };

    await middleware(req, res, next);

    assert.strictEqual(
        nextCalled,
        true
    );
});


/*
 * ---------------------------------------------------------
 * TEST 2
 * Blocked request should return 429
 * ---------------------------------------------------------
 */
test("blocked request should return 429", async () => {
    const algorithm = {
        check: async () => ({
            allowed: false,
            limit: 5,
            remaining: 0,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.statusCode,
        429
    );
});


/*
 * ---------------------------------------------------------
 * TEST 3
 * Blocked request should NOT call next()
 * ---------------------------------------------------------
 */
test("blocked request should not call next()", async () => {
    const algorithm = {
        check: async () => ({
            allowed: false,
            limit: 5,
            remaining: 0,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    let nextCalled = false;

    const next = () => {
        nextCalled = true;
    };

    await middleware(req, res, next);

    assert.strictEqual(
        nextCalled,
        false
    );
});


/*
 * ---------------------------------------------------------
 * TEST 4
 * Blocked request should return correct response body
 * ---------------------------------------------------------
 */
test("blocked request should return correct response body", async () => {
    const algorithm = {
        check: async () => ({
            allowed: false,
            limit: 5,
            remaining: 0,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.deepStrictEqual(
        res.body,
        {
            error: "Too Many Requests",
            message: "Rate limit exceeded"
        }
    );
});


/*
 * ---------------------------------------------------------
 * TEST 5
 * Should set X-RateLimit-Limit header
 * ---------------------------------------------------------
 */
test("should set X-RateLimit-Limit header", async () => {
    const algorithm = {
        check: async () => ({
            allowed: true,
            limit: 5,
            remaining: 3,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.headers["X-RateLimit-Limit"],
        5
    );
});


/*
 * ---------------------------------------------------------
 * TEST 6
 * Should set X-RateLimit-Remaining header
 * ---------------------------------------------------------
 */
test("should set X-RateLimit-Remaining header", async () => {
    const algorithm = {
        check: async () => ({
            allowed: true,
            limit: 5,
            remaining: 3,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.headers["X-RateLimit-Remaining"],
        3
    );
});


/*
 * ---------------------------------------------------------
 * TEST 7
 * Should convert resetAt from milliseconds to seconds
 * ---------------------------------------------------------
 */
test("should set X-RateLimit-Reset header correctly", async () => {
    const algorithm = {
        check: async () => ({
            allowed: true,
            limit: 5,
            remaining: 3,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.headers["X-RateLimit-Reset"],
        1060
    );
});


/*
 * ---------------------------------------------------------
 * TEST 8
 * Retry-After should be calculated correctly
 * ---------------------------------------------------------
 */
test("should set Retry-After correctly for blocked request", async () => {
    const algorithm = {
        check: async () => ({
            allowed: false,
            limit: 5,
            remaining: 0,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.headers["Retry-After"],
        60
    );
});


/*
 * ---------------------------------------------------------
 * TEST 9
 * Should use the default IP key generator
 * ---------------------------------------------------------
 */
test("should use request IP as the default identifier", async () => {
    let receivedIdentifier = null;

    const algorithm = {
        check: async (identifier) => {
            receivedIdentifier = identifier;

            return {
                allowed: true,
                limit: 5,
                remaining: 4,
                resetAt: 1060000
            };
        }
    };

    const limiter = new RateLimiter(
        algorithm
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "192.168.1.10"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        receivedIdentifier,
        "192.168.1.10"
    );
});


/*
 * ---------------------------------------------------------
 * TEST 10
 * Should support a custom key generator
 * ---------------------------------------------------------
 */
test("should use custom key generator", async () => {
    let receivedIdentifier = null;

    const algorithm = {
        check: async (identifier) => {
            receivedIdentifier = identifier;

            return {
                allowed: true,
                limit: 5,
                remaining: 4,
                resetAt: 1060000
            };
        }
    };

    const limiter = new RateLimiter(
        algorithm,
        {
            keyGenerator: (req) => req.user.id
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "192.168.1.10",

        user: {
            id: "user-123"
        }
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        receivedIdentifier,
        "user-123"
    );
});


/*
 * ---------------------------------------------------------
 * TEST 11
 * Algorithm errors should be passed to next(error)
 * ---------------------------------------------------------
 */
test("algorithm errors should be passed to next()", async () => {
    const error = new Error(
        "Storage unavailable"
    );

    const algorithm = {
        check: async () => {
            throw error;
        }
    };

    const limiter = new RateLimiter(
        algorithm
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    let receivedError = null;

    const next = (err) => {
        receivedError = err;
    };

    await middleware(req, res, next);

    assert.strictEqual(
        receivedError,
        error
    );
});


/*
 * ---------------------------------------------------------
 * TEST 12
 * Should not return 429 when algorithm throws
 * ---------------------------------------------------------
 */
test("algorithm errors should not be converted into 429", async () => {
    const error = new Error(
        "Storage unavailable"
    );

    const algorithm = {
        check: async () => {
            throw error;
        }
    };

    const limiter = new RateLimiter(
        algorithm
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    let receivedError = null;

    const next = (err) => {
        receivedError = err;
    };

    await middleware(req, res, next);

    assert.strictEqual(
        receivedError,
        error
    );

    assert.strictEqual(
        res.statusCode,
        null
    );
});


/*
 * ---------------------------------------------------------
 * TEST 13
 * Allowed request should still receive rate-limit headers
 * ---------------------------------------------------------
 */
test("allowed request should receive rate-limit headers", async () => {
    const algorithm = {
        check: async () => ({
            allowed: true,
            limit: 10,
            remaining: 7,
            resetAt: 1060000
        })
    };

    const clock = new FakeClock(1000000);

    const limiter = new RateLimiter(
        algorithm,
        {
            clock
        }
    );

    const middleware = limiter.middleware();

    const req = {
        ip: "127.0.0.1"
    };

    const res = createResponse();

    const next = () => {};

    await middleware(req, res, next);

    assert.strictEqual(
        res.headers["X-RateLimit-Limit"],
        10
    );

    assert.strictEqual(
        res.headers["X-RateLimit-Remaining"],
        7
    );

    assert.strictEqual(
        res.headers["X-RateLimit-Reset"],
        1060
    );
});