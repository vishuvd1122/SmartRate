class FakeClock {
    constructor(startTime = 0) {
        this.currentTime = startTime;
    }

    now() {
        return this.currentTime;
    }

    advance(milliseconds) {
        this.currentTime += milliseconds;
    }

    set(time) {
        this.currentTime = time;
    }
}

module.exports = FakeClock;