import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../src/core/StateManager.js";

const instruments = [
  {
    id: "XNAS:AAPL",
    symbol: "AAPL",
    name: "Apple Inc.",
    assetClass: "equity",
    mic: "XNAS",
    currency: "USD",
    sector: "Technology",
    status: "active",
    price: 999,
  },
  {
    id: "XNAS:MSFT",
    symbol: "MSFT",
    name: "Microsoft Corp.",
    assetClass: "equity",
    mic: "XNAS",
    currency: "USD",
    sector: "Technology",
    status: "active",
  },
];

const quote = (instrumentId, overrides = {}) => ({
  instrumentId,
  price: 225.5,
  change: 2.5,
  changePercent: 1.12,
  open: 223,
  previousClose: 223,
  dayHigh: 226,
  dayLow: 222,
  bid: 225.4,
  ask: 225.6,
  volume: 20_000_000,
  averageVolume3m: 42_000_000,
  marketState: "regular",
  asOf: "2026-07-13T18:45:00.000Z",
  fetchedAt: "2026-07-13T18:45:01.000Z",
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
  ...overrides,
});

describe("StateManager real-only quote state", () => {
  it("starts unavailable and never uses instrument metadata as a placeholder price", () => {
    const state = new StateManager(instruments);
    expect(state.getTile("XNAS:AAPL")).toMatchObject({
      instrumentId: "XNAS:AAPL",
      symbol: "AAPL",
      price: null,
      change: null,
      changePercent: null,
      quality: "unavailable",
      source: null,
    });
  });

  it("rejects a non-canonical ID before it can diverge from server quote identity", () => {
    expect(() => new StateManager([{ ...instruments[0], id: "xnas:aapl" }]))
      .toThrow("Instrument requires a canonical id");
  });

  it("applies a complete QuoteSnapshot without accumulating snapshot volume", () => {
    const state = new StateManager(instruments);
    const updated = vi.fn();
    state.on("tile:updated", updated);

    state.applyQuoteSnapshot(quote("XNAS:AAPL"));
    expect(state.getTile("AAPL")).toMatchObject({
      price: 225.5,
      change: 2.5,
      changePercent: 1.12,
      open: 223,
      previousClose: 223,
      dayHigh: 226,
      dayLow: 222,
      high: 226,
      low: 222,
      bid: 225.4,
      ask: 225.6,
      volume: 20_000_000,
      averageVolume3m: 42_000_000,
      marketState: "regular",
      quality: "fresh",
      source: "yahoo",
      error: null,
    });

    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      price: 226,
      volume: 21_000_000,
      quality: "delayed",
      source: "finnhub",
    }));
    expect(state.getTile("XNAS:AAPL")).toMatchObject({
      price: 226,
      volume: 21_000_000,
      quality: "delayed",
      source: "finnhub",
    });
    expect(updated).toHaveBeenCalledTimes(2);
    expect(updated.mock.calls[1][0]).toMatchObject({
      instrumentId: "XNAS:AAPL",
      symbol: "AAPL",
      oldPrice: 225.5,
      newPrice: 226,
    });
  });

  it("keeps null quote fields null and marks partial failures honestly unavailable", () => {
    const state = new StateManager(instruments);
    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      bid: null,
      ask: null,
      volume: null,
      averageVolume3m: null,
    }));
    expect(state.getTile("AAPL")).toMatchObject({
      bid: null,
      ask: null,
      volume: null,
      averageVolume3m: null,
    });

    const batch = vi.fn();
    state.on("tiles:batch_updated", batch);
    state.applyQuoteBatch([quote("XNAS:AAPL", { price: 227 })], {
      errors: [{ instrumentId: "XNAS:MSFT", code: "instrument_not_found", message: "Not found" }],
    });

    expect(state.getTile("MSFT")).toMatchObject({
      price: null,
      value: null,
      quality: "unavailable",
      error: { code: "instrument_not_found", message: "Not found" },
    });
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0].instrumentIds).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("allows symbol lookup only while that symbol is unambiguous", () => {
    const state = new StateManager([
      { id: "XNAS:ABC", symbol: "ABC", name: "US ABC", status: "active" },
      { id: "XLON:ABC", symbol: "ABC", name: "UK ABC", status: "active" },
      { id: "XNAS:XYZ", symbol: "XYZ", name: "XYZ", status: "active" },
    ]);

    expect(state.getTile("ABC")).toBeUndefined();
    expect(state.getTile("XNAS:ABC")?.name).toBe("US ABC");
    expect(state.getTile("xyz")?.instrumentId).toBe("XNAS:XYZ");
  });

  it("preserves v2 asset semantics, availability, quality and provenance", () => {
    const rate = {
      id: "RATE:^TNX",
      symbol: "^TNX",
      name: "10 Year Treasury Yield",
      assetClass: "rate_index",
      currency: "USD",
      priceUnit: "percent_yield",
    };
    const state = new StateManager([rate]);
    state.applyQuoteSnapshot(quote(rate.id, {
      assetClass: "rate_index",
      value: -0.125,
      price: -0.125,
      priceUnit: "percent_yield",
      currency: "USD",
      volume: null,
      averageVolume3m: null,
      session: {
        model: "publisher_schedule",
        phase: "regular",
        timezone: "America/New_York",
        isTrading: true,
        regularStart: null,
        regularEnd: null,
      },
      fieldAvailability: {
        volume: { status: "not_applicable", reason: "rate_index" },
        averageVolume3m: { status: "not_applicable", reason: "rate_index" },
      },
      dataQuality: { status: "usable", issues: [] },
      provenance: {
        source: "yahoo",
        providerSymbol: "^TNX",
        fallback: false,
      },
      source: undefined,
    }));

    expect(state.getTile(rate.id)).toMatchObject({
      assetClass: "rate_index",
      value: -0.125,
      price: -0.125,
      priceUnit: "percent_yield",
      marketState: "regular",
      source: "yahoo",
      fieldAvailability: {
        volume: { status: "not_applicable", reason: "rate_index" },
      },
      dataQuality: { status: "usable", issues: [] },
      provenance: { source: "yahoo", providerSymbol: "^TNX", fallback: false },
    });
  });
});

describe("StateManager partial batch tolerance", () => {
  it("degrades only the malformed quote and still publishes the batch", () => {
    const state = new StateManager(instruments);
    const batches = vi.fn();
    state.on("tiles:batch_updated", batches);

    const payload = state.applyQuoteBatch([
      quote("XNAS:AAPL"),
      quote("XNAS:MSFT", { quality: "bogus" }),
    ]);

    expect(batches).toHaveBeenCalledTimes(1);
    expect(state.getTile("XNAS:AAPL")).toMatchObject({ price: 225.5, quality: "fresh" });
    expect(state.getTile("XNAS:MSFT")).toMatchObject({ price: null, quality: "unavailable" });
    expect(state.getTile("XNAS:MSFT").error).toMatchObject({
      code: "schema_invalid",
      retryable: false,
    });
    expect(payload.items.map((item) => item.instrumentId)).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("marks an instrument unavailable once when the same error repeats", () => {
    const state = new StateManager(instruments);
    const error = { instrumentId: "XNAS:MSFT", code: "upstream_unavailable", message: "down", retryable: true };

    const payload = state.applyQuoteBatch([quote("XNAS:AAPL")], { errors: [error, error] });

    expect(payload.items.map((item) => item.instrumentId)).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("skips a corrupt entry while restoring the rest of a persisted snapshot", () => {
    const state = new StateManager(instruments);
    const restored = vi.fn();
    state.on("state:restored", restored);

    expect(state.deserialize({
      schemaVersion: 1,
      tiles: [
        { instrumentId: "XNAS:AAPL", price: Number.NaN },
        { instrumentId: "XNAS:MSFT", price: 42, quality: "fresh", marketState: "regular" },
      ],
    })).toBe(true);

    expect(restored.mock.calls[0][0].instrumentIds).toEqual(["XNAS:MSFT"]);
    expect(state.getTile("XNAS:MSFT")).toMatchObject({ price: 42, quality: "fresh" });
    expect(state.getTile("XNAS:AAPL").price).toBeNull();
  });
});
