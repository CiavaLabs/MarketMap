import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import {
  normalizeYahooDetails,
  normalizeYahooHistory,
  normalizeYahooQuote,
} from "../../../server/providers/yahoo/marketNormalizers.js";
import {
  CRYPTO_DESCRIPTOR,
  EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  FUTURE_DESCRIPTOR,
  FX_DESCRIPTOR,
  RATE_DESCRIPTOR,
  FIXED_NOW,
} from "../fixtures/market/descriptors.js";
import {
  RAW_QUOTE_BTC,
  RAW_QUOTE_EURUSD,
  RAW_QUOTE_GC,
  RAW_QUOTE_SPY,
  RAW_QUOTE_TNX,
} from "../fixtures/market/rawYahoo.js";
import {
  YAHOO_AAPL_HISTORY,
  YAHOO_AAPL_PROFILE,
  YAHOO_AAPL_QUOTE,
} from "../providers/fixtures/yahoo.js";

const CLOCK = () => FIXED_NOW;

function quote(raw, descriptor) {
  return normalizeYahooQuote(raw, { descriptor, clock: CLOCK });
}

function chartFor(descriptor, quotes, extra = {}) {
  return {
    meta: {
      symbol: descriptor.providerSymbols.yahoo.symbol,
      instrumentType: descriptor.providerSymbols.yahoo.providerType,
      currency: descriptor.currency,
      exchangeTimezoneName: descriptor.assetClass === "crypto"
        ? "UTC"
        : "America/New_York",
    },
    quotes: structuredClone(quotes),
    ...extra,
  };
}

function history(raw, descriptor, options = {}) {
  return normalizeYahooHistory(raw, {
    descriptor,
    range: options.range || "1d",
    interval: options.interval || "5m",
    priceBasis: options.priceBasis || "raw",
    invalidRowThreshold: options.invalidRowThreshold ?? 0.2,
    futureQuote: options.futureQuote || null,
    clock: CLOCK,
  });
}

function dailyRow(index, overrides = {}) {
  const close = 101 + index;
  return {
    date: new Date(Date.UTC(2026, 6, 10 + index)),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    adjclose: close - 0.25,
    volume: 1_000 + index,
    ...overrides,
  };
}

describe("normalizeYahooQuote", () => {
  it.each([
    ["equity", YAHOO_AAPL_QUOTE, EQUITY_DESCRIPTOR, 317.31],
    ["ETF", RAW_QUOTE_SPY, ETF_DESCRIPTOR, 628.42],
  ])("normalizes an authoritative %s quote", (_, raw, descriptor, expectedValue) => {
    const snapshot = quote(raw, descriptor);

    expect(snapshot).toMatchObject({
      instrumentId: descriptor.id,
      assetClass: descriptor.assetClass,
      value: expectedValue,
      price: expectedValue,
      priceUnit: descriptor.priceUnit,
      currency: descriptor.currency,
      session: { model: "exchange_hours", phase: "post", isTrading: false },
      quality: "fresh",
      provenance: {
        source: "yahoo",
        providerSymbol: descriptor.providerSymbols.yahoo.symbol,
        providerType: raw.quoteType,
        fallback: false,
      },
      fetchedAt: "2026-07-16T20:00:00.000Z",
    });
    expect(snapshot.dataQuality.status).toBe("usable");
  });

  it("turns Yahoo FX zero volume into not-applicable availability", () => {
    const snapshot = quote(RAW_QUOTE_EURUSD, FX_DESCRIPTOR);

    expect(snapshot).toMatchObject({
      value: 1.0842,
      volume: null,
      averageVolume3m: null,
      session: { model: "24x5", phase: "continuous", isTrading: true },
      fieldAvailability: {
        volume: { status: "not_applicable", reason: "fx_otc_volume" },
        averageVolume3m: { status: "not_applicable", reason: "fx_otc_volume" },
      },
    });
    expect(snapshot.dataQuality.issues).not.toContainEqual(
      expect.objectContaining({ code: "provider_zero_placeholder", field: "volume" }),
    );
  });

  it("models crypto as a continuous UTC session", () => {
    const snapshot = quote(RAW_QUOTE_BTC, CRYPTO_DESCRIPTOR);

    expect(snapshot.session).toEqual({
      model: "24x7",
      phase: "continuous",
      timezone: "UTC",
      isTrading: true,
      regularStart: null,
      regularEnd: null,
    });
    expect(snapshot.volume).toBe(RAW_QUOTE_BTC.regularMarketVolume);
    expect(snapshot.fieldAvailability.volume.status).toBe("available");
  });

  it("accepts negative future prices and negative rate observations", () => {
    const future = quote({ ...RAW_QUOTE_GC, regularMarketPrice: -37.63 }, FUTURE_DESCRIPTOR);
    const rate = quote({ ...RAW_QUOTE_TNX, regularMarketPrice: -0.125 }, RATE_DESCRIPTOR);

    expect(future).toMatchObject({
      value: -37.63,
      priceUnit: "currency",
      session: { model: "provider_schedule" },
    });
    expect(rate).toMatchObject({
      value: -0.125,
      priceUnit: "percent_yield",
      volume: null,
      fieldAvailability: { volume: { status: "not_applicable" } },
    });
  });

  it("labels delayed observations and derives missing changes from previous close", () => {
    const raw = {
      ...YAHOO_AAPL_QUOTE,
      regularMarketPrice: 320,
      regularMarketPreviousClose: 315,
      regularMarketChange: null,
      regularMarketChangePercent: null,
      exchangeDataDelayedBy: 15,
      quoteSourceName: "Nasdaq Delayed Price",
    };
    const snapshot = quote(raw, EQUITY_DESCRIPTOR);

    expect(snapshot).toMatchObject({
      quality: "delayed",
      change: 5,
      changePercent: (5 / 315) * 100,
      fieldAvailability: {
        change: { status: "available" },
        changePercent: { status: "available" },
      },
    });
    expect(snapshot.dataQuality.issues).toEqual(expect.arrayContaining([
      { code: "provider_delayed", severity: "info", field: null },
      { code: "derived_from_previous_close", severity: "info", field: "change" },
      { code: "derived_from_previous_close", severity: "info", field: "changePercent" },
    ]));
  });

  it.each([null, undefined, ""])(
    "uses fetchedAt when regularMarketTime is the empty value %p",
    (regularMarketTime) => {
      const snapshot = quote({ ...YAHOO_AAPL_QUOTE, regularMarketTime }, EQUITY_DESCRIPTOR);

      expect(snapshot.asOf).toBe("2026-07-16T20:00:00.000Z");
      expect(snapshot.asOf).toBe(snapshot.fetchedAt);
      expect(snapshot.asOf).not.toBe("1970-01-01T00:00:00.000Z");
    },
  );

  it("rejects a quote type that conflicts with the resolved descriptor", () => {
    expect(() => quote(RAW_QUOTE_SPY, EQUITY_DESCRIPTOR)).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.SCHEMA_INVALID,
        capability: "quote",
        details: { expected: "equity", observed: "etf" },
      }),
    );
  });
});

describe("normalizeYahooHistory", () => {
  it("treats an empty closed-session window as unavailable data, not schema drift", () => {
    expect(() => history(chartFor(EQUITY_DESCRIPTOR, []), EQUITY_DESCRIPTOR)).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        retryable: true,
        details: {
          reason: "empty_history",
          totalRows: 0,
          range: "1d",
          interval: "5m",
        },
      }),
    );
  });

  it("normalizes a raw series without requiring adjusted close", () => {
    const raw = chartFor(EQUITY_DESCRIPTOR, YAHOO_AAPL_HISTORY.quotes);
    delete raw.quotes[0].adjclose;
    const series = history(raw, EQUITY_DESCRIPTOR);

    expect(series).toMatchObject({
      instrumentId: EQUITY_DESCRIPTOR.id,
      priceBasis: "raw",
      requestedPriceBasis: "raw",
      adjustment: { status: "none" },
      continuity: { kind: "single_instrument", rollover: null },
      dataQuality: { rowCount: 2, droppedRows: 0 },
    });
    expect(series.bars[0]).toMatchObject({
      adjustedClose: null,
      displayClose: series.bars[0].close,
    });
  });

  it.each([null, undefined])(
    "keeps a series valid when optional volume is %p",
    (volume) => {
      const rows = structuredClone(YAHOO_AAPL_HISTORY.quotes);
      if (volume === undefined) delete rows[0].volume;
      else rows[0].volume = volume;

      const series = history(chartFor(EQUITY_DESCRIPTOR, rows), EQUITY_DESCRIPTOR);

      expect(series.bars[0]).toMatchObject({
        volume: null,
        fieldAvailability: { volume: { status: "temporarily_unavailable" } },
      });
      expect(series.bars).toHaveLength(rows.length);
    },
  );

  it("keeps an adjusted gap, preserves events and never fills it with raw close", () => {
    const raw = chartFor(ETF_DESCRIPTOR, YAHOO_AAPL_HISTORY.quotes, {
      events: {
        dividends: {
          dividend: {
            date: new Date("2026-07-12T00:00:00.000Z"),
            amount: 1.25,
            currency: "USD",
          },
        },
        splits: [{
          date: new Date("2026-07-11T00:00:00.000Z"),
          splitRatio: "2:1",
        }],
      },
    });
    raw.quotes[1].adjclose = null;
    const series = history(raw, ETF_DESCRIPTOR, {
      range: "1y",
      interval: "1d",
      priceBasis: "provider_adjusted",
    });

    expect(series.bars[1]).toMatchObject({
      adjustedClose: null,
      displayClose: null,
      fieldAvailability: {
        adjustedClose: { status: "temporarily_unavailable" },
        displayClose: { status: "temporarily_unavailable" },
      },
    });
    expect(series.dataQuality).toMatchObject({
      status: "usable_with_warnings",
      missingAdjustedCloseRows: 1,
      issues: [{ code: "partial_adjusted_series", severity: "warning", field: "adjustedClose" }],
    });
    expect(series.events).toEqual([
      {
        type: "split",
        timestamp: "2026-07-11T00:00:00.000Z",
        numerator: 2,
        denominator: 1,
        source: "yahoo",
      },
      {
        type: "dividend",
        timestamp: "2026-07-12T00:00:00.000Z",
        amount: 1.25,
        currency: "USD",
        source: "yahoo",
      },
    ]);
  });

  it("sorts provider rows that arrive newest first into an ascending series", () => {
    const newestFirst = [dailyRow(2), dailyRow(1), dailyRow(0)];
    const series = history(
      chartFor(EQUITY_DESCRIPTOR, newestFirst),
      EQUITY_DESCRIPTOR,
      { range: "1m", interval: "1d" },
    );

    expect(series.bars.map(({ timestamp }) => timestamp)).toEqual([
      "2026-07-10T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
      "2026-07-12T00:00:00.000Z",
    ]);
    expect(series.bars.map(({ close }) => close)).toEqual([101, 102, 103]);
    expect(series.asOf).toBe("2026-07-12T00:00:00.000Z");
    expect(series.dataQuality).toMatchObject({ status: "usable", rowCount: 3, droppedRows: 0 });
  });

  it("drops rows at the configured threshold and rejects a series above it", () => {
    const oneInvalid = Array.from({ length: 5 }, (_, index) => dailyRow(index));
    oneInvalid[2] = dailyRow(2, { high: 90 });
    const accepted = history(
      chartFor(EQUITY_DESCRIPTOR, oneInvalid),
      EQUITY_DESCRIPTOR,
      { range: "1m", interval: "1d" },
    );

    expect(accepted.bars).toHaveLength(4);
    expect(accepted.dataQuality).toMatchObject({
      status: "usable_with_warnings",
      rowCount: 4,
      droppedRows: 1,
      issues: [expect.objectContaining({ code: "row_dropped_invalid_ohlc" })],
    });

    const aboveThreshold = [dailyRow(0), dailyRow(1, { low: 200 }), dailyRow(2)];
    expect(() => history(
      chartFor(EQUITY_DESCRIPTOR, aboveThreshold),
      EQUITY_DESCRIPTOR,
      { range: "1m", interval: "1d" },
    )).toThrowError(expect.objectContaining({
      code: ERROR_CODES.SCHEMA_INVALID,
      capability: "history",
      details: { totalRows: 3, droppedRows: 1, invalidRowThreshold: 0.2 },
    }));
  });

  it("accepts coherent negative future bars and emits continuity metadata", () => {
    const raw = chartFor(FUTURE_DESCRIPTOR, [
      dailyRow(0, { open: -10, high: -5, low: -15, close: -8, adjclose: -8 }),
      dailyRow(1, { open: -8, high: -4, low: -12, close: -6, adjclose: -6 }),
    ]);
    const series = history(raw, FUTURE_DESCRIPTOR, {
      range: "1m",
      interval: "1d",
      futureQuote: RAW_QUOTE_GC,
    });

    expect(series.bars.map(({ close }) => close)).toEqual([-8, -6]);
    expect(series.bars.every(({ displayClose, close }) => displayClose === close)).toBe(true);
    expect(series.continuity).toEqual({
      kind: "provider_continuous_front",
      activeContract: "GCQ26.CMX",
      expirationDate: "2026-08-27T00:00:00.000Z",
      rollover: "provider_managed",
      backAdjustment: "unknown",
      comparableAcrossRollover: false,
    });
  });

  it.each([
    ["the exchange timezone the chart reports", "Europe/London", "Europe/London"],
    ["no timezone when the chart omits it", undefined, null],
  ])("labels the series with %s", (_label, exchangeTimezoneName, expected) => {
    const raw = chartFor(EQUITY_DESCRIPTOR, YAHOO_AAPL_HISTORY.quotes);
    raw.meta.exchangeTimezoneName = exchangeTimezoneName;
    const series = history(raw, EQUITY_DESCRIPTOR);

    expect(series.session).toEqual({ model: "exchange_hours", timezone: expected });
  });

  it("rejects chart metadata that conflicts with the resolved descriptor", () => {
    const raw = chartFor(ETF_DESCRIPTOR, YAHOO_AAPL_HISTORY.quotes);
    expect(() => history(raw, EQUITY_DESCRIPTOR)).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.SCHEMA_INVALID,
        capability: "history",
        details: { expected: "equity", observed: "etf" },
      }),
    );
  });
});

describe("normalizeYahooDetails", () => {
  it("routes each Yahoo quoteSummary module into the company section that owns it", () => {
    const details = normalizeYahooDetails(YAHOO_AAPL_PROFILE, {
      descriptor: EQUITY_DESCRIPTOR,
      clock: CLOCK,
    });

    expect(details.sections.map(({ id }) => id))
      .toEqual(["company_profile", "equity_fundamentals", "analyst_outlook"]);
    expect(details.sections.find(({ id }) => id === "company_profile")).toEqual({
      id: "company_profile",
      status: "available",
      fields: {
        sector: "Technology",
        industry: "Consumer Electronics",
        country: "United States",
        website: "https://www.apple.com",
        employees: 164_000,
      },
      fieldAvailability: {},
    });
    expect(details.sections.find(({ id }) => id === "equity_fundamentals")).toEqual({
      id: "equity_fundamentals",
      status: "available",
      fields: {
        marketCap: 4_740_000_000_000,
        trailingPe: 33.4,
        forwardPe: 29.2,
        epsTtm: 9.5,
        beta: 1.2,
        priceBook: 52.1,
        priceSales: 10.75,
        dividendYield: 0.49,
        revenueTtm: 416_000_000_000,
        revenueGrowth: 6.1,
        netMargin: 26.400000000000002,
        returnOnEquity: 171,
        debtEquity: 1.524,
        freeCashFlow: 112_000_000_000,
        freeCashFlowMargin: 26.923076923076923,
        fiftyTwoWeekLow: 195.1,
        fiftyTwoWeekHigh: 323.45,
      },
      fieldAvailability: {},
    });
    expect(details.sections.find(({ id }) => id === "analyst_outlook")).toEqual({
      id: "analyst_outlook",
      status: "available",
      fields: { recommendation: "buy", targetMeanPrice: 330, numberOfAnalysts: 42 },
      fieldAvailability: {},
    });
    expect(details.provenance).toEqual({
      source: "yahoo",
      providerSymbol: "AAPL",
      fallback: false,
    });
  });

  it("normalizes Yahoo fund ratios and allocations into percentage points", () => {
    const details = normalizeYahooDetails({
      fundProfile: {
        family: "Vanguard",
        feesExpensesInvestment: { annualReportExpenseRatio: 0.0003 },
      },
      topHoldings: {
        stockPosition: 0.04,
        bondPosition: 0.95,
        cashPosition: 0.01,
      },
      summaryDetail: { yield: 0.04, totalAssets: 120_000_000_000 },
    }, { descriptor: ETF_DESCRIPTOR, clock: CLOCK });

    expect(details.sections.find(({ id }) => id === "fund_profile").fields)
      .toMatchObject({ expenseRatio: 0.03 });
    expect(details.sections.find(({ id }) => id === "fund_composition").fields)
      .toMatchObject({ equityAllocation: 4, bondAllocation: 95, cashAllocation: 1 });
    expect(details.sections.find(({ id }) => id === "fund_stats").fields)
      .toMatchObject({ yield: 4 });
  });

  it("reads the dividend yield as the fund yield and still reports percentage points", () => {
    const details = normalizeYahooDetails({
      summaryDetail: { dividendYield: 0.0049, totalAssets: 120_000_000_000 },
    }, { descriptor: ETF_DESCRIPTOR, clock: CLOCK });

    expect(details.sections.find(({ id }) => id === "fund_stats").fields)
      .toMatchObject({ yield: 0.49 });

    const distributing = normalizeYahooDetails({
      summaryDetail: { yield: 0.04, dividendYield: 0.0049 },
    }, { descriptor: ETF_DESCRIPTOR, clock: CLOCK });

    expect(distributing.sections.find(({ id }) => id === "fund_stats").fields)
      .toMatchObject({ yield: 4 });
  });
});
