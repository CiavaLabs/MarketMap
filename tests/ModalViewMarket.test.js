import { describe, expect, it, vi } from "vitest";
import { ModalView } from "../src/ui/views/ModalView.js";

function capabilities(assetClass, overrides = {}) {
  const sections = assetClass === "fx" ? ["pair_metadata"] : [];
  return {
    quote: { status: "supported" },
    history: { status: "supported", ranges: { "1d": ["5m"] }, priceBases: ["raw"] },
    details: { status: sections.length ? "supported" : "unsupported", sections },
    news: { status: "unsupported" }, analytics: { status: "unsupported" }, ...overrides,
  };
}
const FX = Object.freeze({
  id: "FX:EURUSD", symbol: "EURUSD", displaySymbol: "EUR/USD", name: "Euro / US Dollar",
  assetClass: "fx", baseCurrency: "EUR", quoteCurrency: "USD", currency: "USD", priceUnit: "currency_per_unit",
  capabilities: capabilities("fx"),
});
const EQUITY = Object.freeze({
  id: "XNAS:AAPL", symbol: "AAPL", name: "Apple Inc.", assetClass: "equity", currency: "USD",
  capabilities: capabilities("equity", {
    history: {
      status: "supported",
      ranges: { "1d": ["5m"], "5d": ["15m"], "1m": ["1d"], "6m": ["1d"] },
      priceBases: ["raw", "provider_adjusted"],
    },
  }),
});
function quote() {
  return { instrumentId: FX.id, price: 1.0842, value: 1.0842, change: -0.0012, changePercent: -0.11,
    open: 1.0854, previousClose: 1.0854, dayHigh: 1.087, dayLow: 1.082, bid: 1.0841, ask: 1.0843,
    currency: "USD", priceUnit: "currency_per_unit", asOf: "2026-07-16T20:00:00.000Z", source: "yahoo",
    fieldAvailability: { value: { status: "available" }, volume: { status: "not_applicable" }, averageVolume3m: { status: "not_applicable" } }, dataQuality: { status: "usable" } };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe("ModalView v2 capability controller", () => {
  it("uses truthful range semantics and retries raw when adjusted rows are empty", async () => {
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const getHistory = vi.fn(async (_id, options) => {
      const adjustedWithoutValues = options.priceBasis === "provider_adjusted";
      return {
        instrumentId: EQUITY.id,
        priceBasis: options.priceBasis,
        requestedPriceBasis: options.priceBasis,
        continuity: { kind: "single_instrument" },
        bars: [0, 1].map((offset) => ({
          timestamp: `2026-07-${String(15 + offset).padStart(2, "0")}T20:00:00.000Z`,
          close: 230 + offset,
          displayClose: adjustedWithoutValues ? null : 230 + offset,
        })),
      };
    });
    const app = {
      state: { getTile: vi.fn(() => ({ ...quote(), instrumentId: EQUITY.id, price: 231 })) },
      getDetails: vi.fn(),
      getNews: vi.fn(),
      getHistory,
    };
    const view = new ModalView([EQUITY], {}, { detailApi });
    view.setApp(app);
    view.showAssetDetails(0);
    await flush();
    view.setHistoryRange("5d");
    await flush();
    view.setHistoryRange("1m");
    await flush();
    await flush();

    expect(getHistory.mock.calls.map(([, options]) => [options.range, options.priceBasis])).toEqual([
      ["1d", "raw"],
      ["5d", "raw"],
      ["1m", "provider_adjusted"],
      ["1m", "raw"],
    ]);
    expect(detailApi.setModel.mock.lastCall[0].chart).toMatchObject({ state: "ready", range: "1m" });
    expect(detailApi.setModel.mock.lastCall[0].chart.series).toHaveLength(2);
  });

  it("requests only applicable FX resources and presents pair semantics without news", async () => {
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const app = {
      state: { getTile: vi.fn(() => quote()) }, getProfile: vi.fn(), getNews: vi.fn(),
      getDetails: vi.fn(async () => ({ kind: "currency_pair", sections: [{ id: "pair_metadata", status: "available", fields: { baseCurrency: "EUR", quoteCurrency: "USD", sessionModel: "24x5" }, fieldAvailability: {} }] })),
      getHistory: vi.fn(async () => ({ instrumentId: FX.id, priceBasis: "raw", requestedPriceBasis: "raw", continuity: { kind: "single_instrument" }, fieldAvailability: { volume: { status: "not_applicable" } }, bars: [{ timestamp: "2026-07-16T19:50:00.000Z", close: 1.0838, displayClose: 1.0838 }, { timestamp: "2026-07-16T20:00:00.000Z", close: 1.0842, displayClose: 1.0842 }] })),
    };
    const view = new ModalView([FX], {}, { detailApi });
    view.setApp(app);
    view.showAssetDetails(0);
    await flush();
    expect(app.getDetails).toHaveBeenCalledOnce();
    expect(app.getNews).not.toHaveBeenCalled();
    expect(app.getProfile).not.toHaveBeenCalled();
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.header.badges).toContain("EUR/USD");
    expect(model.stats.map((stat) => stat.label)).not.toContain("Volume");
    expect(model.news.supported).toBe(false);
    expect(model.chart.series.map((point) => point.value)).toEqual([1.0838, 1.0842]);
  });

  it("does not request unsupported detail/history/news operations", () => {
    const unsupported = { ...FX, id: "RATE:US10Y", symbol: "US10Y", assetClass: "rate_index", capabilities: capabilities("rate_index", { history: { status: "unsupported" }, details: { status: "unsupported", sections: [] } }) };
    const app = { state: { getTile: vi.fn(() => ({ ...quote(), instrumentId: unsupported.id, priceUnit: "percent_yield" })) }, getDetails: vi.fn(), getHistory: vi.fn(), getNews: vi.fn(), getProfile: vi.fn() };
    const view = new ModalView([unsupported], {}, { detailApi: { setOpen: vi.fn(), setModel: vi.fn() } });
    view.setApp(app);
    view.showAssetDetails(0);
    expect(app.getDetails).not.toHaveBeenCalled();
    expect(app.getHistory).not.toHaveBeenCalled();
    expect(app.getNews).not.toHaveBeenCalled();
    expect(app.getProfile).not.toHaveBeenCalled();
  });
});
