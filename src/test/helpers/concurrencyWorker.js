const { parentPort, workerData } = require("node:worker_threads");
const RedisStore = require("../../storage/redisStore");
const FixedWindow = require("../../algorithms/fixedWindow");
const RateLimiter = require("../../middleware/rateLimiter");

/**
 * Worker thread for multi-process / multi-isolate concurrency testing.
 * Bridges Redis commands to the main thread over MessagePort to test
 * concurrent OCC transactions across distinct V8 threads.
 */
function createBridgeClient() {
  let reqId = 0;
  const pending = new Map();

  parentPort.on("message", (msg) => {
    if (msg && msg.type === "resp" && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.name = msg.error.name;
        reject(err);
      } else {
        resolve(msg.result);
      }
    }
  });

  function callRemote(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "cmd", id, method, args });
    });
  }

  const client = {
    async get(key) {
      return callRemote("get", [key]);
    },
    async set(key, val, ...args) {
      return callRemote("set", [key, val, ...args]);
    },
    async del(...keys) {
      return callRemote("del", keys);
    },
    async watch(...keys) {
      return callRemote("watch", keys);
    },
    async unwatch() {
      return callRemote("unwatch", []);
    },
    async pttl(key) {
      return callRemote("pttl", [key]);
    },
    multi() {
      const queue = [];
      return {
        set(k, v, ...args) {
          queue.push({ cmd: "set", args: [k, v, ...args] });
          return this;
        },
        del(...keys) {
          queue.push({ cmd: "del", args: keys });
          return this;
        },
        async exec() {
          return callRemote("multi_exec", [queue]);
        },
      };
    },
    async executeIsolated(fn) {
      return fn(client);
    },
  };

  return client;
}

async function runWorker() {
  const { identifier, limit, windowMs, requestCount } = workerData;
  const bridgeClient = createBridgeClient();
  const store = new RedisStore(bridgeClient, { maxRetries: 10, retryDelayMs: 5 });
  const algorithm = new FixedWindow({ limit, window: windowMs }, store);
  const limiter = new RateLimiter(algorithm);
  const middleware = limiter.middleware();

  let allowed = 0;
  let blocked = 0;

  for (let i = 0; i < requestCount; i++) {
    let status = 200;
    const req = { ip: identifier };
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json() {},
      setHeader() {},
    };

    await middleware(req, res, () => {});

    if (status === 200) {
      allowed++;
    } else if (status === 429) {
      blocked++;
    }
  }

  parentPort.postMessage({ type: "done", allowed, blocked });
}

runWorker().catch((err) => {
  parentPort.postMessage({ type: "error", error: err.message });
});
