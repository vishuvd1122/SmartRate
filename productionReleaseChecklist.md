# SmartRate Production Release Checklist & Pre-Launch Audit

This document outlines the **critical blockers, risks, and necessary remediation steps** required before publishing `smartrate` to npm and releasing it as a public, production-ready open-source library.

---

## 1. Readiness Overview

| Category | Score | Status | Description |
|---|:---:|:---:|---|
| **Core Algorithms & Math** | 10/10 | ✅ **Ready** | Pure reducers (`FixedWindow`, `TokenBucket`, `SlidingWindowLog`, `LeakyBucket`), 100% deterministic, zero side-effects. |
| **Concurrency & Redis OCC** | 9.5/10 | ✅ **Ready** | Connection-isolated transactions, bounded retries with jitter, safe serialization, strict TTL semantics. |
| **High-Level DX (Factory)** | 9.5/10 | ✅ **Ready** | 1-line `rateLimit({ ... })` configuration, alias normalization, automatic IP sanitization. |
| **Automated Test Coverage** | 10/10 | ✅ **Ready** | 153/153 passing tests, 96.9% line coverage, worker-thread concurrency stress tests verified. |
| **Packaging & Dependencies** | 4/10 | ❌ **Blocked** | Express and nodemon bundled in dependencies; broken dev script; no files whitelist. |
| **Documentation & Legal** | 3/10 | ❌ **Blocked** | 5-line placeholder README; truncated MIT license missing disclaimer and author. |
| **Code Hygiene** | 6/10 | ⚠️ **Blocked** | 4 dead/unfinished scaffold files in `src/` (including an un-implemented algorithm stub). |

---

## 2. Critical Release Blockers (Detailed Breakdown)

### Blocker 1: Dependency Misclassification in `package.json`
* **File:** [`package.json`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/package.json) (lines 24–28)
* **The Issue:**
  `express`, `nodemon`, and `redis` are currently listed under `"dependencies"`:
  ```json
  "dependencies": {
    "express": "^5.2.1",
    "nodemon": "^3.1.14",
    "redis": "^6.3.0"
  }
  ```
* **Why It Must Be Fixed:**
  1. **Nodemon bloat:** `nodemon` is a developer tool. Listing it in dependencies forces every consumer's production server/Docker container to download nodemon and dozens of sub-dependencies (`chokidar`, `fsevents`, etc.).
  2. **Express version collision:** Listing `"express": "^5.2.1"` in dependencies forces npm to install Express 5 inside `node_modules/smartrate/node_modules/express`. If the consumer's host application is on Express 4, two conflicting versions of Express run in the same process, causing request/response prototype and middleware corruption.
  3. **Forced Redis download:** Users who only want in-memory rate limiting should not be forced to install the heavy `@redis/client` stack.
* **The Fix:**
  - Move `nodemon` to `"devDependencies"`.
  - Move `express` and `redis` to `"peerDependencies"` and keep them in `"devDependencies"` for local testing.
  - Mark `redis` as optional in `"peerDependenciesMeta"`.
* **Action Checklist:**
  - [ ] Move `nodemon` from `dependencies` to `devDependencies`.
  - [ ] Add `"peerDependencies": { "express": "^4.18.0 || ^5.0.0", "redis": "^4.0.0 || ^6.0.0" }`.
  - [ ] Add `"peerDependenciesMeta": { "redis": { "optional": true } }`.

---

### Blocker 2: Missing `"files"` Whitelist (Leaking Internal Files to npm)
* **File:** [`package.json`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/package.json)
* **The Issue:**
  There is no `"files"` field in `package.json` and no `.npmignore` in the project root.
* **Why It Must Be Fixed:**
  Without a whitelist, `npm publish` uploads **every single file** in the repository to the public npm registry:
  - All test files, concurrency workers, and mock clients (`src/test/`).
  - Internal scratch/planning notes (`todo.md`, `raceCondition.md`, `requestFlow.md`, `function_definitions.md`, `factoryPattern.md`).
  - This pollutes consumer node_modules with ~60KB+ of unnecessary files and leaks internal developer notes.
* **The Fix:**
  Add an explicit `"files"` array to `package.json` to publish only production runtime assets.
* **Action Checklist:**
  - [ ] Add `"files": ["src", "!src/test", "README.md", "LICENSE", "configuration.md"]` to `package.json`.

---

### Blocker 3: Incomplete and Legally Invalid `LICENSE` File
* **File:** [`LICENSE`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/LICENSE)
* **The Issue:**
  The license file is truncated at line 11:
  ```text
  MIT License

  Copyright (c) 

  Permission is hereby granted, free of charge, to any person obtaining a copy
  ...
  furnished to do so, subject to the following conditions:
  ```
  The author name and year are missing, and lines 12–21 (the copyright requirement and the liability disclaimer) are completely absent.
* **Why It Must Be Fixed:**
  1. **Legal Liability:** Without the standard disclaimer (*"THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND..."*), the author has zero legal protection against liability if a consumer experiences an outage or data loss.
  2. **Enterprise Block:** Automated open-source compliance scanners (Snyk, Black Duck, FOSSA) will flag the truncated license as invalid/unknown, preventing corporate developers from adopting the library.
* **The Fix:**
  Replace with the standard, complete 21-line MIT License text with the author name and year (2026).
* **Action Checklist:**
  - [ ] Complete the MIT License text with copyright holder and warranty disclaimer.

---

### Blocker 4: Placeholder `README.md`
* **File:** [`README.md`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/README.md)
* **The Issue:**
  The repository's `README.md` is an unpopulated 5-line stub:
  ```markdown
  # smartrate
  Pluggable rate limiter library scaffold.
  See `src/` for implementation and `tests/` for tests.
  ```
* **Why It Must Be Fixed:**
  The README is the public landing page on npmjs.com and GitHub. Without installation instructions, code snippets, algorithm comparisons, and options tables, developers cannot evaluate or use the package.
* **The Fix:**
  Write a complete, professional `README.md` featuring:
  - Badges (tests, license, npm version).
  - 1-minute Quick Start (In-Memory & Redis examples).
  - Feature highlights (Token Bucket, Sliding Window Log, Leaky Bucket, Fixed Window).
  - Configuration table and link to `configuration.md`.
  - Concurrency guarantees & architecture overview.
* **Action Checklist:**
  - [ ] Write a production-grade `README.md`.

---

### Blocker 5: Dead and Incomplete Scaffold Files
* **Files:**
  1. `src/algorithms/slidingWindowCounter.js`
  2. `src/utils/validation.js`
  3. `src/utils/time.js`
  4. `src/identifiers/identifier.js`
* **The Issue:**
  - `slidingWindowCounter.js` is an unfinished 15-line stub that always returns `{ allowed: true }` without implementing `BaseAlgorithm` or storage persistence.
  - `validation.js` is a 10-line stub containing `// TODO: add thorough validation`.
  - `time.js` is an 8-line stub that is unused across the entire codebase.
  - `identifier.js` is an early prototype superseded by `RateLimiter.getClientIp(req)`.
* **Why It Must Be Fixed:**
  - **Security hole:** If a user discovers and imports `SlidingWindowCounter`, rate limiting is completely bypassed because it unconditionally returns `{ allowed: true }`.
  - **Code quality:** Shipping incomplete code with `TODO` stubs signals an unfinished hobby project rather than an enterprise library.
* **The Fix:**
  Delete these 4 dead files. (If `SlidingWindowCounter` is desired in the future, implement it properly with full tests in a v1.1 minor release).
* **Action Checklist:**
  - [ ] Remove `src/algorithms/slidingWindowCounter.js`.
  - [ ] Remove `src/utils/validation.js`.
  - [ ] Remove `src/utils/time.js`.
  - [ ] Remove `src/identifiers/identifier.js`.

---

### Blocker 6: Broken `"dev"` Script in `package.json`
* **File:** [`package.json`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/package.json) (line 8)
* **The Issue:**
  ```json
  "scripts": {
    "dev": "nodemon index.js"
  }
  ```
  There is no `index.js` in the project root; the file is located at `src/index.js`.
* **Why It Must Be Fixed:**
  Running `npm run dev` crashes immediately with:
  `[nodemon] failed to start process "node index.js" : ENOENT`.
* **The Fix:**
  Change the script target to `"dev": "nodemon src/index.js"`.
* **Action Checklist:**
  - [ ] Update `"dev"` script in `package.json` to point to `src/index.js`.

---

### Blocker 7: Missing Public Module Exports in `src/index.js`
* **File:** [`src/index.js`](file:///z:/Custom%20Rate%20Limiter%20Code/SmartRate/src/index.js) (lines 60–68)
* **The Issue:**
  The entry point only exports algorithms, stores, and the middleware. It fails to export:
  - `StorageInterface` (needed for custom database adapters like Mongo, DynamoDB, Postgres).
  - `BaseAlgorithm` (needed for custom algorithmic reducers).
  - Error classes: `StorageError`, `RateLimitError`, `ConcurrencyContentionError`.
* **Why It Must Be Fixed:**
  If a consumer wants to catch errors in Express (`if (err instanceof StorageError)`) or build a custom store, they cannot import them from `"smartrate"`. They would have to deep-import private files (`require("smartrate/src/errors/errors.js")`), violating encapsulation.
* **The Fix:**
  Export `StorageInterface`, `BaseAlgorithm`, `StorageError`, `RateLimitError`, and `ConcurrencyContentionError` in `src/index.js`.
* **Action Checklist:**
  - [ ] Export `StorageInterface` and `BaseAlgorithm` from `src/index.js`.
  - [ ] Export `StorageError`, `RateLimitError`, and `ConcurrencyContentionError` from `src/index.js`.

---

## 3. Production Hardening Advisories (Post-Launch / v1.1 Roadmap)

These items are not blockers for v0.1.0/v1.0.0, but should be tracked for subsequent hardening:

1. **MemoryStore DDoS & Timer Churn Hardening:**
   - *Current Behavior:* Every request creates a `setTimeout().unref()` timer, and the internal `Map` is unbounded.
   - *Roadmap:* Implement a `maxKeys` boundary (LRU eviction) and replace per-mutation timers with a single sweeping interval to protect against memory exhaustion under distributed spoofed IP attacks.
2. **TypeScript Type Definitions (`index.d.ts`):**
   - Provide declaration files so TypeScript developers get full autocomplete for `rateLimit({ windowMs, limit, algorithm })`.
3. **Continuous Integration (CI):**
   - Add a GitHub Actions workflow (`.github/workflows/ci.yml`) to automatically run `npm test` across Node.js v18, v20, and v22 on every push/PR.

---

## 4. Verification & Sign-Off Checklist

Before running `npm publish`:

- [ ] All 7 blockers above resolved.
- [ ] Run `node --check src/index.js` (passes).
- [ ] Run `npm test` (all 153 tests pass with 0 failures).
- [ ] Run `npm pack --dry-run` to inspect the exact tarball contents (verify no tests or internal markdown files are included).

