// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";
import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";
import { movementAnalyticsRecord } from "./fixtures/movementAnalyticsRecord.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mountApp(analyticsSnapshot, health) {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  return new AppController([STARTER_INSTRUMENTS[0]], {
    root: document.querySelector("[data-marketmap-root]"),
    client: { snapshot: vi.fn(), historyBatch: vi.fn(), analyticsSnapshot, ...(health ? { health } : {}) },
    pauseWhenHidden: false,
  });
}

function healthEnvelope(capabilities) {
  return async () => ({ data: { capabilities } });
}

describe("AppController movement analytics", () => {
  it("returns the record for the requested instrument and remembers support", async () => {
    const record = movementAnalyticsRecord();
    const analyticsSnapshot = vi.fn(async () => ({ data: [record] }));
    const app = mountApp(analyticsSnapshot);

    expect(await app.getMovementAnalytics("XNAS:AAPL")).toEqual(record);
    expect(app.analyticsSupport).toBe(true);
    expect(await app.getMovementAnalytics("XNAS:MSFT")).toBeNull();
    expect(analyticsSnapshot).toHaveBeenCalledTimes(2);
    app.destroy();
  });

  it("marks a 501 deployment as analytics-less and stops asking", async () => {
    const notImplemented = Object.assign(new Error("not implemented"), {
      code: "not_implemented",
      status: 501,
    });
    const analyticsSnapshot = vi.fn(async () => { throw notImplemented; });
    const app = mountApp(analyticsSnapshot);

    expect(await app.getMovementAnalytics("XNAS:AAPL")).toBeNull();
    expect(app.analyticsSupport).toBe(false);
    expect(await app.getMovementAnalytics("XNAS:AAPL")).toBeNull();
    expect(analyticsSnapshot).toHaveBeenCalledOnce();
    app.destroy();
  });

  it("never asks a server that does not advertise the analytics capability", async () => {
    const analyticsSnapshot = vi.fn();
    const health = vi.fn(healthEnvelope(["health", "snapshot", "details"]));
    const app = mountApp(analyticsSnapshot, health);

    expect(await app.getMovementAnalytics("XNAS:AAPL")).toBeNull();
    expect(await app.getMovementAnalytics("XNAS:MSFT")).toBeNull();
    expect(analyticsSnapshot).not.toHaveBeenCalled();
    expect(health).toHaveBeenCalledOnce();
    expect(app.analyticsSupport).toBe(false);
    app.destroy();
  });

  it("asks once a server advertises the capability, reading health only once", async () => {
    const record = movementAnalyticsRecord();
    const analyticsSnapshot = vi.fn(async () => ({ data: [record] }));
    const health = vi.fn(healthEnvelope(["analytics-snapshot", "health", "snapshot"]));
    const app = mountApp(analyticsSnapshot, health);

    expect(await app.getMovementAnalytics("XNAS:AAPL")).toEqual(record);
    expect(await app.getMovementAnalytics("XNAS:AAPL")).toEqual(record);
    expect(analyticsSnapshot).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenCalledOnce();
    app.destroy();
  });

  it("falls back to asking when health is unreachable or advertises nothing", async () => {
    const record = movementAnalyticsRecord();
    const analyticsSnapshot = vi.fn(async () => ({ data: [record] }));
    const unreachable = mountApp(analyticsSnapshot, vi.fn(async () => { throw new Error("offline"); }));
    expect(await unreachable.getMovementAnalytics("XNAS:AAPL")).toEqual(record);
    unreachable.destroy();

    const silent = mountApp(analyticsSnapshot, vi.fn(healthEnvelope(undefined)));
    expect(await silent.getMovementAnalytics("XNAS:AAPL")).toEqual(record);
    silent.destroy();

    expect(analyticsSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rethrows transient failures without disabling the capability", async () => {
    const transient = Object.assign(new Error("upstream down"), {
      code: "upstream_unavailable",
      status: 503,
    });
    const analyticsSnapshot = vi.fn(async () => { throw transient; });
    const app = mountApp(analyticsSnapshot);

    await expect(app.getMovementAnalytics("XNAS:AAPL")).rejects.toBe(transient);
    expect(app.analyticsSupport).toBeNull();

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    analyticsSnapshot.mockImplementationOnce(async () => { throw abort; });
    await expect(app.getMovementAnalytics("XNAS:AAPL")).rejects.toBe(abort);
    expect(app.analyticsSupport).toBeNull();
    app.destroy();
  });
});
