const BaseAlgorithm = require("./baseAlgorithm");

class LeakyBucket extends BaseAlgorithm {
  constructor(options, storage, clock) {
    // Support passing numeric rate for backward compatibility
    if (typeof options === "number") {
      options = { capacity: options, leakRate: options };
    }

    super(options, storage, clock);

    if (!options || typeof options !== "object") {
      throw new Error("options must be an object");
    }

    const capacity = options.capacity !== undefined ? options.capacity : options.limit;

    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("capacity (or limit) must be a positive integer");
    }

    // Determine leakInterval (milliseconds between leaks for a single request):
    // 1. Explicit leakInterval / leakIntervalMs (e.g. 500ms per leak)
    // 2. leakRate or rate (requests leaked per second, e.g. 2 req/sec -> 500ms)
    // 3. window / windowMs (capacity requests leak over windowMs -> windowMs / capacity)
    let leakInterval;

    if (options.leakInterval !== undefined || options.leakIntervalMs !== undefined) {
      leakInterval = options.leakInterval || options.leakIntervalMs;
    } else if (options.leakRate !== undefined || options.rate !== undefined) {
      const rate = options.leakRate !== undefined ? options.leakRate : options.rate;
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("leakRate (or rate) must be a positive number");
      }
      leakInterval = 1000 / rate;
    } else if (options.window !== undefined || options.windowMs !== undefined) {
      const windowMs = options.window || options.windowMs;
      leakInterval = windowMs / capacity;
    } else {
      // Default: leak 1 request per second (1000ms)
      leakInterval = 1000;
    }

    if (!Number.isFinite(leakInterval) || leakInterval <= 0) {
      throw new Error("leak interval must be a positive number");
    }

    const cost = options.cost !== undefined ? options.cost : 1;

    if (!Number.isInteger(cost) || cost <= 0) {
      throw new Error("cost must be a positive integer");
    }

    if (cost > capacity) {
      throw new Error("cost cannot exceed bucket capacity");
    }

    this.capacity = capacity;
    this.leakInterval = leakInterval; // ms required for 1 request to leak
    this.cost = cost;
  }

  /**
   * Overrides TTL calculation for LeakyBucket.
   * Ensures the key stays in storage as long as the bucket has items queued up to leak.
   *
   * @param {number} now
   * @returns {number} TTL in milliseconds
   */
  getTtlMs(now) {
    return Math.max(60000, Math.ceil(this.capacity * this.leakInterval));
  }

  /**
   * Pure state reducer for Queue-based Leaky Bucket:
   * (currentState, now) => { nextState, result }
   *
   * @param {Object|null} state - Stored state: { queue: number[], lastLeakTime: number }
   * @param {number} now - Current timestamp in ms
   * @returns {{ nextState: Object, result: Object }}
   */
  compute(state, now) {
    let queue = state && Array.isArray(state.queue) ? [...state.queue] : [];
    let lastLeakTime = state && typeof state.lastLeakTime === "number" ? state.lastLeakTime : now;

    // 1. Process leaking from the FIFO queue based on elapsed time
    if (state && queue.length > 0) {
      const elapsed = Math.max(0, now - lastLeakTime);
      const leakedCount = Math.floor(elapsed / this.leakInterval);

      if (leakedCount > 0) {
        if (leakedCount >= queue.length) {
          // Entire queue has leaked out to empty
          queue = [];
          lastLeakTime = now;
        } else {
          // Dequeue `leakedCount` oldest items from the front of the FIFO queue
          queue.splice(0, leakedCount);
          lastLeakTime = lastLeakTime + leakedCount * this.leakInterval;
        }
      }
    } else {
      // If queue is empty, align lastLeakTime with the arrival time of this request
      lastLeakTime = now;
    }

    // 2. Check for queue overflow (bucket capacity reached)
    if (queue.length + this.cost > this.capacity) {
      // Calculate how many items must leak to free up space for `this.cost`
      const needed = (queue.length + this.cost) - this.capacity;
      const resetAt = lastLeakTime + needed * this.leakInterval;

      return {
        nextState: {
          queue,
          lastLeakTime,
        },
        result: {
          allowed: false,
          limit: this.capacity,
          remaining: Math.max(0, this.capacity - queue.length),
          resetAt,
        },
      };
    }

    // 3. Request is allowed: Enqueue `this.cost` entries to the back of the queue
    const newEntries = Array(this.cost).fill(now);
    queue.push(...newEntries);

    // Reset time for allowed requests: when the queue will be completely empty
    const resetAt = lastLeakTime + queue.length * this.leakInterval;

    return {
      nextState: {
        queue,
        lastLeakTime,
      },
      result: {
        allowed: true,
        limit: this.capacity,
        remaining: this.capacity - queue.length,
        resetAt,
      },
    };
  }
}

module.exports = LeakyBucket;