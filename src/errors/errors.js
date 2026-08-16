class RateLimitError extends Error {
  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
  }
}

module.exports = { RateLimitError };
