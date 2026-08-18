import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  ERROR_CODES,
  SCHEMA_VERSION,
  isBar,
  isInstrument,
  isMetric,
  isQuoteSnapshot,
  validateBars,
  validateInstrument,
  validateMetric,
  validateQuoteSnapshot,
} from "../../server/contracts/index.js";
import { MarketDataError } from "../../server/errors/MarketDataError.js";

const instrument = {
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  exchange: "NasdaqGS",
  mic: "XNAS",
  currency: "USD",
  country: "US",
  sector: "Technology",
  status: "active",
};

const quote = {
  instrumentId: "XNAS:AAPL",
  price: 225.5,
  change: 2.5,
  changePercent: 1.12,
  open: 223,
  previousClose: 223,
  dayHigh: 226,
  dayLow: 222,
  bid: null,
  ask: null,
  volume: 20_000_000,
  averageVolume3m: 42_000_000,
  marketState: "regular",
  asOf: "2026-07-13T18:45:00.000Z",
  fetchedAt: "2026-07-13T18:45:01.000Z",
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
};

describe("server runtime contracts", () => {
  it("publishes stable API and snapshot schema versions", () => {
    expect(API_VERSION).toBe("v1");
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("accepts canonical instruments and rejects unknown asset classes", () => {
    expect(validateInstrument(instrument)).toBe(instrument);
    expect(isInstrument(instrument)).toBe(true);
    expect(isInstrument({ ...instrument, assetClass: "warrant" })).toBe(false);

    expect(() => validateInstrument({ ...instrument, assetClass: "warrant" })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }),
    );
  });

  it("validates nullable quotes and cross-field day ranges", () => {
    expect(validateQuoteSnapshot(quote)).toBe(quote);
    expect(isQuoteSnapshot(quote)).toBe(true);
    expect(isQuoteSnapshot({ ...quote, price: Number.NaN })).toBe(false);

    try {
      validateQuoteSnapshot({ ...quote, dayHigh: 200 });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataError);
      expect(error.details.issues).toContainEqual(
        expect.objectContaining({ path: "quote.dayHigh" }),
      );
    }
  });

  it("validates metric units, provenance, and optional formula metadata", () => {
    const metric = {
      id: "fcf_margin",
      value: 24.3,
      unit: "percent",
      period: "ttm",
      asOf: "2026-06-30T00:00:00Z",
      source: "derived",
      quality: "fresh",
      formulaVersion: "fcf-margin@1",
    };

    expect(validateMetric(metric)).toBe(metric);
    expect(isMetric(metric)).toBe(true);
    expect(isMetric({ ...metric, unit: "percentage-points" })).toBe(false);
  });

  it("validates coherent, strictly ordered OHLCV bars", () => {
    const bars = [
      {
        timestamp: "2026-07-13T14:30:00Z",
        open: 100,
        high: 103,
        low: 99,
        close: 102,
        volume: 1_000,
      },
      {
        timestamp: "2026-07-13T14:35:00Z",
        open: 102,
        high: 104,
        low: 101,
        close: 103,
        volume: null,
      },
    ];

    expect(validateBars(bars)).toBe(bars);
    expect(isBar(bars[0])).toBe(true);
    expect(isBar({ ...bars[0], high: 98 })).toBe(false);
    expect(() => validateBars([bars[1], bars[0]])).toThrow(MarketDataError);
  });
});

describe("MarketDataError", () => {
  it("serializes a safe application/problem+json-compatible shape", () => {
    const error = new MarketDataError(ERROR_CODES.RATE_LIMITED, "Provider quota exhausted", {
      provider: "finnhub",
      capability: "quote",
      details: { retryAfterMs: 5_000 },
    });

    expect(error.retryable).toBe(true);
    expect(error.toProblem({ requestId: "req-1", instance: "/api/market/v1/snapshot" })).toEqual({
      type: "urn:market-map:error:rate_limited",
      title: "Upstream rate limit",
      status: 503,
      detail: "Provider quota exhausted",
      code: "rate_limited",
      retryable: true,
      instance: "/api/market/v1/snapshot",
      requestId: "req-1",
      provider: "finnhub",
      capability: "quote",
      details: { retryAfterMs: 5_000 },
    });
  });

  it("wraps unknown exceptions without discarding their cause", () => {
    const cause = new Error("socket closed");
    const error = MarketDataError.from(cause);
    expect(error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(error.cause).toBe(cause);
  });
});
