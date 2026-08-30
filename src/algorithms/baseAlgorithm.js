const SystemClock = require("../clock/systemClock");

class BaseAlgorithm {
  constructor(options = {}, storage, clock = new SystemClock()) {
    if (!options || typeof options !== "object") {
      throw new Error("options must be an object");
    }

    if (
      !storage ||
      (typeof storage.mutate !== "function" &&
       typeof storage.update !== "function" &&
       (typeof storage.get !== "function" || typeof storage.set !== "function"))
    ) {
      throw new Error("storage must implement mutate(), update(), or get() and set()");
    }

    if (!clock || typeof clock.now !== "function") {
      throw new Error("clock must implement now()");
    }

    this.options = options;
    this.store = storage;
    this.clock = clock;
  }

  /**
   * Main entry point called by the middleware.
   * Atomically executes the algorithm's pure compute() method in storage.
   */
  async check(identifier) {
    const now = this.clock.now();
    const ttlMs = this.getTtlMs(now);

    // 1. If store supports atomic mutate (standard)
    if (typeof this.store.mutate === "function") {
      return this.store.mutate(
        identifier,
        (currentState) => this.compute(currentState, now),
        ttlMs
      );
    }

    // 2. If store supports atomic update
    if (typeof this.store.update === "function") {
      const updateRes = await this.store.update(
        identifier,
        (currentState) => {
          const res = this.compute(currentState, now);
          return { state: res.nextState, result: res.result };
        },
        ttlMs
      );
      return updateRes.result || updateRes;
    }

    // 3. Fallback for custom stores with only get/set
    const currentState = await this.store.get(identifier);
    const { nextState, result } = this.compute(currentState, now);
    if (nextState !== undefined) {
      await this.store.set(identifier, nextState, ttlMs);
    }
    return result;
  }

  getTtlMs(now) {
    return this.options.window || 60000;
  }

  /**
   * Pure state-transition function. Must be implemented by subclasses.
   */
  compute(state, now) {
    throw new Error("Subclasses of BaseAlgorithm must implement compute(state, now)");
  }
}

module.exports = BaseAlgorithm;
