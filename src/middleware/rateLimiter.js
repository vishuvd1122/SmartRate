// Simple rate limiter middleware placeholder

module.exports = function rateLimiter(options = {}) {
  return function (req, res, next) {
    // TODO: integrate algorithm + storage + identifiers
    next();
  };
};
