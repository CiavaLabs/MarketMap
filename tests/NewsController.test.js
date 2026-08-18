import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsController } from "../src/controllers/NewsController.js";

const AAPL = Object.freeze({ id: "XNAS:AAPL", symbol: "AAPL" });
const MSFT = Object.freeze({ id: "XNAS:MSFT", symbol: "MSFT" });

function article(instrument, overrides = {}) {
  return {
    id: `yahoo:${instrument.symbol.toLowerCase()}-story`,
    title: `${instrument.symbol} market coverage`,
    publisher: "Reuters",
    url: `https://news.example/${instrument.symbol.toLowerCase()}`,
    publishedAt: "2026-07-15T16:10:00.000Z",
    instrumentIds: [instrument.id],
    provider: "yahoo",
    ...overrides,
  };
}

function envelope(instrument, overrides = {}) {
  return {
    data: { articles: [article(instrument)] },
    errors: [],
    sources: { news: ["yahoo"] },
    meta: {
      generatedAt: "2026-07-15T16:15:00.000Z",
      nextRefreshAt: null,
    },
    ...overrides,
  };
}

function deferredRequests() {
  const requests = [];
  const implementation = vi.fn((ids, options) => new Promise((resolve, reject) => {
    requests.push({ ids, options, resolve, reject });
  }));
  return { implementation, requests };
}

function fakeView() {
  return { render: vi.fn(), setInstruments: vi.fn() };
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("NewsController", () => {
  it("requests only instruments with an applicable news capability", async () => {
    const eligible = {
      ...AAPL,
      assetClass: "equity",
      capabilities: { news: { status: "supported" } },
    };
    const etf = {
      id: "ARCX:SPY",
      symbol: "SPY",
      assetClass: "etf",
      capabilities: { news: { status: "supported" } },
    };
    const fx = {
      id: "FX:EURUSD",
      symbol: "EURUSD",
      assetClass: "fx",
      capabilities: { news: { status: "unsupported" } },
    };
    const app = { getNewsBatch: vi.fn(async () => envelope(AAPL)) };
    const view = fakeView();
    const controller = new NewsController(app, [eligible, etf, fx], {
      view,
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });

    await controller.start();

    expect(app.getNewsBatch.mock.calls[0][0]).toEqual([AAPL.id]);
    expect(view.setInstruments).toHaveBeenLastCalledWith([eligible]);
    controller.destroy();
  });

  it("loads progressively, preserves partial errors and exposes serializable state", async () => {
    const view = fakeView();
    const response = envelope(AAPL, {
      errors: [{
        instrumentId: MSFT.id,
        code: "provider_unavailable",
        message: "Unavailable",
        retryable: true,
      }],
      sources: { news: ["yahoo", "last-known-good"] },
      meta: {
        generatedAt: "2026-07-15T16:15:00.000Z",
        lastUpdatedAt: "2026-07-15T16:00:00.000Z",
        nextRefreshAt: "2026-07-15T16:30:00.000Z",
      },
    });
    const app = { getNewsBatch: vi.fn(async () => response) };
    const controller = new NewsController(app, [AAPL, MSFT], {
      view,
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });

    await controller.start();

    expect(app.getNewsBatch).toHaveBeenCalledWith([AAPL.id, MSFT.id], {
      limit: 12,
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    });
    expect(view.render.mock.calls.some(([state]) => state.status === "loading")).toBe(true);
    expect(controller.getState()).toEqual({
      status: "ready",
      articles: [article(AAPL)],
      errors: [expect.objectContaining({ instrumentId: MSFT.id })],
      sources: ["yahoo", "last-known-good"],
      quality: "stale",
      lastUpdatedAt: "2026-07-15T16:00:00.000Z",
      nextRefreshAt: "2026-07-15T16:30:00.000Z",
      error: null,
    });
    expect(() => JSON.stringify(controller.getState())).not.toThrow();
    controller.destroy();
  });

  it("chunks a 60-equity news cohort without exceeding the transport batch limit", async () => {
    const instruments = Array.from({ length: 60 }, (_, index) => ({
      id: `XNAS:T${index}`,
      symbol: `T${index}`,
    }));
    const app = {
      getNewsBatch: vi.fn(async (ids) => ({
        data: {
          articles: [{
            id: `yahoo:${ids[0]}`,
            title: `Coverage for ${ids[0]}`,
            publisher: "Reuters",
            url: `https://news.example/${ids[0]}`,
            publishedAt: "2026-07-15T16:10:00.000Z",
            instrumentIds: [ids[0]],
            provider: "yahoo",
          }],
        },
        sources: { news: ["yahoo"] },
        meta: { generatedAt: "2026-07-15T16:15:00.000Z", nextRefreshAt: null },
      })),
    };
    const controller = new NewsController(app, instruments, {
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });

    await controller.start();

    expect(app.getNewsBatch.mock.calls.map(([ids]) => ids.length)).toEqual([40, 20]);
    expect(controller.getState()).toMatchObject({
      status: "ready",
      articles: [
        expect.objectContaining({ id: "yahoo:XNAS:T0" }),
        expect.objectContaining({ id: "yahoo:XNAS:T40" }),
      ],
      sources: ["yahoo"],
    });
    controller.destroy();
  });

  it("never presents response-generation time as stale coverage confirmation", async () => {
    const staleWithoutConfirmation = envelope(AAPL, {
      sources: { news: ["last-known-good"] },
      meta: {
        generatedAt: "2026-07-15T17:00:00.000Z",
        nextRefreshAt: "2026-07-15T17:01:00.000Z",
      },
    });
    const controller = new NewsController({
      getNewsBatch: vi.fn(async () => staleWithoutConfirmation),
    }, [AAPL], { refreshPolicy: "manual", pauseWhenHidden: false });

    await controller.start();

    expect(controller.getState()).toMatchObject({
      status: "ready",
      quality: "stale",
      lastUpdatedAt: null,
      nextRefreshAt: "2026-07-15T17:01:00.000Z",
    });
    controller.destroy();
  });

  it("aborts a superseded request and explicitly reloads the latest instrument set after settle", async () => {
    const pending = deferredRequests();
    const view = fakeView();
    const controller = new NewsController({ getNewsBatch: pending.implementation }, [AAPL], {
      view,
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });

    const initial = controller.start();
    await flushMicrotasks();
    expect(pending.requests).toHaveLength(1);
    expect(pending.requests[0].ids).toEqual([AAPL.id]);

    controller.setInstruments([MSFT]);
    expect(pending.requests[0].options.signal.aborted).toBe(true);
    pending.requests[0].resolve(envelope(AAPL));
    await initial;
    await flushMicrotasks();

    expect(pending.requests).toHaveLength(2);
    expect(pending.requests[1].ids).toEqual([MSFT.id]);
    expect(controller.getState().articles).toEqual([]);
    pending.requests[1].resolve(envelope(MSFT));
    await flushMicrotasks();

    expect(controller.getState()).toMatchObject({
      status: "ready",
      articles: [expect.objectContaining({ id: "yahoo:msft-story" })],
    });
    controller.destroy();
  });

  it("does not reload for an ordering-only change and cancels cleanly for an empty board", async () => {
    const pending = deferredRequests();
    const view = fakeView();
    const controller = new NewsController({ getNewsBatch: pending.implementation }, [AAPL, MSFT], {
      view,
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });
    const initial = controller.start();
    await flushMicrotasks();

    expect(controller.setInstruments([MSFT, AAPL])).toBe(false);
    expect(pending.requests).toHaveLength(1);
    expect(controller.setInstruments([])).toBe(true);
    expect(pending.requests[0].options.signal.aborted).toBe(true);
    pending.requests[0].resolve(envelope(AAPL));
    await initial;
    await flushMicrotasks();

    expect(pending.requests).toHaveLength(1);
    expect(controller.getState()).toMatchObject({
      status: "empty",
      articles: [],
      nextRefreshAt: null,
    });
    expect(view.setInstruments).toHaveBeenLastCalledWith([]);
    controller.destroy();
  });

  it("schedules from server nextRefreshAt, pauses, resumes once, and cleans every timer", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-07-15T16:00:00.000Z");
    const nextRefreshAt = "2026-07-15T16:15:00.000Z";
    const app = {
      getNewsBatch: vi.fn(async () => envelope(AAPL, {
        meta: { generatedAt: new Date(now).toISOString(), nextRefreshAt },
      })),
    };
    const controller = new NewsController(app, [AAPL], {
      refreshPolicy: "automatic",
      pauseWhenHidden: false,
      clock: () => now,
      minimumRefreshMs: 1_000,
    });

    await controller.start();
    expect(app.getNewsBatch).toHaveBeenCalledTimes(1);
    controller.pause("host");
    now += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(app.getNewsBatch).toHaveBeenCalledTimes(1);

    controller.resume("host");
    await flushMicrotasks();
    expect(app.getNewsBatch).toHaveBeenCalledTimes(2);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders total transport and per-instrument failures as a local retryable error", async () => {
    const networkError = Object.assign(new Error("Offline"), {
      code: "network_error",
      retryable: true,
    });
    const failed = new NewsController({
      getNewsBatch: vi.fn(async () => { throw networkError; }),
    }, [AAPL], {
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });
    await expect(failed.start()).rejects.toBe(networkError);
    expect(failed.getState()).toMatchObject({
      status: "error",
      error: { code: "network_error", message: "Offline", retryable: true },
    });
    failed.destroy();

    const partialEnvelope = envelope(AAPL, {
      data: { articles: [] },
      errors: [{ instrumentId: AAPL.id, message: "No provider", retryable: true }],
    });
    const total = new NewsController({
      getNewsBatch: vi.fn(async () => partialEnvelope),
    }, [AAPL], { refreshPolicy: "manual", pauseWhenHidden: false });
    await total.start();
    expect(total.getState()).toMatchObject({ status: "error", articles: [] });
    total.destroy();
  });
});
