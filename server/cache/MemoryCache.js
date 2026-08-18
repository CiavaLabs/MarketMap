const identity = (value) => value;

function assertKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Cache key must be a non-empty string");
  }
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export class MemoryCache {
  constructor({ clock = () => Date.now(), maxEntries = 1_000, clone = identity } = {}) {
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof clone !== "function") throw new TypeError("clone must be a function");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }

    this.clock = clock;
    this.maxEntries = maxEntries;
    this.clone = clone;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  set(key, value, options = {}) {
    assertKey(key);
    const now = options.now ?? this.clock();
    finiteNonNegative(now, "now");

    const freshTtlMs = finiteNonNegative(
      options.freshTtlMs ?? options.ttlMs ?? 0,
      "freshTtlMs",
    );
    const staleTtlMs = finiteNonNegative(
      options.staleTtlMs ?? freshTtlMs,
      "staleTtlMs",
    );
    if (staleTtlMs < freshTtlMs) {
      throw new RangeError("staleTtlMs must be greater than or equal to freshTtlMs");
    }

    const entry = {
      value: this.clone(value),
      storedAt: now,
      freshUntil: now + freshTtlMs,
      staleUntil: now + staleTtlMs,
    };

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.#evictOverflow();
    return this.#present(entry, now);
  }

  read(key, { allowStale = true, now = this.clock(), touch = true } = {}) {
    assertKey(key);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (now > entry.staleUntil) {
      this.entries.delete(key);
      return null;
    }

    const state = now < entry.freshUntil ? "fresh" : "stale";
    if (state === "stale" && !allowStale) return null;

    if (touch) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return this.#present(entry, now, state);
  }

  peek(key, options = {}) {
    return this.read(key, { ...options, touch: false });
  }

  get(key, options = {}) {
    return this.read(key, options)?.value ?? null;
  }

  has(key, options = {}) {
    return this.read(key, { ...options, touch: false }) !== null;
  }

  delete(key) {
    assertKey(key);
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  prune({ now = this.clock() } = {}) {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now > entry.staleUntil) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  #present(entry, now, knownState) {
    return {
      value: this.clone(entry.value),
      state: knownState || (now < entry.freshUntil ? "fresh" : "stale"),
      ageMs: Math.max(0, now - entry.storedAt),
      storedAt: entry.storedAt,
      freshUntil: entry.freshUntil,
      staleUntil: entry.staleUntil,
    };
  }

  #evictOverflow() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}
