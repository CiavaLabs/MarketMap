import { describe, expect, it, vi } from "vitest";
import { RefreshCoordinator } from "../src/core/RefreshCoordinator.js";

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function createTimeHarness(initialNow) {
  let now = initialNow;
  let nextId = 1;
  const jobs = new Map();
  const timer = {
    setTimeout: vi.fn((callback, delay) => {
      const id = nextId++;
      jobs.set(id, { callback, delay, at: now + delay });
      return id;
    }),
    clearTimeout: vi.fn((id) => jobs.delete(id)),
  };

  return {
    clock: { now: () => now },
    timer,
    get pendingCount() {
      return jobs.size;
    },
    nextJob() {
      return [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0] || null;
    },
    async runNext() {
      const entry = this.nextJob();
      if (!entry) return null;
      const [id, job] = entry;
      jobs.delete(id);
      now = job.at;
      return job.callback();
    },
  };
}

describe("RefreshCoordinator", () => {
  it("keeps a refresh successful when its nextRefreshAt hint is malformed", async () => {
    const time = createTimeHarness(Date.parse("2026-07-13T20:00:00.000Z"));
    const refresh = vi.fn(() => Promise.resolve({
      data: [],
      meta: { nextRefreshAt: "not-a-timestamp" },
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
      minimumRefreshMs: 1_000,
    });

    await expect(coordinator.start()).resolves.toMatchObject({ data: [] });

    const state = coordinator.getState();
    expect(state.lastError).toBeNull();
    expect(state.failureCount).toBe(0);
    expect(state.nextRefreshAt).toBeNull();
    expect(time.pendingCount).toBe(0);
    coordinator.destroy();
  });

  it("uses meta.nextRefreshAt as the automatic refresh schedule", async () => {
    const time = createTimeHarness(Date.parse("2026-07-13T20:00:00.000Z"));
    const refresh = vi.fn(({ reason }) => Promise.resolve({
      data: [],
      meta: {
        nextRefreshAt: iso(time.clock.now() + (reason === "initial" ? 5_000 : 10_000)),
      },
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
      minimumRefreshMs: 1_000,
    });

    await coordinator.start();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({ reason: "initial" });
    expect(refresh.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(time.nextJob()[1].delay).toBe(5_000);

    await time.runNext();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0].reason).toBe("automatic");
    expect(time.nextJob()[1].delay).toBe(10_000);
    coordinator.destroy();
    expect(time.pendingCount).toBe(0);
  });

  it("loads once in manual mode and coalesces concurrent refresh requests", async () => {
    const time = createTimeHarness(1_000);
    let resolveRefresh;
    const refreshResult = { data: [], meta: {} };
    const refresh = vi.fn(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      refreshPolicy: "manual",
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
    });

    const initial = coordinator.start();
    const coalesced = coordinator.refreshNow();

    expect(coalesced).toBe(initial);
    expect(refresh).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh(refreshResult);
    await expect(initial).resolves.toBe(refreshResult);
    await expect(coalesced).resolves.toBe(refreshResult);
    expect(time.pendingCount).toBe(0);
    expect(coordinator.getState().refreshPolicy).toBe("manual");
    coordinator.destroy();
  });

  it("pauses while hidden and performs one deferred refresh on resume", async () => {
    const time = createTimeHarness(10_000);
    const visibilityTarget = new EventTarget();
    Object.defineProperty(visibilityTarget, "hidden", {
      configurable: true,
      writable: true,
      value: false,
    });
    const refresh = vi.fn(() => Promise.resolve({
      data: [],
      meta: { nextRefreshAt: iso(time.clock.now() + 5_000) },
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget,
    });

    await coordinator.start();
    expect(time.pendingCount).toBe(1);

    visibilityTarget.hidden = true;
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(coordinator.getState()).toMatchObject({ paused: true });
    expect(time.pendingCount).toBe(0);

    await expect(coordinator.refreshNow()).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);

    visibilityTarget.hidden = false;
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    if (coordinator.inFlight) await coordinator.inFlight;

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0].reason).toBe("manual");
    expect(coordinator.getState().paused).toBe(false);
    expect(time.pendingCount).toBe(1);
    coordinator.destroy();
  });

  it("honors host flags for controls, manual refresh, and visibility", async () => {
    const time = createTimeHarness(5_000);
    const visibilityTarget = new EventTarget();
    Object.defineProperty(visibilityTarget, "hidden", { value: true, writable: true });
    const refresh = vi.fn(() => Promise.resolve({ data: [], meta: {} }));
    const coordinator = new RefreshCoordinator({
      refresh,
      refreshPolicy: "manual",
      allowRefreshControl: false,
      allowManualRefresh: false,
      pauseWhenHidden: false,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget,
    });

    await coordinator.start();
    await expect(coordinator.refreshNow()).resolves.toBeNull();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(coordinator.setAutoRefreshEnabled(true)).toBe(false);
    expect(coordinator.setVisibility(true)).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      refreshPolicy: "manual",
      allowRefreshControl: false,
      allowManualRefresh: false,
      pauseWhenHidden: false,
      paused: false,
    });
    coordinator.destroy();
  });

  it("retries automatic refresh failures using Retry-After", async () => {
    const time = createTimeHarness(10_000);
    const rateLimit = Object.assign(new Error("slow down"), { retryAfterMs: 12_000 });
    const refresh = vi.fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({ data: [], meta: { nextRefreshAt: iso(40_000) } });
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
      minimumRefreshMs: 1_000,
    });

    await expect(coordinator.start()).rejects.toBe(rateLimit);
    expect(coordinator.getState()).toMatchObject({ failureCount: 1 });
    expect(time.nextJob()[1].delay).toBe(12_000);

    await time.runNext();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({ failureCount: 0, lastError: null });
    coordinator.destroy();
  });

  it("backs off and keeps automatic mode recoverable after network errors", async () => {
    const time = createTimeHarness(0);
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
      minimumRefreshMs: 2_000,
      maximumRetryMs: 10_000,
    });

    await expect(coordinator.start()).rejects.toThrow("offline");
    expect(time.nextJob()[1].delay).toBe(2_000);
    await expect(time.runNext()).resolves.toBeNull();
    expect(time.nextJob()[1].delay).toBe(4_000);
    coordinator.destroy();
  });

  it("aborts an in-flight refresh when destroyed", async () => {
    const time = createTimeHarness(0);
    const refresh = vi.fn(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
    });

    const initial = coordinator.start();
    await Promise.resolve();
    expect(coordinator.destroy()).toBe(true);

    await expect(initial).rejects.toMatchObject({ name: "AbortError" });
    expect(refresh.mock.calls[0][0].signal.aborted).toBe(true);
    expect(coordinator.destroy()).toBe(false);
  });

  it("does not turn teardown aborts into failed retry state", async () => {
    const time = createTimeHarness(0);
    const refresh = vi.fn(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const coordinator = new RefreshCoordinator({
      refresh,
      clock: time.clock,
      timer: time.timer,
      visibilityTarget: null,
    });

    const initial = coordinator.start();
    await Promise.resolve();
    coordinator.destroy();
    expect(coordinator.getState()).toMatchObject({ destroyed: true, refreshing: false });

    await expect(initial).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.getState()).toMatchObject({
      destroyed: true,
      refreshing: false,
      failureCount: 0,
      lastError: null,
      nextRefreshAt: null,
    });
    expect(time.pendingCount).toBe(0);
  });
});
