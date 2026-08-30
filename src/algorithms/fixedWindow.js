const SystemClock = require("../clock/systemClock.js");

class FixedWindow {
    constructor(options, storage, clock = new SystemClock()) {
        if (!options || typeof options !== "object") {
            throw new Error("options must be an object");
        }

        const { limit, window } = options;

        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("limit must be a positive integer");
        }

        if (!Number.isFinite(window) || window <= 0) {
            throw new Error("window must be a positive number");
        }

        if (
            !storage ||
            (typeof storage.update !== "function" &&
             (typeof storage.get !== "function" || typeof storage.set !== "function"))
        ) {
            throw new Error("storage must implement update() or get() and set()");
        }

        if (!clock || typeof clock.now !== "function") {
            throw new Error("clock must implement now()");
        }

        this.limit = limit;
        this.window = window; // window size in ms
        this.store = storage;
        this.clock = clock;
    }

    async check(identifier) {
        const now = this.clock.now();

        // 1. If storage supports atomic update (e.g. MemoryStore)
        if (typeof this.store.update === "function") {
            const result = await this.store.update(
                identifier,
                (state) => {
                    // Case 1: First request from this identifier
                    if (!state) {
                        const newState = {
                            count: 1,
                            windowStart: now,
                        };
                        return {
                            state: newState,
                            allowed: true,
                            remaining: this.limit - 1,
                            resetAt: now + this.window,
                        };
                    }

                    // Case 2: Window has expired
                    const elapsedTime = now - state.windowStart;
                    if (elapsedTime >= this.window) {
                        const newState = {
                            count: 1,
                            windowStart: now,
                        };
                        return {
                            state: newState,
                            allowed: true,
                            remaining: this.limit - 1,
                            resetAt: now + this.window,
                        };
                    }

                    // Case 3: Limit reached (Blocked)
                    if (state.count >= this.limit) {
                        return {
                            state: state, // do not increment count
                            allowed: false,
                            remaining: 0,
                            resetAt: state.windowStart + this.window,
                        };
                    }

                    // Case 4: Under limit (Allowed)
                    const newState = {
                        ...state,
                        count: state.count + 1,
                    };
                    return {
                        state: newState,
                        allowed: true,
                        remaining: this.limit - newState.count,
                        resetAt: state.windowStart + this.window,
                    };
                },
                this.window
            );

            return {
                allowed: result.allowed,
                limit: this.limit,
                remaining: result.remaining,
                resetAt: result.resetAt,
            };
        }

        // 2. Fallback for custom stores with only get/set
        const state = await this.store.get(identifier);

        if (!state) {
            const newState = {
                count: 1,
                windowStart: now,
            };
            await this.store.set(identifier, newState);

            return {
                allowed: true,
                limit: this.limit,
                remaining: this.limit - 1,
                resetAt: now + this.window,
            };
        }

        const elapsedTime = now - state.windowStart;
        if (elapsedTime >= this.window) {
            const newState = {
                count: 1,
                windowStart: now,
            };
            await this.store.set(identifier, newState);

            return {
                allowed: true,
                limit: this.limit,
                remaining: this.limit - 1,
                resetAt: now + this.window,
            };
        }

        if (state.count >= this.limit) {
            return {
                allowed: false,
                limit: this.limit,
                remaining: 0,
                resetAt: state.windowStart + this.window,
            };
        }

        state.count++;
        await this.store.set(identifier, state);
        return {
            allowed: true,
            limit: this.limit,
            remaining: this.limit - state.count,
            resetAt: state.windowStart + this.window,
        };
    }
}

module.exports = FixedWindow;