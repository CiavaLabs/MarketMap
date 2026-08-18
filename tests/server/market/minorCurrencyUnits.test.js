import { describe, expect, it } from "vitest";
import { resolveCurrencyUnit } from "../../../server/instruments/currencyUnits.js";
import { descriptorFromYahooQuote } from "../../../server/instruments/descriptorFactory.js";
import {
  normalizeChartUnits,
  normalizeQuoteSummaryUnits,
  normalizeQuoteUnits,
} from "../../../server/providers/yahoo/minorUnits.js";
import { normalizeYahooQuote } from "../../../server/providers/yahoo/marketNormalizers.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";

const CLOCK = () => Date.parse("2026-08-08T12:00:00.000Z");

const RAW_LSE_QUOTE = Object.freeze({
  symbol: "VOD.L",
  quoteType: "EQUITY",
  exchange: "LSE",
  fullExchangeName: "LSE",
  longName: "Vodafone Group Plc",
  currency: "GBp",
  regularMarketPrice: 120.5,
  regularMarketPreviousClose: 119.3,
  regularMarketOpen: 119.5,
  regularMarketDayHigh: 120.5,
  regularMarketDayLow: 119.1,
  regularMarketChange: 1.2,
  regularMarketChangePercent: 1.0058,
  regularMarketVolume: 43_210_000,
  averageDailyVolume3Month: 50_000_000,
  bid: 120.4,
  ask: 120.6,
  marketCap: 27_847_950_336,
  exchangeTimezoneName: "Europe/London",
  marketState: "REGULAR",
  regularMarketTime: "2026-08-08T11:30:00.000Z",
});

function lseDescriptor() {
  const { descriptor } = descriptorFromYahooQuote({
    providerSymbol: "VOD.L",
    quote: normalizeQuoteUnits(RAW_LSE_QUOTE),
    clock: CLOCK,
  });
  return descriptor;
}

describe("minor currency units", () => {
  it("maps provider minor-unit codes to their major currency and scale", () => {
    expect(resolveCurrencyUnit("GBp")).toEqual({ currency: "GBP", scale: 100 });
    expect(resolveCurrencyUnit("GBX")).toEqual({ currency: "GBP", scale: 100 });
    expect(resolveCurrencyUnit("gbx")).toEqual({ currency: "GBP", scale: 100 });
    expect(resolveCurrencyUnit("ZAc")).toEqual({ currency: "ZAR", scale: 100 });
    expect(resolveCurrencyUnit("ILA")).toEqual({ currency: "ILS", scale: 100 });
  });

  it("never treats a major ISO code as a minor unit", () => {
    expect(resolveCurrencyUnit("GBP")).toEqual({ currency: "GBP", scale: 1 });
    expect(resolveCurrencyUnit("gbp")).toEqual({ currency: "GBP", scale: 1 });
    expect(resolveCurrencyUnit("usd")).toEqual({ currency: "USD", scale: 1 });
    expect(resolveCurrencyUnit("")).toBeNull();
    expect(resolveCurrencyUnit(null)).toBeNull();
  });

  it("returns the payload untouched when the quote is already in major units", () => {
    const major = { ...RAW_LSE_QUOTE, currency: "GBP" };
    expect(normalizeQuoteUnits(major)).toBe(major);
  });

  it("rescales quote prices and reports the major currency", () => {
    const normalized = normalizeQuoteUnits(RAW_LSE_QUOTE);
    expect(normalized.currency).toBe("GBP");
    expect(normalized.regularMarketPrice).toBeCloseTo(1.205, 10);
    expect(normalized.regularMarketPreviousClose).toBeCloseTo(1.193, 10);
    expect(normalized.regularMarketOpen).toBeCloseTo(1.195, 10);
    expect(normalized.regularMarketDayHigh).toBeCloseTo(1.205, 10);
    expect(normalized.regularMarketDayLow).toBeCloseTo(1.191, 10);
    expect(normalized.regularMarketChange).toBeCloseTo(0.012, 10);
    expect(normalized.bid).toBeCloseTo(1.204, 10);
    expect(normalized.ask).toBeCloseTo(1.206, 10);
  });

  it("leaves ratios, volumes and market capitalisation on their own scale", () => {
    const normalized = normalizeQuoteUnits(RAW_LSE_QUOTE);
    expect(normalized.regularMarketChangePercent).toBe(RAW_LSE_QUOTE.regularMarketChangePercent);
    expect(normalized.regularMarketVolume).toBe(RAW_LSE_QUOTE.regularMarketVolume);
    expect(normalized.averageDailyVolume3Month).toBe(RAW_LSE_QUOTE.averageDailyVolume3Month);
    expect(normalized.marketCap).toBe(RAW_LSE_QUOTE.marketCap);
  });

  it("does not mutate the provider payload", () => {
    const source = { ...RAW_LSE_QUOTE };
    normalizeQuoteUnits(source);
    expect(source.regularMarketPrice).toBe(120.5);
    expect(source.currency).toBe("GBp");
  });

  it("rescales chart bars, chart metadata and dividend amounts", () => {
    const chart = {
      meta: { symbol: "VOD.L", currency: "GBp", chartPreviousClose: 119.3 },
      quotes: [
        { date: "2026-08-07T15:30:00.000Z", open: 118, high: 120, low: 117.5, close: 119.3, adjclose: 118.9, volume: 1_000 },
      ],
      events: {
        dividends: [{ date: "2026-06-01T00:00:00.000Z", amount: 2.5 }],
        splits: [{ date: "2026-05-01T00:00:00.000Z", numerator: 2, denominator: 1 }],
      },
    };
    const normalized = normalizeChartUnits(chart);
    expect(normalized.meta.currency).toBe("GBP");
    expect(normalized.meta.chartPreviousClose).toBeCloseTo(1.193, 10);
    expect(normalized.quotes[0]).toMatchObject({ open: 1.18, high: 1.2, close: 1.193 });
    expect(normalized.quotes[0].adjclose).toBeCloseTo(1.189, 10);
    expect(normalized.quotes[0].volume).toBe(1_000);
    expect(normalized.events.dividends[0].amount).toBeCloseTo(0.025, 10);
    expect(normalized.events.splits[0]).toEqual({
      date: "2026-05-01T00:00:00.000Z",
      numerator: 2,
      denominator: 1,
    });
  });

  it("rescales per-share summary fields but not aggregate ones", () => {
    const summary = {
      summaryDetail: {
        currency: "GBp",
        fiftyTwoWeekLow: 83.4,
        fiftyTwoWeekHigh: 131.1,
        marketCap: 27_847_950_336,
        dividendRate: 4.5,
        trailingAnnualDividendRate: 4.4,
        dividendYield: 3.7,
      },
      price: { currency: "GBp", regularMarketPrice: 120.5, marketCap: 27_847_950_336 },
      financialData: { targetMeanPrice: 113.91827, financialCurrency: "EUR" },
      defaultKeyStatistics: { trailingEps: -0.01, beta: 0.6 },
    };
    const normalized = normalizeQuoteSummaryUnits(summary);
    expect(normalized.summaryDetail.currency).toBe("GBP");
    expect(normalized.summaryDetail.fiftyTwoWeekLow).toBeCloseTo(0.834, 10);
    expect(normalized.summaryDetail.fiftyTwoWeekHigh).toBeCloseTo(1.311, 10);
    expect(normalized.summaryDetail.marketCap).toBe(27_847_950_336);
    expect(normalized.summaryDetail.dividendRate).toBeCloseTo(0.045, 10);
    expect(normalized.summaryDetail.trailingAnnualDividendRate).toBeCloseTo(0.044, 10);
    expect(normalized.summaryDetail.dividendYield).toBe(3.7);
    expect(normalized.price.regularMarketPrice).toBeCloseTo(1.205, 10);
    expect(normalized.price.marketCap).toBe(27_847_950_336);
    expect(normalized.financialData.targetMeanPrice).toBeCloseTo(1.1391827, 10);
    expect(normalized.defaultKeyStatistics).toEqual(summary.defaultKeyStatistics);
  });

  it("rescales the raw member of a formatted summary value", () => {
    const normalized = normalizeQuoteSummaryUnits({
      summaryDetail: { currency: "GBp", fiftyTwoWeekHigh: { raw: 131.1, fmt: "131.10" } },
    });
    expect(normalized.summaryDetail.fiftyTwoWeekHigh.raw).toBeCloseTo(1.311, 10);
    expect(normalized.summaryDetail.fiftyTwoWeekHigh.fmt).toBeUndefined();
  });

  it("mints a major-currency descriptor for a pence-quoted listing", () => {
    const descriptor = lseDescriptor();
    expect(descriptor).toMatchObject({ id: "XLON:VOD", currency: "GBP", priceUnit: "currency" });
  });

  it("resolves a raw minor-unit quote to the major currency code", () => {
    const { descriptor } = descriptorFromYahooQuote({
      providerSymbol: "VOD.L",
      quote: RAW_LSE_QUOTE,
      clock: CLOCK,
    });
    expect(descriptor.currency).toBe("GBP");
  });

  it("publishes a pence-quoted listing in pounds through quoteMany", async () => {
    const descriptor = lseDescriptor();
    const provider = new YahooProvider({
      client: { quote: async () => [RAW_LSE_QUOTE] },
      clock: CLOCK,
    });
    const { data, errors } = await provider.quoteMany([descriptor]);
    expect(errors).toEqual([]);
    expect(data).toHaveLength(1);
    expect(data[0].currency).toBe("GBP");
    expect(data[0].value).toBeCloseTo(1.205, 10);
    expect(data[0].previousClose).toBeCloseTo(1.193, 10);
    expect(data[0].changePercent).toBeCloseTo(1.0058, 10);
  });

  it("keeps a major-currency listing bit-identical through the v2 quote normalizer", () => {
    const usdQuote = { ...RAW_LSE_QUOTE, symbol: "AAA", currency: "USD", exchange: "NYQ", fullExchangeName: "NYSE" };
    const { descriptor } = descriptorFromYahooQuote({
      providerSymbol: "AAA",
      quote: usdQuote,
      clock: CLOCK,
    });
    const normalized = normalizeYahooQuote(normalizeQuoteUnits(usdQuote), { descriptor, clock: CLOCK });
    expect(normalized.value).toBe(120.5);
    expect(normalized.currency).toBe("USD");
  });
});
