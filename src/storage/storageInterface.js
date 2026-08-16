// Storage interface - define methods expected by stores

class StorageInterface {
  async increment(key, value = 1) {
    throw new Error('Not implemented');
  }

  async get(key) {
    throw new Error('Not implemented');
  }

  async reset(key) {
    throw new Error('Not implemented');
  }
}

module.exports = StorageInterface;
