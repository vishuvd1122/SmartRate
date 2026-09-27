const SystemClock = require("../clock/systemClock");
const { StorageError } = require("../errors/errors");

class RateLimiter {
  constructor(algorithm, options = {}) {
    if (!algorithm || typeof algorithm.check !== "function") {
      throw new Error("algorithm must implement check()");
    }

    const {
      keyGenerator = (req) => req.ip,
      clock = new SystemClock(),
      failOpen = false,
    } = options;

    if (typeof keyGenerator !== "function") {
      throw new Error("keyGenerator must be a function");
    }

    if (!clock || typeof clock.now !== "function") {
      throw new Error("clock must implement now()");
    }

    this.algorithm = algorithm;
    this.keyGenerator = keyGenerator;
    this.clock = clock;
    this.failOpen = failOpen === true;
  }

  middleware() {
    return async (req, res, next) => {
      try {
        const identifier = this.keyGenerator(req);

        const result = await this.algorithm.check(identifier);

        this.setHeaders(res, result);

        if (!result.allowed) {
          const retryAfter = Math.max(
            0,
            Math.ceil((result.resetAt - this.clock.now()) / 1000),
          );

          res.setHeader("Retry-After", retryAfter);

          return res.status(429).json({
            error: "Too Many Requests",
            message: "Rate limit exceeded",
          });
        }

        next();
      } catch (error) {
        const isFailOpen =
          this.failOpen ||
          this.algorithm?.options?.failOpen ||
          this.algorithm?.store?.failOpen;

        if (isFailOpen && error instanceof StorageError) {
          if (res && typeof res.setHeader === "function") {
            res.setHeader("X-RateLimit-Degraded", "true");
          }
          return next();
        }

        next(error);
      }
    };
  }

  setHeaders(res, result) {
    res.setHeader("X-RateLimit-Limit", result.limit);

    res.setHeader("X-RateLimit-Remaining", result.remaining);

    res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));
  }
}

module.exports = RateLimiter;
