const hasPerformance =
  typeof performance === "object" && typeof performance.now === "function";

const now = () => (hasPerformance ? performance.now() : Date.now());

const DEFAULT_THRESHOLDS = {
  perSecond: [1, 3, 6, 12],
  perCall: [2, 5, 15, 30],
  total: [30, 120, 300, 600],
};

function formatNumber(value, precision = 3) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(precision));
}

function impactScoreFor(value, thresholds) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const [t1, t2, t3, t4] = thresholds;
  if (value < t1) return 2;
  if (value < t2) return 4;
  if (value < t3) return 6;
  if (value < t4) return 8;
  return 10;
}

class PerfMonitor {
  constructor(options = {}) {
    const thresholds = options.thresholds || DEFAULT_THRESHOLDS;

    this.thresholds = {
      perSecond: thresholds.perSecond || DEFAULT_THRESHOLDS.perSecond,
      perCall: thresholds.perCall || DEFAULT_THRESHOLDS.perCall,
      total: thresholds.total || DEFAULT_THRESHOLDS.total,
    };

    this.metrics = new Map();
    this.activeMarks = new Map();
    this._nextId = 1;
  }

  start(label, meta = {}) {
    if (!label) throw new Error("PerfMonitor.start: label is required");
    const id = this._nextId++;
    this.activeMarks.set(id, {
      label,
      startTime: now(),
      weight: Number.isFinite(meta.weight) ? meta.weight : 1,
    });
    return id;
  }

  end(id, weight) {
    const marker = this.activeMarks.get(id);
    if (!marker) return null;
    this.activeMarks.delete(id);

    const endTime = now();
    const duration = Math.max(0, endTime - marker.startTime);
    const appliedWeight =
      Number.isFinite(weight) && weight > 0 ? weight : marker.weight || 1;

    this.#record(marker.label, {
      duration,
      weight: appliedWeight,
      startTime: marker.startTime,
      endTime,
    });

    return duration;
  }

  report(options = {}) {
    const {
      minCount = 1,
      sortBy = "score",
      limit,
      reset = false,
      toConsole = false,
    } = options;

    const metrics = Array.from(this.metrics.values())
      .map((entry) => this.#decorate(entry))
      .filter((metric) => metric.count >= minCount);

    const sortKey = {
      score: "score",
      totalTime: "totalTime",
      perSecondTime: "perSecondTime",
      perCallTime: "averageTime",
    }[sortBy] || "score";

    metrics.sort((a, b) => b[sortKey] - a[sortKey]);

    const limited =
      Number.isInteger(limit) && limit > 0 ? metrics.slice(0, limit) : metrics;

    if (toConsole && typeof console !== "undefined") {
      const table = limited.map(
        ({
          label,
          score,
          count,
          totalTime,
          averageTime,
          perSecondTime,
          perSecondCalls,
          totalWeight,
          weightPerSecond,
          minTime,
          maxTime,
        }) => ({
          label,
          score,
          calls: count,
          "total ms": formatNumber(totalTime),
          "avg ms": formatNumber(averageTime),
          "min ms": formatNumber(minTime),
          "max ms": formatNumber(maxTime),
          "ms / sec": formatNumber(perSecondTime),
          "calls / sec": formatNumber(perSecondCalls),
          weight: formatNumber(totalWeight, 2),
          "weight / sec": formatNumber(weightPerSecond),
        }),
      );
      console.table(table);
    }

    if (reset) {
      this.reset();
    }

    return limited;
  }

  reset() {
    this.metrics.clear();
    this.activeMarks.clear();
    this._nextId = 1;
  }

  #record(label, { duration, weight, startTime, endTime }) {
    const existing = this.metrics.get(label);
    if (!existing) {
      this.metrics.set(label, {
        label,
        count: 1,
        totalTime: duration,
        minTime: duration,
        maxTime: duration,
        totalWeight: weight,
        firstStart: startTime,
        lastEnd: endTime,
      });
      return;
    }

    existing.count += 1;
    existing.totalTime += duration;
    existing.totalWeight += weight;
    existing.minTime = Math.min(existing.minTime, duration);
    existing.maxTime = Math.max(existing.maxTime, duration);
    existing.firstStart = Math.min(existing.firstStart, startTime);
    existing.lastEnd = Math.max(existing.lastEnd, endTime);
  }

  #decorate(entry) {
    const windowMs = Math.max(1, entry.lastEnd - entry.firstStart);
    const windowSeconds = windowMs / 1000;
    const { count, totalTime, totalWeight } = entry;
    const averageTime = totalTime / count;
    const perSecondTime = totalTime / windowSeconds;
    const perSecondCalls = count / windowSeconds;
    const weightPerSecond = totalWeight / windowSeconds;

    const perSecondScore = impactScoreFor(
      perSecondTime,
      this.thresholds.perSecond,
    );
    const perCallScore = impactScoreFor(averageTime, this.thresholds.perCall);
    const totalScore = impactScoreFor(totalTime, this.thresholds.total);
    const score = Math.max(perSecondScore, perCallScore, totalScore);

    return {
      label: entry.label,
      count,
      totalTime,
      averageTime,
      minTime: entry.minTime,
      maxTime: entry.maxTime,
      perSecondTime,
      perSecondCalls,
      totalWeight,
      weightPerSecond,
      windowMs,
      score,
    };
  }
}

const defaultMonitor = new PerfMonitor();

export { PerfMonitor };

export const perfMonitor = defaultMonitor;

export const perfReport = (options) => defaultMonitor.report(options);
