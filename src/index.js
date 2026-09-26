const express = require("express");

const MemoryStore = require("./storage/memoryStore.js");
const FixedWindow = require("./algorithms/fixedWindow.js")
const TokenBucket = require("./algorithms/tokenBucket.js");
const RateLimiter = require("./middleware/rateLimiter.js");
const SlidingWindowLog = require ("./algorithms/slidingWindowLog.js")

const app = express();
app.use(express.json());

// 1. Initialize In-Memory Storage
const store = new MemoryStore();


const tokenBucket = new TokenBucket(
  {
    capacity: 5,
    refillRate: 0.5, // 1 token per second
  },
  store
);

const fixedWindow = new FixedWindow(
  {
    limit: 5,
    window: 60000, 
  },
  store
);


const slidingWindowLog = new SlidingWindowLog(
  {
    limit: 5,
    window: 60000, 
  },
  store
);



// 3. Attach RateLimiter middleware
const rateLimiter = new RateLimiter(slidingWindowLog);
app.use(rateLimiter.middleware());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Request is approved!",
  });
});

const PORT = process.env.PORT || 6969;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

