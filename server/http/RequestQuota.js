import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 120;
const DEFAULT_MAX_CLIENTS = 10_000;

export class RequestQuota {
  constructor({
    limit = DEFAULT_LIMIT,
    windowMs = DEFAULT_WINDOW_MS,
    maxClients = DEFAULT_MAX_CLIENTS,
    clock = () => Date.now(),
  } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("limit must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError("windowMs must be a positive number");
    }
    if (!Number.isInteger(maxClients) || maxClients < 1) {
      throw new TypeError("maxClients must be a positive integer");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
    this.clock = clock;
    this.buckets = new Map();
  }

  get size() {
    return this.buckets.size;
  }

  consume(clientKey, cost = 1) {
    if (!Number.isInteger(cost) || cost < 1) throw new TypeError("cost must be a positive integer");
    if (cost > this.limit) {
      throw new RangeError(
        `A request costing ${cost} can never be served under a limit of ${this.limit}: `
        + "raise the limit to at least the largest batch the handler accepts.",
      );
    }
    const key = String(clientKey);
    const now = this.clock();
    const bucket = this.#bucketFor(key, now);

    const elapsed = now - bucket.refilledAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.limit, bucket.tokens + (elapsed * this.limit) / this.windowMs);
      bucket.refilledAt = now;
    }

    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      return {
        allowed: false,
        remaining: Math.floor(Math.max(0, bucket.tokens)),
        retryAfterMs: Math.ceil((deficit * this.windowMs) / this.limit),
      };
    }

    bucket.tokens -= cost;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: 0,
    };
  }

  refund(clientKey, cost) {
    if (!Number.isInteger(cost) || cost < 1) throw new TypeError("cost must be a positive integer");
    const bucket = this.buckets.get(String(clientKey));
    if (!bucket) return false;
    bucket.tokens = Math.min(this.limit, bucket.tokens + cost);
    return true;
  }

  forget(clientKey) {
    return this.buckets.delete(String(clientKey));
  }

  clear() {
    this.buckets.clear();
  }

  #bucketFor(key, now) {
    const existing = this.buckets.get(key);
    if (existing) {
      this.buckets.delete(key);
      this.buckets.set(key, existing);
      return existing;
    }
    this.#evictIdle(now);
    const bucket = { tokens: this.limit, refilledAt: now };
    this.buckets.set(key, bucket);
    return bucket;
  }

  #evictIdle(now) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.refilledAt < this.windowMs) break;
      this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxClients) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }
}

export function quotaExceeded(retryAfterMs) {
  return new MarketDataError(ERROR_CODES.QUOTA_EXCEEDED, "Request quota exceeded for this client", {
    retryable: true,
    details: {
      reason: "client_quota_exceeded",
      retryAfterMs,
    },
  });
}
