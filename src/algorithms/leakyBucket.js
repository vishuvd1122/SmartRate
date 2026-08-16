// Leaky bucket algorithm placeholder

class LeakyBucket {
  constructor(rate) {
    this.rate = rate;
  }

  allow(key) {
    return { allowed: true };
  }
}

module.exports = LeakyBucket;
