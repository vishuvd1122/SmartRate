// Token bucket algorithm placeholder

class TokenBucket {
  constructor(rate, capacity) {
    this.rate = rate;
    this.capacity = capacity;
  }

  allow(key) {
    return { allowed: true };
  }
}

module.exports = TokenBucket;
