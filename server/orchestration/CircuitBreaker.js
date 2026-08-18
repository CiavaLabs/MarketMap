import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";

export const CIRCUIT_STATES = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half-open",
});

function positiveNumber(value, label, { allowZero = false } = {}) {
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) throw new TypeError(`${label} must be a finite ${allowZero ? "non-negative" : "positive"} number`);
  return value;
}

export class CircuitBreaker {
  constructor({
    failureThreshold = 5,
    cooldownMs = 30_000,
    maxCooldownMs = 300_000,
    backoffMultiplier = 2,
    clock = () => Date.now(),
    shouldCountFailure = () => true,
    jitter = (duration) => duration,
    onStateChange = () => {},
    name = "market-data",
  } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new TypeError("failureThreshold must be a positive integer");
    }
    positiveNumber(cooldownMs, "cooldownMs", { allowZero: true });
    positiveNumber(maxCooldownMs, "maxCooldownMs", { allowZero: true });
    positiveNumber(backoffMultiplier, "backoffMultiplier");
    if (maxCooldownMs < cooldownMs) throw new RangeError("maxCooldownMs must be at least cooldownMs");
    for (const [label, candidate] of Object.entries({ clock, shouldCountFailure, jitter, onStateChange })) {
      if (typeof candidate !== "function") throw new TypeError(`${label} must be a function`);
    }

    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.backoffMultiplier = backoffMultiplier;
    this.clock = clock;
    this.shouldCountFailure = shouldCountFailure;
    this.jitter = jitter;
    this.onStateChange = onStateChange;
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.openCount = 0;
    this.openedAt = null;
    this.retryAt = null;
    this.probeInFlight = false;
  }

  get isOpen() {
    this.#refreshState();
    return this.state === CIRCUIT_STATES.OPEN;
  }

  canRequest() {
    this.#refreshState();
    return this.state === CIRCUIT_STATES.CLOSED
      || (this.state === CIRCUIT_STATES.HALF_OPEN && !this.probeInFlight);
  }

  snapshot() {
    this.#refreshState();
    const now = this.clock();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      openCount: this.openCount,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      retryAfterMs: this.retryAt === null ? 0 : Math.max(0, this.retryAt - now),
      probeInFlight: this.probeInFlight,
    };
  }

  async execute(operation) {
    if (typeof operation !== "function") throw new TypeError("Circuit operation must be a function");
    const probe = this.#admit();

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.shouldCountFailure(error)) {
        this.recordFailure();
      } else {
        if (probe) this.probeInFlight = false;
      }
      throw error;
    }
  }

  recordSuccess() {
    const previous = this.state;
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.openCount = 0;
    this.openedAt = null;
    this.retryAt = null;
    this.probeInFlight = false;
    this.#notify(previous);
  }

  recordFailure() {
    this.#refreshState();
    this.probeInFlight = false;
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.#open();
      return;
    }
    if (this.state === CIRCUIT_STATES.OPEN) return;

    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) this.#open();
  }

  reset() {
    this.recordSuccess();
  }

  #admit() {
    this.#refreshState();
    if (this.state === CIRCUIT_STATES.OPEN) throw this.#openError();
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      if (this.probeInFlight) throw this.#openError();
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  #open() {
    const previous = this.state;
    this.state = CIRCUIT_STATES.OPEN;
    this.failureCount = this.failureThreshold;
    this.openCount += 1;
    this.openedAt = this.clock();
    const baseDuration = Math.min(
      this.maxCooldownMs,
      this.cooldownMs * (this.backoffMultiplier ** (this.openCount - 1)),
    );
    const jitteredDuration = this.jitter(baseDuration, this.openCount);
    positiveNumber(jitteredDuration, "jitter result", { allowZero: true });
    this.retryAt = this.openedAt + Math.min(this.maxCooldownMs, jitteredDuration);
    this.probeInFlight = false;
    this.#notify(previous);
  }

  #refreshState() {
    if (this.state !== CIRCUIT_STATES.OPEN || this.clock() < this.retryAt) return;
    const previous = this.state;
    this.state = CIRCUIT_STATES.HALF_OPEN;
    this.probeInFlight = false;
    this.#notify(previous);
  }

  #notify(previous) {
    if (previous !== this.state) this.onStateChange(this.state, previous, this.snapshotWithoutRefresh());
  }

  snapshotWithoutRefresh() {
    const now = this.clock();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      openCount: this.openCount,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      retryAfterMs: this.retryAt === null ? 0 : Math.max(0, this.retryAt - now),
      probeInFlight: this.probeInFlight,
    };
  }

  #openError() {
    const snapshot = this.snapshotWithoutRefresh();
    return new MarketDataError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      `Circuit breaker ${this.name} is ${this.state}`,
      {
        retryable: true,
        details: {
          reason: "circuit_open",
          state: this.state,
          retryAfterMs: snapshot.retryAfterMs,
        },
      },
    );
  }
}
