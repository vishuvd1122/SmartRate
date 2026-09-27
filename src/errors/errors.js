class RateLimitError extends Error {
  constructor(message = "Rate limit exceeded") {
    super(message);
    this.name = "RateLimitError";
    this.status = 429;
  }
}

class StorageError extends Error {
  constructor(message = "Storage operation failed", cause = null) {
    super(message);
    this.name = "StorageError";
    if (cause) {
      this.cause = cause;
    }
  }
}

class ConcurrencyContentionError extends StorageError {
  constructor(message = "Concurrency contention exceeded max retries", cause = null) {
    super(message, cause);
    this.name = "ConcurrencyContentionError";
  }
}

module.exports = {
  RateLimitError,
  StorageError,
  ConcurrencyContentionError,
};
