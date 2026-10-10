import { Request, Response, NextFunction } from "express";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface Clock {
  now(): number;
}

export abstract class StorageInterface {
  abstract get(key: string): Promise<any>;
  abstract set(key: string, value: any, ttlMs?: number): Promise<any>;
  abstract delete(key: string): Promise<any>;
  abstract mutate(
    key: string,
    reducerFn: (currentState: any, now: number) => { nextState: any; result: any },
    ttlMs?: number,
    explicitNow?: number
  ): Promise<any>;
  abstract increment(key: string, amount?: number, ttlMs?: number): Promise<number>;
}

export interface RedisStoreOptions {
  prefix?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  ownsClient?: boolean;
}

export class RedisStore extends StorageInterface {
  constructor(redisClient: any, options?: RedisStoreOptions);
  prefix: string;
  maxRetries: number;
  retryDelayMs: number;
  ownsClient: boolean;
  close(): Promise<void>;
  eval(script: string, keys?: string[], args?: any[]): Promise<any>;
}

export class MemoryStore extends StorageInterface {
  constructor();
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
}

export abstract class BaseAlgorithm {
  constructor(options: any, storage: StorageInterface, clock?: Clock);
  options: any;
  store: StorageInterface;
  clock: Clock;
  check(identifier: string): Promise<RateLimitResult>;
  getTtlMs(now: number): number;
  abstract compute(state: any, now: number): { nextState: any; result: RateLimitResult };
}

export interface FixedWindowOptions {
  limit: number;
  window: number;
}

export class FixedWindow extends BaseAlgorithm {
  constructor(options: FixedWindowOptions, storage: StorageInterface, clock?: Clock);
  limit: number;
  window: number;
}

export interface TokenBucketOptions {
  capacity?: number;
  limit?: number;
  refillRate?: number;
  refillRatePerMs?: number;
  tokensPerInterval?: number;
  interval?: number;
  window?: number;
  windowMs?: number;
  cost?: number;
}

export class TokenBucket extends BaseAlgorithm {
  constructor(options: TokenBucketOptions, storage: StorageInterface, clock?: Clock);
  capacity: number;
  refillRatePerMs: number;
  cost: number;
}

export interface SlidingWindowLogOptions {
  limit?: number;
  capacity?: number;
  window?: number;
  windowMs?: number;
  cost?: number;
}

export class SlidingWindowLog extends BaseAlgorithm {
  constructor(options: SlidingWindowLogOptions, storage: StorageInterface, clock?: Clock);
  limit: number;
  window: number;
  cost: number;
}

export interface LeakyBucketOptions {
  capacity?: number;
  limit?: number;
  leakRate?: number;
  rate?: number;
  leakInterval?: number;
  leakIntervalMs?: number;
  window?: number;
  windowMs?: number;
  cost?: number;
}

export class LeakyBucket extends BaseAlgorithm {
  constructor(options: LeakyBucketOptions | number, storage: StorageInterface, clock?: Clock);
  capacity: number;
  leakInterval: number;
  cost: number;
}

export interface RateLimiterOptions {
  keyGenerator?: (req: Request) => string;
  clock?: Clock;
  failOpen?: boolean;
}

export class RateLimiter {
  constructor(algorithm: BaseAlgorithm, options?: RateLimiterOptions);
  algorithm: BaseAlgorithm;
  keyGenerator: (req: Request) => string;
  clock: Clock;
  failOpen: boolean;
  middleware(): (req: Request, res: Response, next: NextFunction) => Promise<void>;
  static getClientIp(req: any): string;
}

export interface RateLimitFactoryOptions {
  limit?: number;
  max?: number;
  capacity?: number;
  windowMs?: number;
  window?: number;
  algorithm?: "fixed-window" | "token-bucket" | "sliding-window-log" | "leaky-bucket" | BaseAlgorithm;
  redis?: any;
  client?: any;
  store?: StorageInterface;
  prefix?: string;
  keyGenerator?: (req: Request) => string;
  failOpen?: boolean;
  cost?: number;
  refillRate?: number;
  leakRate?: number;
  clock?: Clock;
  redisOptions?: Partial<RedisStoreOptions>;
  algorithmOptions?: Record<string, any>;
}

export interface RateLimitMiddleware {
  (req: Request, res: Response, next: NextFunction): Promise<void>;
  limiter: RateLimiter;
  store: StorageInterface;
  algorithm: BaseAlgorithm;
}

export function rateLimit(options?: RateLimitFactoryOptions): RateLimitMiddleware;

export default rateLimit;

export class RateLimitError extends Error {
  status: number;
}

export class StorageError extends Error {
  cause?: Error;
}

export class ConcurrencyContentionError extends StorageError {}
export class SystemClock implements Clock {
  now(): number;
}

