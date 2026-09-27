/**
 * FakeRedisClient: In-memory mock implementing the Redis client contract (ioredis / node-redis v4)
 * with authentic connection isolation (executeIsolated / duplicate) and OCC (WATCH/MULTI/EXEC) collision simulation.
 */
class FakeRedisClient {
  constructor(options = {}) {
    this.storage = options.storage || new Map();
    this.versions = options.versions || new Map();
    this.returnNodeRedisFormat = options.returnNodeRedisFormat === true;
    this.shouldThrow = null;
    this.forceWatchConflict = false;
    this._watched = new Map();
    this.connected = true;
  }

  _checkThrow(methodName) {
    if (this.shouldThrow) {
      const err = this.shouldThrow instanceof Error ? this.shouldThrow : new Error(String(this.shouldThrow));
      throw err;
    }
  }

  _isExpired(item) {
    return item && item.expiresAt && Date.now() > item.expiresAt;
  }

  _getClean(key) {
    const item = this.storage.get(key);
    if (!item) return null;
    if (this._isExpired(item)) {
      this.storage.delete(key);
      return null;
    }
    return item;
  }

  _bumpVersion(key) {
    const current = this.versions.get(key) || 0;
    this.versions.set(key, current + 1);
  }

  async connect() {
    this._checkThrow("connect");
    this.connected = true;
    return "OK";
  }

  async quit() {
    this.connected = false;
    return "OK";
  }

  disconnect() {
    this.connected = false;
  }

  async get(key) {
    this._checkThrow("get");
    const item = this._getClean(key);
    return item ? item.value : null;
  }

  async set(key, value, ...args) {
    this._checkThrow("set");
    let ttlMs = null;

    if (args.length >= 2) {
      const mode = String(args[0]).toUpperCase();
      const val = Number(args[1]);
      if (mode === "PX" && !isNaN(val)) {
        ttlMs = val;
      } else if (mode === "EX" && !isNaN(val)) {
        ttlMs = val * 1000;
      }
    } else if (args.length === 1 && typeof args[0] === "object") {
      if (args[0].PX) ttlMs = Number(args[0].PX);
      if (args[0].EX) ttlMs = Number(args[0].EX) * 1000;
    }

    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.storage.set(key, { value: String(value), expiresAt });
    this._bumpVersion(key);
    return "OK";
  }

  async del(...keys) {
    this._checkThrow("del");
    let count = 0;
    for (const key of keys.flat()) {
      if (this.storage.delete(key)) {
        count++;
        this._bumpVersion(key);
      }
    }
    return count;
  }

  async incrby(key, amount = 1) {
    this._checkThrow("incrby");
    const item = this._getClean(key);
    const currentVal = item ? parseInt(item.value, 10) || 0 : 0;
    const newVal = currentVal + amount;
    const expiresAt = item ? item.expiresAt : null;
    this.storage.set(key, { value: String(newVal), expiresAt });
    this._bumpVersion(key);
    return newVal;
  }

  async pexpire(key, ttlMs) {
    this._checkThrow("pexpire");
    const item = this._getClean(key);
    if (!item) return 0;
    item.expiresAt = Date.now() + ttlMs;
    return 1;
  }

  async pttl(key) {
    this._checkThrow("pttl");
    const item = this.storage.get(key);
    if (!item) return -2;
    if (this._isExpired(item)) {
      this.storage.delete(key);
      return -2;
    }
    if (!item.expiresAt) return -1;
    const remaining = item.expiresAt - Date.now();
    return Math.max(0, remaining);
  }

  async watch(...keys) {
    this._checkThrow("watch");
    for (const key of keys.flat()) {
      this._watched.set(key, this.versions.get(key) || 0);
    }
    return "OK";
  }

  async unwatch() {
    this._checkThrow("unwatch");
    this._watched.clear();
    return "OK";
  }

  multi() {
    this._checkThrow("multi");
    return new FakeMulti(this, new Map(this._watched), this.returnNodeRedisFormat);
  }

  duplicate() {
    const dup = new FakeRedisClient({
      storage: this.storage,
      versions: this.versions,
      returnNodeRedisFormat: this.returnNodeRedisFormat,
    });
    dup.shouldThrow = this.shouldThrow;
    dup.forceWatchConflict = this.forceWatchConflict;
    return dup;
  }

  /**
   * Implements node-redis v4+ isolated connection pool simulation.
   */
  async executeIsolated(fn) {
    this._checkThrow("executeIsolated");
    const isolatedClient = this.duplicate();
    return fn(isolatedClient);
  }

  async eval(script, numKeys, ...args) {
    this._checkThrow("eval");
    return "OK";
  }
}

class FakeMulti {
  constructor(client, watchedSnapshot, returnNodeRedisFormat) {
    this.client = client;
    this.watchedSnapshot = watchedSnapshot;
    this.returnNodeRedisFormat = returnNodeRedisFormat;
    this.queue = [];
  }

  set(key, value, ...args) {
    this.queue.push({ cmd: "set", args: [key, value, ...args] });
    return this;
  }

  del(...keys) {
    this.queue.push({ cmd: "del", args: keys });
    return this;
  }

  incrby(key, amount) {
    this.queue.push({ cmd: "incrby", args: [key, amount] });
    return this;
  }

  pexpire(key, ttlMs) {
    this.queue.push({ cmd: "pexpire", args: [key, ttlMs] });
    return this;
  }

  pttl(key) {
    this.queue.push({ cmd: "pttl", args: [key] });
    return this;
  }

  async exec() {
    this.client._checkThrow("exec");

    // Check for forced conflict
    if (this.client.forceWatchConflict) {
      this.client._watched.clear();
      return null;
    }

    // Check for WATCH collision against current versions
    for (const [watchedKey, watchedVer] of this.watchedSnapshot) {
      const currentVer = this.client.versions.get(watchedKey) || 0;
      if (currentVer !== watchedVer) {
        // Watched key was modified by another operation -> conflict!
        this.client._watched.clear();
        return null;
      }
    }

    // Execute queued commands atomically
    const results = [];
    for (const op of this.queue) {
      let res;
      if (op.cmd === "set") {
        res = await this.client.set(...op.args);
      } else if (op.cmd === "del") {
        res = await this.client.del(...op.args);
      } else if (op.cmd === "incrby") {
        res = await this.client.incrby(...op.args);
      } else if (op.cmd === "pexpire") {
        res = await this.client.pexpire(...op.args);
      } else if (op.cmd === "pttl") {
        res = await this.client.pttl(...op.args);
      }
      results.push(this.returnNodeRedisFormat ? res : [null, res]);
    }

    this.client._watched.clear();
    return results;
  }
}

module.exports = FakeRedisClient;
