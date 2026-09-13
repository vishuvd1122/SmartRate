# Complete Request Flow Guide: How SmartRate Processes Every Request

This guide explains **exactly what happens from the moment a user clicks a link or makes an API request to the moment they get a response**.

---

## 1. The Big Picture: The Security Guard Analogy

Think of your web server like a **Nightclub with a strict capacity limit of 5 entries per minute**:

1. **The Client (User/Browser):** Someone walks up to the club entrance.
2. **The Security Guard (`rateLimiter.js`):** Stands at the door and stops them.
3. **The ID Scanner (`identifier.js`):** Checks their ID card (IP address: `"127.0.0.1"`).
4. **The Manager (`baseAlgorithm.js`):** Coordinates the rules and checks the wall clock.
5. **The Wall Clock (`systemClock.js`):** Tells everyone the exact current time.
6. **The Guestbook (`memoryStore.js`):** Keeps the record of entries in a ledger.
7. **The Rulebook (`fixedWindow.js`):** Looks at the guestbook and calculates: *"Has this person visited less than 5 times in the last minute?"*

* If **YES**: The guard stamps their hand, hands them entry headers, and lets them in to the party (`200 OK`).
* If **NO**: The guard says *"Sorry, you're at your limit. Come back in 45 seconds"* (`429 Too Many Requests`).

---

## 2. The Cast of Characters: Who Does What?

| File Name | Real-World Role | What It Actually Does |
| :--- | :--- | :--- |
| **`src/middleware/rateLimiter.js`** | The Security Guard | Intercepts HTTP requests, asks the algorithm for permission, sets response headers, and allows or blocks the request. |
| **`src/identifiers/identifier.js`** | The ID Scanner | Looks at the incoming HTTP request and pulls out the client's IP address (e.g. `"127.0.0.1"`). |
| **`src/clock/systemClock.js`** | The Wall Clock | Tells the system the current time in milliseconds (`Date.now()`). |
| **`src/algorithms/baseAlgorithm.js`** | The Manager | Coordinates the check. Gets time from the clock, gets TTL, and tells storage to run the calculation atomically. |
| **`src/algorithms/fixedWindow.js`** | The Rulebook (Pure Math) | Checks if the time window expired or if count reached the limit. Calculates new count and remaining quota. |
| **`src/storage/memoryStore.js`** | The Memory Ledger | Holds the data in RAM (`new Map()`). Runs the calculation and saves the new count in one indivisible step. |
| **`src/index.js`** | The Venue / Route | The actual API route (`app.get("/")`). Only reached if the request is approved! |

---

## 3. Visual Flowchart

```
Client sends: GET /
       │
       ▼
1. [ src/middleware/rateLimiter.js ]
   │
   ├──► 2. [ src/identifiers/identifier.js ]
   │       └── Returns IP: "127.0.0.1"
   │
   └──► 3. [ src/algorithms/baseAlgorithm.js ] (check)
           │
           ├──► 4. [ src/clock/systemClock.js ] (now)
           │       └── Returns: 1700000000000 ms
           │
           ├──► 5. [ src/algorithms/fixedWindow.js ] (getTtlMs)
           │       └── Returns TTL: 60000 ms
           │
           └──► 6. [ src/storage/memoryStore.js ] (mutate)
                   │
                   └──► 7. [ src/algorithms/fixedWindow.js ] (compute)
                           └── Checks math: allowed? remaining? resetAt?
   │
   ▼
8. [ src/middleware/rateLimiter.js ] sets headers:
   • X-RateLimit-Limit: 5
   • X-RateLimit-Remaining: 4 (or 0)
   • X-RateLimit-Reset: 1700000060
   │
   ├── [ IF ALLOWED ] ──► Calls next() ──► 9. [ Route Handler in index.js ] ──► 200 OK
   │
   └── [ IF BLOCKED ] ──► Sets Retry-After ──► Returns HTTP 429 Too Many Requests
```

---

## 4. Step-by-Step Deep Dive: The Entire Journey

Let's walk through the code line-by-line in the exact order it runs.

---

### Step 1: The Request Arrives at the Middleware
* **File:** `src/middleware/rateLimiter.js` (lines 25–27)
* When a user visits your API, Express passes the request into:
  ```javascript
  return async (req, res, next) => { ... }
  ```
* **What it does:** The rate limiter intercepts the request **before** it can reach your database or route handler.

---

### Step 2: Figuring Out Who the Client Is
* **File:** `src/identifiers/identifier.js` (lines 3–6)
* **Called by:** `rateLimiter.js` line 28:
  ```javascript
  const identifier = this.keyGenerator(req);
  ```
* **What happens inside:**
  ```javascript
  function identifier(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  }
  ```
* **Result:** We now have a unique label for this user, e.g. `"127.0.0.1"`.

---

### Step 3: Asking the Algorithm to Check the Client
* **File:** `src/algorithms/baseAlgorithm.js` (line 31)
* **Called by:** `rateLimiter.js` line 30:
  ```javascript
  const result = await this.algorithm.check(identifier);
  ```
* **What happens inside `baseAlgorithm.js`:**
  The `BaseAlgorithm` coordinates three pieces of information:
  1. **The current time:** Calls `this.clock.now()`.
  2. **The time-to-live (expiry):** Calls `this.getTtlMs(now)`.
  3. **The atomic update:** Calls `this.store.mutate(...)`.

---

### Step 4: Getting the Current Time
* **File:** `src/clock/systemClock.js` (lines 2–4)
* **Called by:** `baseAlgorithm.js` line 32:
  ```javascript
  const now = this.clock.now();
  ```
* **What happens inside:**
  ```javascript
  now() {
    return Date.now();
  }
  ```
* **Result:** We get the current Unix time in milliseconds, for example `1700000000000`.

---

### Step 5: Finding the Expiry Duration (TTL)
* **File:** `src/algorithms/fixedWindow.js` (lines 21–23)
* **Called by:** `baseAlgorithm.js` line 33:
  ```javascript
  const ttlMs = this.getTtlMs(now);
  ```
* **What happens inside:**
  ```javascript
  getTtlMs(now) {
    return this.window; // 60000 ms (1 minute)
  }
  ```
* **Result:** Storage knows to automatically clean up this client's record after 60 seconds of inactivity.

---

### Step 6: Atomic Mutation in Storage (No Race Conditions!)
* **File:** `src/storage/memoryStore.js` (lines 40–56)
* **Called by:** `baseAlgorithm.js` line 37:
  ```javascript
  return this.store.mutate(
    identifier,
    (currentState) => this.compute(currentState, now),
    ttlMs
  );
  ```
* **What happens inside `memoryStore.js`:**
  1. It reads the client's current record from RAM:
     ```javascript
     const current = this.data.get("127.0.0.1") || null;
     ```
  2. It hands `current` and `now` to the rulebook (`fixedWindow.compute()`).
  3. It immediately saves the new record back into RAM:
     ```javascript
     this.data.set("127.0.0.1", nextState);
     ```
  4. It schedules automatic deletion after 60,000 ms.
  5. It returns the decision result.

> **Why this prevents bugs:** In Node.js, this reading and writing happens synchronously in one single uninterrupted step. No other request can sneak in between!

---

### Step 7: The Math Calculation (The Decision)
* **File:** `src/algorithms/fixedWindow.js` (lines 25–89)
* **Function:** `compute(state, now)`
* **Inputs:**
  - `state`: The user's past data (e.g. `{ count: 3, windowStart: 1699999980000 }` or `null` if first time).
  - `now`: Current timestamp (e.g. `1700000000000`).

Here is the exact logic it runs:

#### Case A: First Time Visitor (`!state`)
* The user has never made a request before.
* **Action:** Starts a brand new window.
* **New State:** `{ count: 1, windowStart: now }`.
* **Result:** `allowed: true`, `limit: 5`, `remaining: 4`, `resetAt: now + 60000`.

#### Case B: The Window Expired (`now - state.windowStart >= 60000`)
* The user visited 2 minutes ago, so their previous minute window is finished.
* **Action:** Resets the counter back to 1.
* **New State:** `{ count: 1, windowStart: now }`.
* **Result:** `allowed: true`, `limit: 5`, `remaining: 4`, `resetAt: now + 60000`.

#### Case C: Within Active Window & Under Limit (`state.count < 5`)
* The user visited 10 seconds ago and current count is 3.
* **Action:** Increments the counter by 1 (`3 + 1 = 4`).
* **New State:** `{ count: 4, windowStart: state.windowStart }`.
* **Result:** `allowed: true`, `limit: 5`, `remaining: 1`, `resetAt: windowStart + 60000`.

#### Case D: Limit Reached (`state.count >= 5`)
* The user already made 5 requests in this minute!
* **Action:** Does **NOT** increment the counter. Keeps count at 5.
* **New State:** `{ count: 5, windowStart: state.windowStart }`.
* **Result:** `allowed: false`, `limit: 5`, `remaining: 0`, `resetAt: windowStart + 60000`.

---

### Step 8: Adding Rate-Limit Headers to the Response
* **File:** `src/middleware/rateLimiter.js` (lines 55–61)
* **Function:** `setHeaders(res, result)`
* Whether the request is allowed or blocked, it attaches 3 standard HTTP headers:
  ```javascript
  res.setHeader("X-RateLimit-Limit", 5);
  res.setHeader("X-RateLimit-Remaining", result.remaining); // e.g. 4 (or 0)
  res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000)); // timestamp in seconds
  ```
* This lets the client's browser or mobile app know how many requests they have left.

---

### Step 9: The Final Fork in the Road: Allowed vs. Blocked

In `src/middleware/rateLimiter.js` (lines 34–48):

```javascript
if (!result.allowed) {
  // BLOCKED PATH
  const retryAfter = Math.max(0, Math.ceil((result.resetAt - this.clock.now()) / 1000));
  res.setHeader("Retry-After", retryAfter);

  return res.status(429).json({
    error: "Too Many Requests",
    message: "Rate limit exceeded"
  });
}

// ALLOWED PATH
next();
```

---

## 5. Walkthrough: The "Allowed" Request (200 OK)

When `result.allowed === true`:
1. The guard calls `next()` (line 48).
2. Express continues to the actual route in `src/index.js`:
   ```javascript
   app.get("/", (req, res) => {
     res.json({
       success: true,
       message: "Request is approved!"
     });
   });
   ```
3. The client receives:
   * **Status Code:** `200 OK`
   * **Headers:** `X-RateLimit-Limit: 5`, `X-RateLimit-Remaining: 4`, `X-RateLimit-Reset: 1700000060`
   * **Body:** `{"success": true, "message": "Request is approved!"}`

---

## 6. Walkthrough: The "Blocked" Request (429 Too Many Requests)

When `result.allowed === false`:
1. The guard calculates how many seconds remain until the window resets:
   ```javascript
   const retryAfter = Math.ceil((resetAt - now) / 1000); // e.g. 45 seconds
   ```
2. Attaches the `Retry-After: 45` header.
3. Immediately returns HTTP 429:
   ```json
   {
     "error": "Too Many Requests",
     "message": "Rate limit exceeded"
   }
   ```
4. **Crucial:** `next()` is **never** called. The route handler in `index.js` is never touched, protecting your database and server from overload.

---

## 7. Error Safety: What If Something Goes Wrong?
* In `src/middleware/rateLimiter.js` (lines 49–51):
  ```javascript
  } catch (error) {
    next(error);
  }
  ```
* If storage fails or Redis drops offline, the error is safely caught and forwarded to Express's central error handler. The server never freezes or crashes silently.

---

## 8. Summary Checklist for Interviews

If an interviewer asks: *"Can you walk me through the life of a request in your rate limiter?"*

Here is your 60-second summary:
> 1. *"The request first hits our **RateLimiter Express middleware**, which calls `identifier(req)` to extract the client's IP."*
> 2. *"The middleware delegates the check to `BaseAlgorithm.check()`, which fetches the current time from `SystemClock` and requests an atomic state update via `store.mutate()`."*
> 3. *"Inside `MemoryStore.mutate()`, reading the state, running `FixedWindow.compute()`, and writing the new count happens synchronously in a single tick, completely eliminating race conditions."*
> 4. *"`FixedWindow.compute()` acts as a pure mathematical reducer—it checks if the window expired, checks if count is under limit, and calculates remaining quota."*
> 5. *"Finally, the middleware attaches standard `X-RateLimit-*` headers to the HTTP response. If allowed, it calls `next()` to proceed to the route; if blocked, it sets `Retry-After` and returns an HTTP 429 Too Many Requests JSON error."*
