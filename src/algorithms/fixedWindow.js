class FixedWindow {
    constructor(options, storage) {
        this.limit = options.limit;
        this.window = options.window; //window size
        this.store = store
    }


    async check (identifier){
        const now = Date.now();
        const state = this.store.get(identifier);

        // if the user's ip is not present in the map.
        if (state === undefined){
            const newState = {
                count = 1,
                windowStart = now
            }
            this.store.set (identifier,newState)

            return {
                allowed : true,
                limit : this.limit,
                remaining : this.limit - 1,
                resetAt: now + this.window
            }
        }

        //if the user's ip is present in the map.
        const ellapsedTime = now - state.windowStart
        if (ellapsedTime >= this.window){
            // window is expired, make a new entry

            const newState = {
            count: 1,
            windowStart: now
        };

        this.store.set(identifier, newState);

        return {
            allowed: true,
            limit: this.limit,
            remaining: this.limit - 1,
            resetAt: now + this.window
        };
        }

        if (ellapsedTime < this.window){
            // check the limit of the requests.

            const allowedLimit = this.limit;

            if (state.count >= allowedLimit){
                return{
                    allowed: false,
                    limit: this.limit,
                    remaining: 0, 
                    resetAt: state.windowStart + this.window
                }
            }

            state.count++;
            this.store.set(identifier, state);
            return {
                allowed: true,
                limit: this.limit,
                remaining: this.limit - state.count,
                resetAt: state.windowStart + this.window
            };

        }
    }
}