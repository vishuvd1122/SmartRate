const StorageInterface = require("./storageInterface");

class MemoryStore extends StorageInterface {
  constructor() {
    super();
    this.data = new Map();
  }

  async get(key) {
    return this.data.get(key);
  }

  async set(key, value, ttlMs) {
    this.data.set(key, value);
    if (ttlMs) {
      setTimeout(() => this.data.delete(key), ttlMs).unref?.();
    }
  }

  async delete(key) {
    return this.data.delete(key);
  }

  async has(key) {
    return this.data.has(key);
  }

  async clear() {
    this.data.clear();
  }

  /**
   * Atomically executes the algorithm reducer synchronously against the in-memory Map.
   *
   * @param {string} key
   * @param {Function} reducerFn - (currentState) => { nextState, result }
   * @param {number} [ttlMs]
   * @returns {Promise<any>}
   */
  async mutate(key, reducerFn, ttlMs) {
    const current = this.data.get(key) || null;
    const { nextState, result } = reducerFn(current);

    if (nextState !== undefined) {
      this.data.set(key, nextState);
      if (ttlMs) {
        setTimeout(() => {
          if (this.data.get(key) === nextState) {
            this.data.delete(key);
          }
        }, ttlMs).unref?.();
      }
    }

    return result;
  }

  /**
   * Alias for mutate / update support
   */
  async update(key, updaterFn, ttlMs) {
    const current = this.data.get(key);
    const result = updaterFn(current);

    if (result && result.state !== undefined) {
      this.data.set(key, result.state);
      if (ttlMs) {
        setTimeout(() => this.data.delete(key), ttlMs).unref?.();
      }
    }

    return result;
  }

  async increment(key, amount = 1, ttlMs) {
    const current = this.data.get(key) || 0;
    const nextVal = current + amount;
    this.data.set(key, nextVal);

    if (ttlMs && current === 0) {
      setTimeout(() => this.data.delete(key), ttlMs).unref?.();
    }

    return nextVal;
  }

  async eval(fn, key, args) {
    if (typeof fn === "function") {
      return fn(this.data, key, args);
    }
    throw new Error("MemoryStore eval requires a JavaScript function");
  }
}

module.exports = MemoryStore;

