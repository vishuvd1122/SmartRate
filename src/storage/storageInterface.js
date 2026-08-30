// Storage interface - define methods expected by stores

class StorageInterface {
  async get(key) {
    throw new Error('Not implemented');
  }

  async set(key, value, ttlMs) {
    throw new Error('Not implemented');
  }

  async delete(key) {
    throw new Error('Not implemented');
  }

  async reset(key) {
    return this.delete(key);
  }

  async increment(key, value = 1) {
    throw new Error('Not implemented');
  }

  async mutate(key, reducerFn, ttlMs) {
    throw new Error('Not implemented');
  }

  async update(key, updaterFn, ttlMs) {
    throw new Error('Not implemented');
  }

  async eval(script, keys, args) {
    throw new Error('Not implemented');
  }
}

module.exports = StorageInterface;


