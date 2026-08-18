import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PerfMonitor, perfMonitor, perfReport } from "../src/utils/PerfMonitor.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  perfMonitor.reset();
});

function sample(monitor, label, { duration, gap = 0, weight } = {}) {
  vi.advanceTimersByTime(gap);
  const id = monitor.start(label, weight === undefined ? {} : { weight });
  vi.advanceTimersByTime(duration);
  return monitor.end(id);
}

describe("PerfMonitor marks", () => {
  it("times a mark from start to end", () => {
    const monitor = new PerfMonitor();
    expect(sample(monitor, "render", { duration: 7 })).toBe(7);
    expect(monitor.report()[0]).toMatchObject({ label: "render", count: 1, totalTime: 7 });
  });

  it("requires a label", () => {
    const monitor = new PerfMonitor();
    expect(() => monitor.start("")).toThrowError(/label is required/u);
    expect(() => monitor.start()).toThrowError(/label is required/u);
  });

  it("hands out a distinct id per mark and ignores an unknown one", () => {
    const monitor = new PerfMonitor();
    const first = monitor.start("a");
    const second = monitor.start("b");
    expect(second).not.toBe(first);
    expect(monitor.end(9_999)).toBeNull();
    expect(monitor.end(undefined)).toBeNull();
  });

  it("refuses to end the same mark twice", () => {
    const monitor = new PerfMonitor();
    const id = monitor.start("once");
    vi.advanceTimersByTime(3);
    expect(monitor.end(id)).toBe(3);
    expect(monitor.end(id)).toBeNull();
  });

  it("never reports a negative duration", () => {
    const monitor = new PerfMonitor();
    expect(sample(monitor, "instant", { duration: 0 })).toBe(0);
  });
});

describe("PerfMonitor weights", () => {
  it("defaults a mark to a weight of one", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "plain", { duration: 1 });
    expect(monitor.report()[0].totalWeight).toBe(1);
  });

  it("takes the weight declared at start", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "batch", { duration: 1, weight: 4 });
    expect(monitor.report()[0].totalWeight).toBe(4);
  });

  it("ignores a non-finite weight at start", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "batch", { duration: 1, weight: Number.NaN });
    expect(monitor.report()[0].totalWeight).toBe(1);
  });

  it("lets the weight at end override the one from start", () => {
    const monitor = new PerfMonitor();
    const id = monitor.start("batch", { weight: 2 });
    vi.advanceTimersByTime(1);
    monitor.end(id, 10);
    expect(monitor.report()[0].totalWeight).toBe(10);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-finite", Number.POSITIVE_INFINITY],
  ])("keeps the start weight when the end weight is %s", (_label, weight) => {
    const monitor = new PerfMonitor();
    const id = monitor.start("batch", { weight: 3 });
    vi.advanceTimersByTime(1);
    monitor.end(id, weight);
    expect(monitor.report()[0].totalWeight).toBe(3);
  });
});

describe("PerfMonitor aggregation", () => {
  it("accumulates repeated marks under one label", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "tick", { duration: 4 });
    sample(monitor, "tick", { duration: 10, gap: 100 });
    sample(monitor, "tick", { duration: 1, gap: 100 });

    expect(monitor.report()[0]).toMatchObject({
      label: "tick",
      count: 3,
      totalTime: 15,
      minTime: 1,
      maxTime: 10,
      averageTime: 5,
      totalWeight: 3,
    });
  });

  it("spans the window from the first start to the last end", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "tick", { duration: 10 });
    sample(monitor, "tick", { duration: 10, gap: 980 });
    const [metric] = monitor.report();

    expect(metric.windowMs).toBe(1_000);
    expect(metric.perSecondTime).toBe(20);
    expect(metric.perSecondCalls).toBe(2);
    expect(metric.weightPerSecond).toBe(2);
  });

  it("keeps a zero-length window at one millisecond", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "instant", { duration: 0 });
    expect(monitor.report()[0].windowMs).toBe(1);
  });

  it("tracks each label separately", () => {
    const monitor = new PerfMonitor();
    sample(monitor, "a", { duration: 5 });
    sample(monitor, "b", { duration: 1 });
    expect(monitor.report().map((metric) => metric.label).sort()).toEqual(["a", "b"]);
  });
});

describe("PerfMonitor scoring", () => {
  const scoreFor = (durations, spanMs, thresholds) => {
    const monitor = new PerfMonitor(thresholds ? { thresholds } : {});
    durations.forEach((duration, index) => {
      sample(monitor, "work", { duration, gap: index === 0 ? 0 : spanMs });
    });
    return monitor.report()[0].score;
  };

  it.each([
    ["under the first threshold", 0.5, 2],
    ["under the second", 2, 4],
    ["under the third", 4, 6],
    ["under the fourth", 8, 8],
    ["above every threshold", 40, 10],
  ])("scores a per-second load %s as %s", (_label, msPerSecond, expected) => {
    const monitor = new PerfMonitor({
      thresholds: { perCall: [1e9, 1e9, 1e9, 1e9], total: [1e9, 1e9, 1e9, 1e9] },
    });
    sample(monitor, "work", { duration: msPerSecond });
    vi.advanceTimersByTime(1_000 - msPerSecond);
    const id = monitor.start("work");
    monitor.end(id);
    expect(monitor.report()[0].score).toBe(expected);
  });

  it("scores an idle label at the floor", () => {
    expect(scoreFor([0], 0)).toBe(1);
  });

  it("takes the worst of the per-second, per-call and total scores", () => {
    const monitor = new PerfMonitor({
      thresholds: { perSecond: [1e9, 1e9, 1e9, 1e9], perCall: [1e9, 1e9, 1e9, 1e9], total: [1, 2, 3, 4] },
    });
    sample(monitor, "work", { duration: 10 });
    expect(monitor.report()[0].score).toBe(10);
  });

  it("falls back to the default thresholds for the ones not supplied", () => {
    const monitor = new PerfMonitor({ thresholds: { perCall: [100, 200, 300, 400] } });
    expect(monitor.thresholds).toMatchObject({
      perSecond: [1, 3, 6, 12],
      perCall: [100, 200, 300, 400],
      total: [30, 120, 300, 600],
    });
  });

  it("falls back to the defaults when no thresholds are supplied at all", () => {
    expect(new PerfMonitor().thresholds).toMatchObject({ perSecond: [1, 3, 6, 12] });
    expect(new PerfMonitor({ thresholds: null }).thresholds).toMatchObject({ perCall: [2, 5, 15, 30] });
  });
});

describe("PerfMonitor reporting", () => {
  const populated = () => {
    const monitor = new PerfMonitor();
    sample(monitor, "slow", { duration: 50 });
    sample(monitor, "medium", { duration: 20, gap: 500 });
    sample(monitor, "medium", { duration: 20, gap: 500 });
    sample(monitor, "fast", { duration: 1, gap: 500 });
    return monitor;
  };

  it("drops labels below the requested call count", () => {
    const labels = populated().report({ minCount: 2 }).map((metric) => metric.label);
    expect(labels).toEqual(["medium"]);
  });

  it("returns nothing when no label meets the threshold", () => {
    expect(populated().report({ minCount: 99 })).toEqual([]);
  });

  it.each([
    ["totalTime", "totalTime"],
    ["perSecondTime", "perSecondTime"],
    ["perCallTime", "averageTime"],
  ])("sorts by %s descending", (sortBy, key) => {
    const metrics = populated().report({ sortBy });
    const values = metrics.map((metric) => metric[key]);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("sorts by score when the requested key is unknown", () => {
    const metrics = populated().report({ sortBy: "nonsense" });
    const scores = metrics.map((metric) => metric.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it.each([
    ["a positive limit", 2, 2],
    ["a zero limit", 0, 3],
    ["a fractional limit", 1.5, 3],
    ["no limit", undefined, 3],
  ])("applies %s", (_label, limit, expected) => {
    expect(populated().report({ limit })).toHaveLength(expected);
  });

  it("clears the metrics when asked to reset", () => {
    const monitor = populated();
    expect(monitor.report({ reset: true })).toHaveLength(3);
    expect(monitor.report()).toEqual([]);
  });

  it("leaves the metrics in place otherwise", () => {
    const monitor = populated();
    monitor.report();
    expect(monitor.report()).toHaveLength(3);
  });

  it("prints a table only when asked to", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    const monitor = populated();
    monitor.report();
    expect(table).not.toHaveBeenCalled();

    monitor.report({ toConsole: true, limit: 1 });
    expect(table).toHaveBeenCalledTimes(1);
    expect(table.mock.calls[0][0]).toEqual([
      expect.objectContaining({ label: "slow", calls: 1, "total ms": 50 }),
    ]);
    table.mockRestore();
  });

  it("rounds the printed numbers and reports a non-finite one as zero", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    const monitor = new PerfMonitor();
    sample(monitor, "tick", { duration: 1 });
    monitor.report({ toConsole: true });
    const row = table.mock.calls[0][0][0];
    expect(Number.isFinite(row["ms / sec"])).toBe(true);
    expect(row.weight).toBe(1);
    table.mockRestore();
  });

  it("forgets in-flight marks on reset", () => {
    const monitor = new PerfMonitor();
    const id = monitor.start("dangling");
    monitor.reset();
    expect(monitor.end(id)).toBeNull();
    expect(monitor.start("fresh")).toBe(1);
  });
});

describe("the shared monitor", () => {
  it("reports through the module-level helper", () => {
    sample(perfMonitor, "shared", { duration: 3 });
    expect(perfReport()[0]).toMatchObject({ label: "shared", count: 1 });
    expect(perfReport({ limit: 1 })).toHaveLength(1);
  });
});
