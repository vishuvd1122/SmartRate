const BaseAlgorithm = require("./baseAlgorithm");

class SlidingWindowLog extends BaseAlgorithm {
  constructor(options, storage, clock) {
    super(options, storage, clock);

    if (!options || typeof options !== "object") {
      throw new Error("options must be an object");
    }

    const limit = options.limit !== undefined ? options.limit : options.capacity;
    const window = options.window !== undefined ? options.window : options.windowMs;

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }

    if (!Number.isFinite(window) || window <= 0) {
      throw new Error("window must be a positive number");
    }

    const cost = options.cost !== undefined ? options.cost : 1;

    if (!Number.isInteger(cost) || cost <= 0) {
      throw new Error("cost must be a positive integer");
    }

    if (cost > limit) {
      throw new Error("cost cannot exceed limit");
    }

    this.limit = limit;
    this.window = window; // window duration in ms
    this.cost = cost;
  }

  /**
   * Overrides TTL calculation for SlidingWindowLog.
   * Key in storage can safely expire after `window` milliseconds of inactivity,
   * as all log timestamps would be outside the sliding window.
   *
   * @param {number} now
   * @returns {number} TTL in milliseconds
   */
  getTtlMs(now) {
    return this.window;
  }

  /**
   * Pure state reducer for Sliding Window Log:
   * (currentState, now) => { nextState, result }
   *
   * @param {Object|null} state - Stored state: { timestamps: number[] }
   * @param {number} now - Current timestamp in ms
   * @returns {{ nextState: Object, result: Object }}
   */
  compute(state, now) {
    const rawTimestamps = state && Array.isArray(state.timestamps) ? state.timestamps : [];
    const windowStart = now - this.window;

    // Prune timestamps that are outside the current sliding window (t <= windowStart)
    const validTimestamps = rawTimestamps.filter((ts) => ts > windowStart);
    const currentCount = validTimestamps.length;

    // Check if the request exceeds the limit
    if (currentCount + this.cost > this.limit) {
      // Calculate the reset at time:
      // `needed` is the number of oldest timestamps that must expire.
      const needed = (currentCount + this.cost) - this.limit;
      const expiringTimestamp = validTimestamps[needed - 1];
      const resetAt = expiringTimestamp + this.window;
      

      return {
        nextState: {
          timestamps: validTimestamps, // return the new array after removing the timestamps before the window time.
        },
        result: {
          allowed: false,
          limit: this.limit,
          remaining: Math.max(0, this.limit - currentCount),
          resetAt,
        },
      };
    }

    // Request is allowed: append `this.cost` copies of `now` to the log
    const newEntries = Array(this.cost).fill(now); //Create an array of the size of cost of request and fill every space in that array with the current time.
    const updatedTimestamps = [...validTimestamps, ...newEntries]; // join the valid time stamps array with the new array creted in the last step to make a new updated array.

    // Reset time for allowed requests: when the oldest timestamp in the log will expire
    const resetAt = updatedTimestamps[0] + this.window;

    console.log(updatedTimestamps);
    

    return {
      nextState: {
        timestamps: updatedTimestamps,
      },
      result: {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - updatedTimestamps.length,
        resetAt,
      },
    };
  }
}

module.exports = SlidingWindowLog;
