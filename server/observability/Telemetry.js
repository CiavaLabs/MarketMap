export class Telemetry {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.startedAt = clock();
    this.counters = new Map();
    this.durations = new Map();
  }

  increment(name, labels = {}, amount = 1) {
    if (!Number.isFinite(amount)) return;
    const key = this.#key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + amount);
  }

  observe(name, value, labels = {}) {
    if (!Number.isFinite(value)) return;
    const key = this.#key(name, labels);
    const aggregate = this.durations.get(key) || { count: 0, total: 0, min: Infinity, max: -Infinity };
    aggregate.count += 1;
    aggregate.total += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    this.durations.set(key, aggregate);
  }

  snapshot() {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Math.max(0, this.clock() - this.startedAt),
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries([...this.durations].map(([key, value]) => [key, {
        ...value,
        average: value.count ? value.total / value.count : 0,
      }])),
    };
  }

  #key(name, labels) {
    const suffix = Object.entries(labels)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(",");
    return suffix ? `${name}{${suffix}}` : name;
  }
}
