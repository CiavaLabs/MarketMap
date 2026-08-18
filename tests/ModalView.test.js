import { describe, expect, it, vi } from "vitest";
import { HISTORY_RANGES, ModalView } from "../src/ui/views/ModalView.js";
import { movementAnalyticsRecord } from "./fixtures/movementAnalyticsRecord.js";

const AAPL = Object.freeze({
  id: "XNAS:AAPL", symbol: "AAPL", name: "Apple Inc.", assetClass: "equity", exchange: "NASDAQ", currency: "USD", sector: "Technology",
});
const MSFT = Object.freeze({
  ...AAPL, id: "XNAS:MSFT", symbol: "MSFT", name: "Microsoft Corp.",
});
const AS_OF = "2026-07-13T14:30:00.000Z";

function tile(overrides = {}) {
  return {
    instrumentId: AAPL.id, price: 232.41, change: 2.12, changePercent: 0.92,
    open: 230.1, previousClose: 230.29, dayHigh: 233.05, dayLow: 229.84,
    bid: 232.35, ask: 232.46, volume: 38_410_000, averageVolume3m: 49_820_000,
    asOf: AS_OF, currency: "USD", quality: "fresh", source: "yahoo", ...overrides,
  };
}

function history(offset = 0) {
  return {
    instrumentId: AAPL.id,
    range: "1d",
    interval: "5m",
    priceBasis: "raw",
    continuity: { kind: "single_instrument" },
    bars: [
    { timestamp: "2026-07-13T14:20:00.000Z", close: 230.5 + offset, displayClose: 230.5 + offset, volume: 10_000 },
    { timestamp: "2026-07-13T14:25:00.000Z", close: 231.6 + offset, displayClose: 231.6 + offset, volume: 12_000 },
    { timestamp: AS_OF, close: 232.41 + offset, displayClose: 232.41 + offset, volume: 14_000 },
  ] };
}

function details() {
  return {
    kind: "company",
    instrument: AAPL,
    sections: [
      {
        id: "company_profile",
        status: "available",
        fields: { sector: "Technology" },
        fieldAvailability: {},
      },
      {
        id: "equity_fundamentals",
        status: "available",
        fields: {
          marketCap: 3_000_000_000_000,
          revenueGrowth: 12.5,
          fiftyTwoWeekLow: 164,
          fiftyTwoWeekHigh: 260,
        },
        fieldAvailability: {},
      },
      {
        id: "analyst_outlook",
        status: "available",
        fields: { targetMeanPrice: 250 },
        fieldAvailability: {},
      },
    ],
  };
}

function api() {
  return { setOpen: vi.fn(), setModel: vi.fn() };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function mount(overrides = {}) {
  const detailApi = api();
  const currentTile = { value: tile() };
  const app = {
    state: { getTile: vi.fn(() => currentTile.value) },
    getDetails: vi.fn(async () => details()),
    getHistory: vi.fn(async () => history()),
    getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
    ...overrides,
  };
  const view = new ModalView([AAPL], {}, { detailApi });
  view.setApp(app);
  return { app, currentTile, detailApi, view };
}

describe("ModalView controller", () => {
  it("never writes live ticks back into the series the client handed it", async () => {
    const served = history();
    const barsFromClient = served.bars;
    const barCountFromClient = barsFromClient.length;
    const firstBarFromClient = { ...barsFromClient[0] };
    const { currentTile, view } = mount({ getHistory: vi.fn(async () => served) });

    view.showAssetDetails(0);
    await flush();

    currentTile.value = tile({ price: 240.5, asOf: "2026-07-13T14:35:00.000Z" });
    view.updateModalIfOpen({ instrumentId: AAPL.id });
    currentTile.value = tile({ price: 241.9, asOf: "2026-07-13T14:40:00.000Z" });
    view.updateModalIfOpen({ instrumentId: AAPL.id });

    expect(view.chartBars.length).toBe(barCountFromClient + 2);
    expect(barsFromClient).toHaveLength(barCountFromClient);
    expect(barsFromClient[0]).toEqual(firstBarFromClient);
    expect(barsFromClient.at(-1).volume).toBe(14_000);
  });

  it("navigates in the current filtered order, aborts superseded work and reports position", () => {
    const detailApi = api();
    const requests = [];
    const pending = (_id, options = {}) => {
      requests.push(options.signal);
      return new Promise(() => {});
    };
    const view = new ModalView([AAPL, MSFT], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => tile()) },
      getDetails: vi.fn(pending),
      getHistory: vi.fn(pending),
      getNews: vi.fn(pending),
    });
    view.setNavigationOrder([MSFT.id, AAPL.id]);

    view.showAssetDetails(0);
    expect(detailApi.setModel.mock.lastCall[0].navigation).toEqual({
      position: 2, total: 2, canPrevious: true, canNext: false,
    });

    expect(view.navigateInstrument(-1)).toBe(true);
    expect(requests.slice(0, 3).every((signal) => signal.aborted)).toBe(true);
    expect(detailApi.setModel.mock.lastCall[0]).toMatchObject({
      navigation: { position: 1, total: 2, canPrevious: false, canNext: true },
      header: { symbol: "MSFT" },
    });
    expect(view.navigateInstrument(-1)).toBe(false);
    view.destroy();
  });

  it("preserves the chosen chart range while traversing instruments", async () => {
    const detailApi = api();
    const getHistory = vi.fn(async (instrumentId, options) => ({
      ...history(),
      instrumentId,
      range: options.range,
      interval: options.interval,
    }));
    const view = new ModalView([AAPL, MSFT], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => tile()) },
      getDetails: vi.fn(async () => details()),
      getHistory,
      getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
    });
    view.setNavigationOrder([AAPL.id, MSFT.id]);

    view.showAssetDetails(0);
    await flush();
    view.setHistoryRange("5d");
    await flush();
    view.navigateInstrument(1);
    await flush();

    expect(getHistory.mock.calls.at(-1)).toEqual([
      MSFT.id,
      expect.objectContaining({ range: "5d", interval: "15m" }),
    ]);
    expect(detailApi.setModel.mock.lastCall[0].chart.range).toBe("5d");
    view.destroy();
  });

  it("loads details/history, preserves canonical ranges and publishes a detail view model", async () => {
    const { app, detailApi, view } = mount();
    view.showAssetDetails(0);
    await flush();

    expect(HISTORY_RANGES["1d"]).toEqual({ interval: "5m", label: "1D" });
    expect(app.getDetails).toHaveBeenCalledWith(AAPL.id, {
      sections: ["company_profile", "equity_fundamentals", "analyst_outlook"],
      signal: expect.any(AbortSignal),
    });
    expect(app.getHistory).toHaveBeenCalledWith(AAPL.id, {
      range: "1d",
      interval: "5m",
      priceBasis: "raw",
      signal: expect.any(AbortSignal),
    });
    expect(detailApi.setOpen).toHaveBeenCalledWith(true);
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.header).toMatchObject({ symbol: "AAPL", value: "$232.41", changeLabel: "+$2.12 (+0.92%)" });
    expect(model.chart.series.map((point) => point.value)).toEqual([230.5, 231.6, 232.41]);
    expect(model.details.sections.flatMap((section) => section.items).map((item) => item.label)).toContain("Market cap");
    expect(model.ranges).toHaveLength(2);
  });

  it("opens on 5D and disables 1D when there is no current trading session", async () => {
    const closedTile = tile({
      session: {
        phase: "closed",
        isTrading: false,
        regularStart: null,
        regularEnd: null,
      },
    });
    const detailApi = api();
    const getHistory = vi.fn(async (_id, options) => ({ ...history(), range: options.range, interval: options.interval }));
    const view = new ModalView([AAPL], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => closedTile) },
      getDetails: vi.fn(async () => details()),
      getHistory,
      getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
    });

    view.showAssetDetails(0);
    await flush();

    expect(getHistory).toHaveBeenCalledWith(AAPL.id, expect.objectContaining({ range: "5d", interval: "15m" }));
    const chart = detailApi.setModel.mock.lastCall[0].chart;
    expect(chart.range).toBe("5d");
    expect(chart.ranges.find(({ value }) => value === "1d")).toMatchObject({ disabled: true });
    view.destroy();
  });

  it("disables an empty range and automatically loads the next available interval", async () => {
    const detailApi = api();
    const getHistory = vi.fn(async (_id, options) => (
      options.range === "1d"
        ? { instrumentId: AAPL.id, range: "1d", interval: "5m", bars: [] }
        : { ...history(), range: options.range, interval: options.interval }
    ));
    const view = new ModalView([AAPL], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => tile()) },
      getDetails: vi.fn(async () => details()),
      getHistory,
      getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
    });

    view.showAssetDetails(0);
    await flush();
    await flush();

    expect(getHistory.mock.calls.map(([, options]) => options.range)).toEqual(["1d", "5d"]);
    const chart = detailApi.setModel.mock.lastCall[0].chart;
    expect(chart).toMatchObject({ state: "ready", range: "5d" });
    expect(chart.ranges.find(({ value }) => value === "1d")).toMatchObject({ disabled: true });
    view.destroy();
  });

  it("aborts a superseded history request and only accepts the current range", async () => {
    const requests = [];
    const { app, detailApi, view } = mount({
      getHistory: vi.fn((_id, options) => new Promise((resolve, reject) => {
        requests.push({ options, resolve, reject });
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })),
    });
    view.showAssetDetails(0);
    view.setHistoryRange("5d");

    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(requests[1].options).toMatchObject({ range: "5d", interval: "15m" });
    requests[1].resolve({ ...history(1), range: "5d", interval: "15m" });
    await flush();
    expect(detailApi.setModel.mock.lastCall[0].chart.range).toBe("5d");
    expect(app.getDetails).toHaveBeenCalledOnce();
  });

  it("keeps the previous chart visible while a new range transitions in", async () => {
    let resolveNext;
    const getHistory = vi.fn()
      .mockResolvedValueOnce(history())
      .mockImplementationOnce((_id, options) => new Promise((resolve) => {
        resolveNext = () => resolve({ ...history(10), range: options.range, interval: options.interval });
      }));
    const { detailApi, view } = mount({ getHistory });
    view.showAssetDetails(0);
    await flush();
    const initialSeries = detailApi.setModel.mock.lastCall[0].chart.series.map(({ value }) => value);

    view.setHistoryRange("5d");
    const transitioning = detailApi.setModel.mock.lastCall[0].chart;
    expect(transitioning).toMatchObject({ range: "5d", transitioning: true });
    expect(transitioning.series.map(({ value }) => value)).toEqual(initialSeries);

    resolveNext();
    await flush();
    const settled = detailApi.setModel.mock.lastCall[0].chart;
    expect(settled).toMatchObject({ range: "5d", transitioning: false });
    expect(settled.series.map(({ value }) => value)).toEqual([240.5, 241.6, 242.41]);
    view.destroy();
  });

  it("merges a newer raw live quote and maps crosshair index to the chart-heading readout", async () => {
    const { currentTile, detailApi, view } = mount();
    view.showAssetDetails(0);
    await flush();
    currentTile.value = tile({ price: 240, asOf: "2026-07-13T14:35:00.000Z" });
    view.updateModalIfOpen({ instrumentId: AAPL.id });
    expect(view.chartBars.at(-1)).toMatchObject({ close: 240, adjustedClose: 240 });
    view.handleChartHover(1);
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.chart.hoveredIndex).toBe(1);
    expect(model.chart.series[1].label).not.toBe("—");
  });

  it("aborts active work and notifies the host exactly once when it closes", () => {
    const historyRequest = new Promise(() => {});
    const setScrollLocked = vi.fn();
    const onOverlayChange = vi.fn();
    const detailApi = api();
    const view = new ModalView([AAPL], { removeTicker: vi.fn() }, { detailApi, setScrollLocked, onOverlayChange });
    view.setApp({ state: { getTile: vi.fn(() => tile()) }, getDetails: vi.fn(() => historyRequest), getHistory: vi.fn(() => historyRequest), getNews: vi.fn(() => historyRequest) });
    view.showAssetDetails(0);
    view.closeModal();
    expect(view.isOpen()).toBe(false);
    expect(setScrollLocked).toHaveBeenNthCalledWith(1, true);
    expect(setScrollLocked).toHaveBeenLastCalledWith(false);
    expect(onOverlayChange).toHaveBeenLastCalledWith(false);
    expect(detailApi.setOpen).toHaveBeenLastCalledWith(false);
  });

  it("publishes the statistical context only when a displayable record arrives", async () => {
    const record = movementAnalyticsRecord();
    const getMovementAnalytics = vi.fn(async () => record);
    const { detailApi, view } = mount({ getMovementAnalytics });

    view.showAssetDetails(0);
    expect(detailApi.setModel.mock.lastCall[0].statisticalContext).toBeNull();
    await flush();

    expect(getMovementAnalytics).toHaveBeenCalledWith(AAPL.id, {
      signal: expect.any(AbortSignal),
    });
    const context = detailApi.setModel.mock.lastCall[0].statisticalContext;
    expect(context).toMatchObject({
      title: "Statistical context",
      sessionDate: "2026-07-27",
    });
    expect(context.movement.map(({ label }) => label)).toEqual([
      "Adjusted close-to-close return",
      "EWMA daily volatility forecast",
      "Move / forecast volatility",
    ]);
    expect(context.rarity.label).toBe("Empirical percentile");
    view.destroy();
  });

  it("omits the statistical context for missing records, failures, and unavailable assessments", async () => {
    for (const getMovementAnalytics of [
      vi.fn(async () => null),
      vi.fn(async () => { throw new Error("analytics endpoint down"); }),
      vi.fn(async () => movementAnalyticsRecord((value) => {
        value.assessment.status = "unavailable";
        value.assessment.forecast = null;
        value.assessment.evidence = null;
        value.assessment.quality.reasonCodes = ["stale_input"];
      })),
    ]) {
      const { detailApi, view } = mount({ getMovementAnalytics });
      view.showAssetDetails(0);
      await flush();
      expect(getMovementAnalytics).toHaveBeenCalledOnce();
      expect(detailApi.setModel.mock.lastCall[0].statisticalContext).toBeNull();
      view.destroy();
    }
  });

  it("never requests analytics for non-equity assets or analytics-less hosts", async () => {
    const getMovementAnalytics = vi.fn(async () => movementAnalyticsRecord());
    const fund = { ...AAPL, id: "ARCX:SPY", symbol: "SPY", assetClass: "etf" };
    const detailApi = api();
    const view = new ModalView([fund], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => tile({ instrumentId: fund.id })) },
      getDetails: vi.fn(async () => details()),
      getHistory: vi.fn(async () => history()),
      getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
      getMovementAnalytics,
    });
    view.showAssetDetails(0);
    await flush();
    expect(getMovementAnalytics).not.toHaveBeenCalled();
    expect(detailApi.setModel.mock.lastCall[0].statisticalContext).toBeNull();
    view.destroy();

    const { detailApi: plainApi, view: plainView } = mount();
    plainView.showAssetDetails(0);
    await flush();
    expect(plainApi.setModel.mock.lastCall[0].statisticalContext).toBeNull();
    plainView.destroy();
  });

  it("flags an end-of-day record that belongs to an earlier session than the live quote", async () => {
    const record = movementAnalyticsRecord();
    const liveTile = tile({
      asOf: "2026-07-28T15:30:00.000Z",
      session: { phase: "regular", isTrading: true, timezone: "America/New_York" },
    });
    const detailApi = api();
    const view = new ModalView([AAPL], {}, { detailApi });
    view.setApp({
      state: { getTile: vi.fn(() => liveTile) },
      getDetails: vi.fn(async () => details()),
      getHistory: vi.fn(async () => history()),
      getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
      getMovementAnalytics: vi.fn(async () => record),
    });
    view.showAssetDetails(0);
    await flush();
    const context = detailApi.setModel.mock.lastCall[0].statisticalContext;
    expect(context.note).toBe(
      "Refers to the completed 2026-07-27 session, not the 2026-07-28 session shown by the live quote.",
    );
    view.destroy();
  });

  it("aborts the in-flight analytics request when the dialog closes", async () => {
    let observedSignal = null;
    const getMovementAnalytics = vi.fn((_id, { signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    });
    const { view } = mount({ getMovementAnalytics });
    view.showAssetDetails(0);
    view.closeModal();
    expect(observedSignal?.aborted).toBe(true);
    view.destroy();
  });

  it("releases host overlay state when destroyed with a dialog open", () => {
    const setScrollLocked = vi.fn();
    const onOverlayChange = vi.fn();
    const detailApi = api();
    const view = new ModalView([AAPL], {}, { detailApi, setScrollLocked, onOverlayChange });
    const pending = new Promise(() => {});
    view.setApp({
      state: { getTile: vi.fn(() => tile()) },
      getDetails: vi.fn(() => pending),
      getHistory: vi.fn(() => pending),
      getNews: vi.fn(() => pending),
    });

    view.showAssetDetails(0);
    view.destroy();

    expect(setScrollLocked.mock.calls).toEqual([[true], [false]]);
    expect(onOverlayChange.mock.calls).toEqual([[true], [false]]);
    expect(detailApi.setOpen).toHaveBeenLastCalledWith(false);
  });
});
