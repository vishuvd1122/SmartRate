// Identifier helper - derive key from request

function identifier(req) {
  // default: use IP address
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

module.exports = identifier;
