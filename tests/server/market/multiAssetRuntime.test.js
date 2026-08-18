import { describe, expect, it, vi } from "vitest";

import { MARKET_ASSET_CLASSES } from "../../../server/contracts/market/constants.js";
import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { EQUITY_DESCRIPTOR } from "../fixtures/market/descriptors.js";
import {
  RAW_QUOTE_BTC,
  RAW_QUOTE_EURUSD,
  RAW_QUOTE_GC,
  RAW_QUOTE_GSPC,
  RAW_QUOTE_SPY,
  RAW_QUOTE_TNX,
} from "../fixtures/market/rawYahoo.js";
import { YAHOO_AAPL_QUOTE } from "../providers/fixtures/yahoo.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const IDS = Object.freeze([
  "XNAS:AAPL",
  "ARCX:SPY",
  "XNAS:BND",
  "ARCX:AGG",
  "INDEX:^GSPC",
  "FX:EURUSD",
  "CRYPTO:BTC-USD",
  "FUTURE:CMX.GC.CONTINUOUS.1",
  "RATE:^TNX",
]);

const BND = Object.freeze({
  ...RAW_QUOTE_SPY,
  symbol: "BND",
  exchange: "NGM",
  fullExchangeName: "NasdaqGM",
  longName: "Vanguard Total Bond Market ETF",
  regularMarketPrice: 73.41,
});
const AGG = Object.freeze({
  ...RAW_QUOTE_SPY,
  symbol: "AGG",
  exchange: "PCX",
  fullExchangeName: "NYSEArca",
  longName: "iShares Core U.S. Aggregate Bond ETF",
  regularMarketPrice: 99.12,
});

const QUOTES = Object.freeze({
  AAPL: YAHOO_AAPL_QUOTE,
  SPY: RAW_QUOTE_SPY,
  BND,
  AGG,
  "^GSPC": RAW_QUOTE_GSPC,
  "EURUSD=X": RAW_QUOTE_EURUSD,
  "BTC-USD": RAW_QUOTE_BTC,
  "GC=F": RAW_QUOTE_GC,
  "^TNX": RAW_QUOTE_TNX,
});

function chartFor(symbol) {
  const quote = QUOTES[symbol];
  const close = quote.regularMarketPrice;
  const width = Math.max(Math.abs(close) * 0.01, 0.001);
  return {
    meta: {
      symbol,
      instrumentType: quote.quoteType,
      currency: quote.currency,
      exchangeTimezoneName: quote.exchangeTimezoneName,
      underlyingSymbol: quote.underlyingSymbol,
      expireDate: quote.expireDate,
    },
    quotes: [
      {
        date: new Date("2026-07-15T20:00:00.000Z"),
        open: close - width / 2,
        high: close + width,
        low: close - width,
        close,
        adjclose: close - width / 10,
        volume: quote.regularMarketVolume ?? 0,
      },
      {
        date: new Date("2026-07-16T20:00:00.000Z"),
        open: close,
        high: close + width,
        low: close - width,
        close: close + width / 2,
        adjclose: close + width / 2,
        volume: quote.regularMarketVolume ?? 0,
      },
    ],
    events: {},
  };
}

function detailsFor(symbol) {
  return {
    assetProfile: {
      sector: symbol === "AAPL" ? "Technology" : null,
      industry: symbol === "AAPL" ? "Consumer Electronics" : null,
      network: symbol === "BTC-USD" ? "Bitcoin" : null,
    },
    summaryDetail: {
      marketCap: symbol === "AAPL" ? 3_000_000_000_000 : null,
      totalAssets: ["SPY", "BND", "AGG"].includes(symbol) ? 100_000_000_000 : null,
      yield: ["BND", "AGG"].includes(symbol) ? 0.04 : null,
      fiftyTwoWeekHigh: QUOTES[symbol].regularMarketPrice * 1.1,
      fiftyTwoWeekLow: QUOTES[symbol].regularMarketPrice * 0.9,
      previousClose: QUOTES[symbol].regularMarketPreviousClose,
      dayHigh: QUOTES[symbol].regularMarketDayHigh,
      dayLow: QUOTES[symbol].regularMarketDayLow,
    },
    defaultKeyStatistics: { trailingEps: symbol === "AAPL" ? 7.1 : null },
    financialData: { recommendationKey: symbol === "AAPL" ? "buy" : null },
    price: { marketCap: symbol === "BTC-USD" ? 2_000_000_000_000 : null },
    quoteType: {},
    fundProfile: {
      family: ["SPY", "BND", "AGG"].includes(symbol) ? "Fund family" : null,
      categoryName: ["BND", "AGG"].includes(symbol) ? "Intermediate Core Bond" : "Large Blend",
      legalType: "Exchange Traded Fund",
    },
    topHoldings: {
      holdings: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      stockPosition: symbol === "SPY" ? 0.99 : 0,
      bondPosition: ["BND", "AGG"].includes(symbol) ? 0.95 : 0,
    },
  };
}

function fakeYahooClient() {
  return {
    quote: vi.fn(async (symbols) => symbols.map((symbol) => structuredClone(QUOTES[symbol])).filter(Boolean)),
    chart: vi.fn(async (symbol) => chartFor(symbol)),
    quoteSummary: vi.fn(async (symbol) => detailsFor(symbol)),
    search: vi.fn(async () => ({ quotes: [], news: [] })),
  };
}

function market(options = {}) {
  const yahooClient = fakeYahooClient();
  return {
    yahooClient,
    service: createMarketDataService({
      yahooClient,
      finnhubApiKey: "",
      enabledAssetClasses: [...MARKET_ASSET_CLASSES],
      clock: () => NOW,
      logLevel: "silent",
      ...options,
    }),
  };
}

describe("v2 multi-asset runtime", () => {
  it("serves a mixed snapshot with asset-aware units, sessions and volume semantics", async () => {
    const { service } = market();
    const result = await service.getSnapshot(IDS);

    expect(result.errors).toEqual([]);
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(IDS);
    expect(new Set(result.data.map(({ assetClass }) => assetClass))).toEqual(new Set(MARKET_ASSET_CLASSES));
    expect(result.data.find(({ instrumentId }) => instrumentId === "FX:EURUSD")).toMatchObject({
      session: { model: "24x5", phase: "continuous" },
      volume: null,
      fieldAvailability: { volume: { status: "not_applicable", reason: "fx_otc_volume" } },
    });
    expect(result.data.find(({ instrumentId }) => instrumentId === "CRYPTO:BTC-USD")).toMatchObject({
      session: { model: "24x7", phase: "continuous", isTrading: true },
    });
    expect(result.data.find(({ instrumentId }) => instrumentId === "RATE:^TNX")).toMatchObject({
      priceUnit: "percent_yield",
      volume: null,
    });
    await service.close();
  });

  it("returns one entry per instrument when a snapshot request repeats an id", async () => {
    const { service } = market();

    const result = await service.getSnapshot(["XNAS:AAPL", "xnas:aapl", "XNAS:AAPL", "ARCX:SPY"]);

    expect(result.errors).toEqual([]);
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL", "ARCX:SPY"]);
    await service.close();
  });

  function aliasCatalogStore() {
    return {
      get: async (instrumentId) => (instrumentId === "AAPL"
        ? { instrumentId: "AAPL", descriptor: EQUITY_DESCRIPTOR }
        : null),
      set: async () => {},
    };
  }

  it("returns a quote requested under an alias of its canonical id", async () => {
    const { service } = market({ instrumentCatalogStore: aliasCatalogStore() });

    const result = await service.getSnapshot(["AAPL"]);

    expect(result.errors).toEqual([]);
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
    await service.close();
  });

  it("fetches one instrument once when an alias and its canonical id are both requested", async () => {
    const { service, yahooClient } = market({ instrumentCatalogStore: aliasCatalogStore() });

    const result = await service.getSnapshot(["AAPL", "XNAS:AAPL"]);

    expect(result.errors).toEqual([]);
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
    expect(yahooClient.quote.mock.calls.flatMap(([symbols]) => symbols)).toEqual(["AAPL"]);
    await service.close();
  });

  it("persists successful v2 quote batches with bounded parallelism", async () => {
    let activeWrites = 0;
    let peakWrites = 0;
    const snapshotStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async (record) => {
        activeWrites += 1;
        peakWrites = Math.max(peakWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWrites -= 1;
        return record;
      }),
      delete: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    const { service } = market({ snapshotStore });

    const result = await service.getSnapshot(IDS);

    expect(result.errors).toEqual([]);
    expect(snapshotStore.set).toHaveBeenCalledTimes(IDS.length);
    expect(peakWrites).toBeGreaterThan(1);
    expect(peakWrites).toBeLessThanOrEqual(8);
    await service.close();
  });

  it("serves raw history for every enabled class and keeps adjusted semantics explicit", async () => {
    const { service, yahooClient } = market();
    const raw = await service.getHistoryBatch(IDS, {
      range: "1m",
      interval: "1d",
      priceBasis: "raw",
      maxConcurrency: 3,
    });

    expect(raw.errors).toEqual([]);
    expect(raw.data.map(({ instrumentId }) => instrumentId)).toEqual(IDS);

    const repeated = await service.getHistoryBatch([IDS[0], IDS[0].toLowerCase(), IDS[1]], {
      range: "1m",
      interval: "1d",
      priceBasis: "raw",
    });
    expect(repeated.data.map(({ instrumentId }) => instrumentId)).toEqual([IDS[0], IDS[1]]);

    expect(raw.data.every(({ priceBasis, requestedPriceBasis }) => (
      priceBasis === "raw" && requestedPriceBasis === "raw"
    ))).toBe(true);
    expect(raw.data.find(({ instrumentId }) => instrumentId === "FUTURE:CMX.GC.CONTINUOUS.1").continuity)
      .toMatchObject({ kind: "provider_continuous_front", comparableAcrossRollover: false });

    const adjusted = await service.getHistory("ARCX:SPY", {
      range: "1y",
      interval: "1d",
      priceBasis: "provider_adjusted",
    });
    expect(adjusted.data).toMatchObject({
      priceBasis: "provider_adjusted",
      requestedPriceBasis: "provider_adjusted",
      adjustment: { status: "provider_defined" },
    });
    const beforeUnsupported = yahooClient.chart.mock.calls.length;
    await expect(service.getHistory("FX:EURUSD", {
      range: "1y",
      interval: "1d",
      priceBasis: "provider_adjusted",
    })).rejects.toMatchObject({ code: "unsupported_semantics" });
    expect(yahooClient.chart).toHaveBeenCalledTimes(beforeUnsupported);
    await service.close();
  });

  it("returns discriminated details and fixed-income ETF metadata without equity leakage", async () => {
    const { service } = market();
    const expectedKinds = new Map([
      ["XNAS:AAPL", "company"],
      ["ARCX:SPY", "fund"],
      ["XNAS:BND", "fund"],
      ["INDEX:^GSPC", "index"],
      ["FX:EURUSD", "currency_pair"],
      ["CRYPTO:BTC-USD", "crypto_asset"],
      ["FUTURE:CMX.GC.CONTINUOUS.1", "future_contract"],
      ["RATE:^TNX", "rate_index"],
    ]);

    for (const [instrumentId, kind] of expectedKinds) {
      const result = await service.getDetails(instrumentId);
      expect(result.data.kind).toBe(kind);
      if (kind !== "company") {
        expect(result.data.sections.map(({ id }) => id)).not.toContain("equity_fundamentals");
      }
    }
    const bond = await service.getDetails("XNAS:BND");
    expect(bond.data.instrument).toMatchObject({ assetClass: "etf", assetSubtype: "bond_etf" });
    expect(bond.data.sections.map(({ id }) => id)).toEqual([
      "fund_profile",
      "fund_composition",
      "fund_stats",
    ]);
    expect(bond.data.sections.find(({ id }) => id === "fund_composition").fields)
      .toMatchObject({ bondAllocation: 95 });
    await service.close();
  });
});
