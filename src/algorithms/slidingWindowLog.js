// Sliding window log implementation

class SlidingWindowLog {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key) {
    return { allowed: true };
  }
}

module.exports = SlidingWindowLog;
