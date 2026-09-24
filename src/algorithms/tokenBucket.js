const BaseAlgorithm = require("./baseAlgorithm");

class TokenBucket extends BaseAlgorithm {
  constructor(options, storage, clock) {
    super(options, storage, clock);

    if (!options || typeof options !== "object") {
      throw new Error("options must be an object");
    }

    const capacity = options.capacity !== undefined ? options.capacity : options.limit;

    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("capacity (or limit) must be a positive integer");
    }

    // Determine refill rate in tokens per millisecond:
    // 1. Explicit refillRatePerMs (e.g. 0.001 tokens/ms)
    // 2. tokensPerInterval & interval (e.g. 1 token every 1000ms)
    // 3. refillRate (treated as tokens per second, e.g. 2 tokens/sec = 0.002 tokens/ms)
    // 4. window / windowMs (capacity tokens refilled over the window duration)
    let refillRatePerMs;

    if (options.refillRatePerMs !== undefined) {
      refillRatePerMs = options.refillRatePerMs;
    } else if (options.tokensPerInterval !== undefined && options.interval !== undefined) {
      refillRatePerMs = options.tokensPerInterval / options.interval;
    } else if (options.refillRate !== undefined) {
      refillRatePerMs = options.refillRate / 1000; // convert tokens/sec to tokens/ms
    } else if (options.window !== undefined || options.windowMs !== undefined) {
      const windowMs = options.window || options.windowMs;
      refillRatePerMs = capacity / windowMs;
    } else {
      // Default: refill the entire capacity over 60 seconds (60,000 ms)
      refillRatePerMs = capacity / 60000;
    }

    if (!Number.isFinite(refillRatePerMs) || refillRatePerMs <= 0) {
      throw new Error("refill rate must be a positive number");
    }

    const cost = options.cost !== undefined ? options.cost : 1;

    if (!Number.isInteger(cost) || cost <= 0) {
      throw new Error("cost must be a positive integer");
    }

    if (cost > capacity) {
      throw new Error("cost cannot exceed bucket capacity");
    }

    this.capacity = capacity;
    this.refillRatePerMs = refillRatePerMs;
    this.cost = cost;
  }

  /**
   * Overrides TTL calculation for TokenBucket.
   * Ensures the key stays in storage as long as the bucket needs time to refill to capacity.
   *
   * @param {number} now
   * @returns {number} TTL in milliseconds
   */
  getTtlMs(now) {
    return Math.ceil(this.capacity / this.refillRatePerMs);
  }

  /**
   * Pure state reducer for Token Bucket:
   * (currentState, now) => { nextState, result }
   *
   * @param {Object|null} state - Stored state: { tokens: number, lastRefill: number }
   * @param {number} now - Current timestamp in ms
   * @returns {{ nextState: Object, result: Object }}
   */
  compute(state, now) {
    let tokens = this.capacity;
    let lastRefill = now;

    if (state) {
      const elapsedMs = Math.max(0, now - state.lastRefill);
      tokens = Math.min(this.capacity, state.tokens + elapsedMs * this.refillRatePerMs);
      lastRefill = now;
    }

    // Check if enough tokens are available for this request's cost
    if (tokens < this.cost) {
      const msUntilTokensAvailable = Math.ceil((this.cost - tokens) / this.refillRatePerMs);
      const resetAt = now + msUntilTokensAvailable;

      return {
        nextState: {
          tokens,
          lastRefill,
        },
        result: {
          allowed: false,
          limit: this.capacity,
          remaining: Math.floor(tokens),
          resetAt,
        },
      };
    }

    // Request is allowed: consume `this.cost` tokens
    const nextTokens = tokens - this.cost;
    const msUntilFull = Math.ceil((this.capacity - nextTokens) / this.refillRatePerMs);
    const resetAt = now + msUntilFull;

    return {
      nextState: {
        tokens: nextTokens,
        lastRefill: now,
      },
      result: {
        allowed: true,
        limit: this.capacity,
        remaining: Math.floor(nextTokens),
        resetAt,
      },
    };
  }
}

module.exports = TokenBucket;

