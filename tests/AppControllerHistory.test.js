// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";
import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AppController tile history", () => {
  it("starts sparkline history without waiting for the initial quote snapshot", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    let resolveSnapshot;
    const snapshot = vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    const historyBatch = vi.fn(async (ids) => ({
      data: ids.map((instrumentId) => ({
        instrumentId,
        bars: [{ close: 100 }, { close: 101 }],
      })),
      meta: { nextRefreshAt: null },
    }));
    const app = new AppController([instrument], {
      root,
      client: { snapshot, historyBatch },
      pauseWhenHidden: false,
    });

    const ready = app.init();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledOnce());
    expect(snapshot).toHaveBeenCalledOnce();
    expect(app.tileRegistry.getHistorySeries(instrument.id)).toEqual([100, 101]);

    resolveSnapshot({ data: [], errors: [], meta: { generatedAt: "2026-07-19T17:00:00.000Z", nextRefreshAt: null } });
    await ready;
    app.destroy();
  });

  it("keeps a fast history request alive during same-board descriptor hydration", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    let resolveHistory;
    const historyBatch = vi.fn((ids, options) => new Promise((resolve) => {
      resolveHistory = () => resolve({
        data: ids.map((instrumentId) => ({ instrumentId, bars: [{ close: 100 }, { close: 101 }] })),
        meta: { nextRefreshAt: null },
      });
      expect(options.signal.aborted).toBe(false);
    }));
    const app = new AppController([instrument], {
      root,
      client: {
        snapshot: vi.fn(async () => ({ data: [], errors: [], meta: { generatedAt: "2026-07-19T17:00:00.000Z", nextRefreshAt: null } })),
        historyBatch,
      },
      pauseWhenHidden: false,
    });

    await app.init();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledOnce());
    const signal = historyBatch.mock.calls[0][1].signal;
    app.applyExternalAssets([{ ...instrument, name: `${instrument.name} hydrated` }], { refresh: false });
    expect(signal.aborted).toBe(false);
    resolveHistory();
    await vi.waitFor(() => expect(app.tileRegistry.getHistorySeries(instrument.id)).toEqual([100, 101]));
    app.destroy();
  });

  it("rejects a duplicate external board update without mutating the live board", () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    const app = new AppController([instrument], {
      root,
      client: { snapshot: vi.fn(async () => ({ data: [], errors: [], meta: {} })) },
      pauseWhenHidden: false,
    });

    expect(() => app.applyExternalAssets([
      instrument,
      { ...instrument, name: "Duplicate Apple" },
    ], { refresh: false })).toThrow("Duplicate canonical instrument id in board update");
    expect(app.assets).toEqual([instrument]);
    expect([...app.state.getAllTiles().keys()]).toEqual([instrument.id]);

    app.destroy();
  });

  it("rejects a non-canonical external board update without mutating the live board", () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    const app = new AppController([instrument], {
      root,
      client: { snapshot: vi.fn(async () => ({ data: [], errors: [], meta: {} })) },
      pauseWhenHidden: false,
    });

    expect(() => app.applyExternalAssets([
      { ...instrument, id: instrument.id.toLowerCase() },
    ], { refresh: false })).toThrow("Board instruments require canonical id and symbol");
    expect(app.assets).toEqual([instrument]);
    expect([...app.state.getAllTiles().keys()]).toEqual([instrument.id]);

    app.destroy();
  });

  it("preserves the real provider name when a refresh falls back to existing data", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    const client = {
      snapshot: vi.fn(async () => { throw new Error("offline"); }),
    };
    const app = new AppController([instrument], { root, client, pauseWhenHidden: false });
    app.state.applyQuoteSnapshot({
      instrumentId: instrument.id,
      price: 200,
      change: 2,
      changePercent: 1,
      open: 198,
      previousClose: 198,
      dayHigh: 201,
      dayLow: 197,
      bid: 199.99,
      ask: 200.01,
      volume: 1_000_000,
      averageVolume3m: 1_200_000,
      marketState: "regular",
      asOf: "2026-07-15T14:30:00.000Z",
      fetchedAt: "2026-07-15T14:30:01.000Z",
      currency: "USD",
      quality: "fresh",
      source: "yahoo",
    });

    await expect(app.refreshSnapshot()).rejects.toThrow("offline");
    expect(app.state.getTile(instrument.id)).toMatchObject({
      quality: "stale",
      source: "yahoo",
      price: 200,
    });
    app.destroy();
  });

  it("routes a total item-level snapshot outage through stale fallback and automatic retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T17:00:00.000Z"));
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    const freshQuote = {
      instrumentId: instrument.id,
      price: 200,
      change: 2,
      changePercent: 1,
      open: 198,
      previousClose: 198,
      dayHigh: 201,
      dayLow: 197,
      bid: 199.99,
      ask: 200.01,
      volume: 1_000_000,
      averageVolume3m: 1_200_000,
      marketState: "regular",
      asOf: "2026-07-19T16:59:00.000Z",
      fetchedAt: "2026-07-19T16:59:01.000Z",
      currency: "USD",
      quality: "fresh",
      source: "yahoo",
    };
    const snapshot = vi.fn()
      .mockResolvedValueOnce({
        data: [freshQuote],
        errors: [],
        meta: { generatedAt: freshQuote.fetchedAt, nextRefreshAt: null },
      })
      .mockResolvedValueOnce({
        data: [],
        errors: [{
          instrumentId: instrument.id,
          code: "chunk_unavailable",
          message: "Quote chunk is unavailable",
          retryable: true,
        }],
        meta: { nextRefreshAt: null },
      })
      .mockResolvedValueOnce({
        data: [{ ...freshQuote, price: 201, fetchedAt: "2026-07-19T17:00:01.000Z" }],
        errors: [],
        meta: { generatedAt: "2026-07-19T17:00:01.000Z", nextRefreshAt: null },
      });
    const app = new AppController([instrument], {
      root,
      client: { snapshot },
      minimumRefreshMs: 1_000,
      pauseWhenHidden: false,
    });

    try {
      await app.init();
      await expect(app.refreshNow()).rejects.toMatchObject({
        name: "SnapshotUnavailableError",
        code: "snapshot_unavailable",
        retryable: true,
      });
      expect(app.state.getTile(instrument.id)).toMatchObject({
        price: 200,
        quality: "stale",
        source: "yahoo",
      });
      expect(app.getRefreshState()).toMatchObject({
        failureCount: 1,
        nextRefreshAt: "2026-07-19T17:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
      expect(app.state.getTile(instrument.id)).toMatchObject({
        price: 201,
        quality: "fresh",
        source: "yahoo",
      });
      expect(app.getRefreshState()).toMatchObject({ failureCount: 0, lastError: null });
    } finally {
      app.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps a partial item-level snapshot failure on the successful refresh path", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const [available, unavailable] = STARTER_INSTRUMENTS;
    const client = {
      snapshot: vi.fn(async () => ({
        data: [{
          instrumentId: available.id,
          price: 200,
          change: 2,
          changePercent: 1,
          marketState: "regular",
          asOf: "2026-07-19T16:59:00.000Z",
          fetchedAt: "2026-07-19T16:59:01.000Z",
          quality: "fresh",
          source: "yahoo",
        }],
        errors: [{
          instrumentId: unavailable.id,
          code: "provider_unavailable",
          message: "Quote unavailable",
          retryable: true,
        }],
        meta: { generatedAt: "2026-07-19T16:59:01.000Z", nextRefreshAt: null },
      })),
    };
    const app = new AppController([available, unavailable], {
      root,
      client,
      pauseWhenHidden: false,
    });

    await expect(app.refreshSnapshot()).resolves.toMatchObject({ data: [expect.any(Object)] });
    expect(app.feed).toMatchObject({ status: "ready", available: 1, total: 2, error: null });
    expect(app.state.getTile(available.id)).toMatchObject({ price: 200, quality: "fresh" });
    expect(app.state.getTile(unavailable.id)).toMatchObject({
      price: null,
      quality: "unavailable",
      error: expect.objectContaining({ code: "provider_unavailable" }),
    });
    app.destroy();
  });

  it("loads stable five-session history for every instrument in the 40-name board", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const historyBatch = vi.fn(async (ids, options) => ({
      data: {
        range: options.range,
        interval: options.interval,
        histories: ids.map((instrumentId) => ({
          instrumentId,
          bars: [{ close: 100 }, { close: 101 }],
        })),
      },
      meta: { nextRefreshAt: null },
    }));
    const client = {
      snapshot: vi.fn(async () => ({
        data: [],
        errors: [],
        meta: { generatedAt: "2026-07-15T14:30:01.000Z", nextRefreshAt: null },
      })),
      historyBatch,
    };
    const app = new AppController(STARTER_INSTRUMENTS, {
      root,
      client,
      pauseWhenHidden: false,
    });

    await app.init();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledOnce());

    const [ids, options] = historyBatch.mock.calls[0];
    expect(ids).toEqual(STARTER_INSTRUMENTS.map(({ id }) => id));
    expect(ids).toHaveLength(40);
    expect(options).toMatchObject({ range: "5d", interval: "15m" });
    expect(options.timeoutMs).toBe(30_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    app.destroy();
  });

  it("refreshes sparklines every five minutes without multiplying history requests", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    let now = 0;
    const historyBatch = vi.fn(async (ids, options) => ({
      data: {
        range: options.range,
        interval: options.interval,
        histories: ids.map((instrumentId) => ({
          instrumentId,
          bars: [{ close: 100 }, { close: 101 }],
        })),
      },
      meta: { nextRefreshAt: null },
    }));
    const client = {
      snapshot: vi.fn(async () => ({
        data: [],
        errors: [],
        meta: { generatedAt: "2026-07-15T14:30:01.000Z", nextRefreshAt: null },
      })),
      historyBatch,
    };
    const app = new AppController(STARTER_INSTRUMENTS.slice(0, 2), {
      root,
      client,
      clock: () => now,
      pauseWhenHidden: false,
    });

    await app.refreshSnapshot();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(app.historyLoadInFlight).toBe(false));
    now = 4 * 60_000 + 59_999;
    await app.refreshSnapshot();
    expect(historyBatch).toHaveBeenCalledTimes(1);

    now = 5 * 60_000;
    await app.refreshSnapshot();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledTimes(2));
    app.destroy();
  });

  it("falls back per instrument when the preferred tile range cannot draw a sparkline", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const [emptyToday, activeToday] = STARTER_INSTRUMENTS;
    const historyBatch = vi.fn(async (ids, options) => ({
      data: {
        range: options.range,
        interval: options.interval,
        histories: ids.map((instrumentId) => ({
          instrumentId,
          bars: options.range === "5d" && instrumentId === emptyToday.id
            ? []
            : [{ displayClose: 100 }, { displayClose: 101 }],
        })),
      },
      meta: { nextRefreshAt: null },
    }));
    const client = {
      snapshot: vi.fn(async () => ({
        data: [],
        errors: [],
        meta: { generatedAt: "2026-07-19T16:30:00.000Z", nextRefreshAt: null },
      })),
      historyBatch,
    };
    const app = new AppController([emptyToday, activeToday], {
      root,
      client,
      pauseWhenHidden: false,
    });

    await app.refreshSnapshot();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledTimes(2));

    expect(historyBatch.mock.calls[0][0]).toEqual([emptyToday.id, activeToday.id]);
    expect(historyBatch.mock.calls[0][1]).toMatchObject({ range: "5d", interval: "15m" });
    expect(historyBatch.mock.calls[1][0]).toEqual([emptyToday.id]);
    expect(historyBatch.mock.calls[1][1]).toMatchObject({ range: "1d", interval: "5m" });
    expect(app.tileRegistry.getHistorySeries(emptyToday.id)).toEqual([100, 101]);
    expect(app.tileRegistry.getHistorySeries(activeToday.id)).toEqual([100, 101]);
    app.destroy();
  });

  it("keeps 5D as the tile default when the quote reports no current market session", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = STARTER_INSTRUMENTS[0];
    const historyBatch = vi.fn(async (ids, options) => ({
      data: ids.map((instrumentId) => ({
        instrumentId,
        bars: [{ displayClose: 100 }, { displayClose: 101 }],
      })),
      meta: { nextRefreshAt: null },
    }));
    const client = {
      snapshot: vi.fn(async () => ({
        data: [{
          instrumentId: instrument.id,
          price: 100,
          changePercent: 1,
          quality: "fresh",
          session: {
            phase: "closed",
            isTrading: false,
            regularStart: null,
            regularEnd: null,
          },
        }],
        errors: [],
        meta: { generatedAt: "2026-07-19T16:30:00.000Z", nextRefreshAt: null },
      })),
      historyBatch,
    };
    const app = new AppController([instrument], { root, client, pauseWhenHidden: false });

    await app.refreshSnapshot();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledOnce());

    expect(historyBatch.mock.calls[0][0]).toEqual([instrument.id]);
    expect(historyBatch.mock.calls[0][1]).toMatchObject({ range: "5d", interval: "15m" });
    expect(app.tileRegistry.getHistorySeries(instrument.id)).toEqual([100, 101]);
    app.destroy();
  });

  it("skips unsupported history and selects an asset-compatible price basis", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const eligible = {
      id: "FX:EURUSD",
      symbol: "EURUSD",
      assetClass: "fx",
      capabilities: {
        history: {
          status: "supported",
          ranges: { "1d": ["5m"], "1y": ["1d"] },
          priceBases: ["raw"],
        },
      },
    };
    const unsupported = {
      id: "BOND:US91282",
      symbol: "US91282",
      assetClass: "bond",
      capabilities: { history: { status: "unsupported", reason: "asset_class" } },
    };
    const historyBatch = vi.fn(async () => ({ data: [], meta: { nextRefreshAt: null } }));
    const history = vi.fn(async (_id, options) => ({
      data: { instrumentId: eligible.id, priceBasis: options.priceBasis, bars: [] },
    }));
    const client = {
      snapshot: vi.fn(async () => ({ data: [], errors: [], meta: { nextRefreshAt: null } })),
      historyBatch,
      history,
    };
    const app = new AppController([eligible, unsupported], { root, client, pauseWhenHidden: false });

    await app.refreshSnapshot();
    await vi.waitFor(() => expect(historyBatch).toHaveBeenCalledOnce());
    expect(historyBatch.mock.calls[0][0]).toEqual([eligible.id]);

    const series = await app.getHistory(eligible.id, { range: "1y", interval: "1d" });
    expect(history).toHaveBeenCalledWith(eligible.id, expect.objectContaining({ priceBasis: "raw" }));
    expect(series.priceBasis).toBe("raw");
    await expect(app.getHistory(unsupported.id)).rejects.toMatchObject({
      code: "unsupported_semantics",
      retryable: false,
    });
    app.destroy();
  });

  it("aborts an obsolete snapshot and refreshes the latest board after it settles", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const [first, second] = STARTER_INSTRUMENTS;
    let resolveFirst;
    const snapshot = vi.fn()
      .mockImplementationOnce((_ids, { signal }) => new Promise((resolve) => {
        resolveFirst = resolve;
        signal.addEventListener("abort", () => {}, { once: true });
      }))
      .mockResolvedValueOnce({
        data: [{
          instrumentId: second.id,
          price: 250,
          change: 1,
          changePercent: 0.4,
          open: 249,
          previousClose: 249,
          dayHigh: 251,
          dayLow: 248,
          bid: 249.9,
          ask: 250.1,
          volume: 1_000,
          averageVolume3m: 900,
          marketState: "regular",
          asOf: "2026-07-15T14:30:00.000Z",
          fetchedAt: "2026-07-15T14:30:01.000Z",
          currency: "USD",
          quality: "fresh",
          source: "yahoo",
        }],
        errors: [],
        meta: { generatedAt: "2026-07-15T14:30:01.000Z", nextRefreshAt: null },
      });
    const app = new AppController([first], {
      root,
      client: { snapshot },
      refreshPolicy: "manual",
      pauseWhenHidden: false,
    });

    const initial = app.init();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    const obsoleteSignal = snapshot.mock.calls[0][1].signal;
    app.applyExternalAssets([second]);
    expect(obsoleteSignal.aborted).toBe(true);

    resolveFirst({
      data: [{ instrumentId: first.id, price: 999, quality: "fresh", marketState: "regular" }],
      errors: [],
      meta: { generatedAt: "2026-07-15T14:30:00.000Z", nextRefreshAt: null },
    });
    await initial;
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.state.getTile(second.id)?.price).toBe(250));

    expect(snapshot.mock.calls[1][0]).toEqual([second.id]);
    expect(app.state.getTile(first.id)).toBeUndefined();
    app.destroy();
  });
});
