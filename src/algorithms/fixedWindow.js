const BaseAlgorithm = require("./baseAlgorithm");

class FixedWindow extends BaseAlgorithm {
    constructor(options, storage, clock) {
        super(options, storage, clock);

        const { limit, window } = options;

        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("limit must be a positive integer");
        }

        if (!Number.isFinite(window) || window <= 0) {
            throw new Error("window must be a positive number");
        }

        this.limit = limit;
        this.window = window; // window size in ms
    }

    getTtlMs(now) {
        return this.window;
    }

    compute(state, now) {
        // Case 1: First request from this identifier
        if (!state) {
            const nextState = {
                count: 1,
                windowStart: now,
            };
            return {
                nextState,
                result: {
                    allowed: true,
                    limit: this.limit,
                    remaining: this.limit - 1,
                    resetAt: now + this.window,
                },
            };
        }

        // Case 2: Window has expired
        const elapsedTime = now - state.windowStart;
        if (elapsedTime >= this.window) {
            const nextState = {
                count: 1,
                windowStart: now,
            };
            return {
                nextState,
                result: {
                    allowed: true,
                    limit: this.limit,
                    remaining: this.limit - 1,
                    resetAt: now + this.window,
                },
            };
        }

        // Case 3: Limit reached (Blocked)
        if (state.count >= this.limit) {
            return {
                nextState: state, // do not increment count
                result: {
                    allowed: false,
                    limit: this.limit,
                    remaining: 0,
                    resetAt: state.windowStart + this.window,
                },
            };
        }

        // Case 4: Under limit (Allowed)
        const nextState = {
            ...state,
            count: state.count + 1,
        };
        return {
            nextState,
            result: {
                allowed: true,
                limit: this.limit,
                remaining: this.limit - nextState.count,
                resetAt: state.windowStart + this.window,
            },
        };
    }
}

module.exports = FixedWindow;
