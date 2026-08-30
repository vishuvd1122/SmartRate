const express = require("express");

const MemoryStore = require("./storage/memoryStore.js");
const FixedWindow = require("./algorithms/fixedWindow.js");
const RateLimiter = require("./middleware/rateLimiter.js");
const router = express.Router();

const app = express();
app.use(express.json());

const store = new MemoryStore();

const algorithm = new FixedWindow(
  {
    limit: 5,
    window: 60000,
  },
  store,
);

const rateLimiter = new RateLimiter(algorithm);

app.use(rateLimiter.middleware());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Request is approved!",
  });
});

app.listen(6969, () => {
  console.log("Server is running on port 6969");
});
