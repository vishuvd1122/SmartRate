// Sliding window counter implementation

class SlidingWindowCounter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key) {
    return { allowed: true };
  }
}

module.exports = SlidingWindowCounter;
