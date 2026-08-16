class MemoryStore{
    constructor(){
        this.data = new Map ();
    }


    get(key) {
        return this.data.get(key);
    }

    set(key, value) {
        this.data.set(key, value);
    }

    delete(key) {
        return this.data.delete(key);
    }

    has(key) {
        return this.data.has(key);
    }

    clear() {
        this.data.clear();
    }
}

module.exports = MemoryStore;
