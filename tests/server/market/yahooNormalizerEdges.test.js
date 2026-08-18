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
  INDEX_DESCRIPTOR,
  FUTURE_DESCRIPTOR,
  ETF_DESCRIPTOR,
  NON_US_EQUITY_DESCRIPTOR,
} from "../fixtures/market/descriptors.js";
import { RAW_QUOTE_SPY } from "../fixtures/market/rawYahoo.js";
import { YAHOO_AAPL_QUOTE } from "../providers/fixtures/yahoo.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const clock = () => NOW;

const quote = (patch = {}) => ({ ...YAHOO_AAPL_QUOTE, ...patch });
const normalize = (patch = {}, descriptor = EQUITY_DESCRIPTOR) =>
  normalizeYahooQuote(quote(patch), { descriptor, clock });

const bar = (offsetDays, patch = {}) => ({
  date: new Date(NOW - offsetDays * 86_400_000),
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  adjclose: 101,
  volume: 1_000,
  ...patch,
});

const chart = (quotes, patch = {}) => ({
  meta: {
    symbol: "AAPL",
    instrumentType: "EQUITY",
    currency: "USD",
    exchangeTimezoneName: "America/New_York",
  },
  quotes,
  events: {},
  ...patch,
});

const healthy = (count = 6) => Array.from({ length: count }, (_, index) => bar(count + 1 - index));

const history = (quotes, options = {}) => normalizeYahooHistory(chart(quotes), {
  descriptor: EQUITY_DESCRIPTOR,
  range: "1y",
  interval: "1d",
  priceBasis: "raw",
  clock,
  ...options,
});

const thrown = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

describe("quote payload rejection", () => {
  it.each([
    ["a non-object payload", null, EQUITY_DESCRIPTOR],
    ["a payload that is a string", "quote", EQUITY_DESCRIPTOR],
    ["a descriptor with no id", YAHOO_AAPL_QUOTE, {}],
    ["no descriptor at all", YAHOO_AAPL_QUOTE, undefined],
  ])("rejects %s", (_label, raw, descriptor) => {
    const error = thrown(() => normalizeYahooQuote(raw, { descriptor, clock }));

    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.capability).toBe("quote");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/invalid quote payload/u);
  });

  it.each([
    ["no observed price", { regularMarketPrice: null }],
    ["a zero price on an asset that cannot trade at zero", { regularMarketPrice: 0 }],
    ["a negative price on an equity", { regularMarketPrice: -5 }],
  ])("rejects a quote with %s", (_label, patch) => {
    const error = thrown(() => normalize(patch));

    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.capability).toBe("quote");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/no valid observed value/u);
  });

  it("rejects a day high below the day low", () => {
    const error = thrown(() => normalize({
      regularMarketDayHigh: 10,
      regularMarketDayLow: 20,
    }));
    expect(error.details).toMatchObject({ dayHigh: 10, dayLow: 20 });
  });

  it("reports a price-less NONE placeholder as an unknown instrument", () => {
    const error = thrown(() => normalize({ regularMarketPrice: null, quoteType: "NONE" }));

    expect(error.code).toBe(ERROR_CODES.INSTRUMENT_NOT_FOUND);
    expect(error.retryable).toBe(false);
    expect(error.instrumentId).toBe(EQUITY_DESCRIPTOR.id);
  });
});

describe("v2 quote delay quality", () => {
  it.each([
    ["the provider reports a positive delay", { exchangeDataDelayedBy: 15 }],
    ["the source name says the quote is delayed", {
      exchangeDataDelayedBy: 0,
      quoteSourceName: "Delayed Quote",
    }],
  ])("labels a quote delayed when %s", (_label, patch) => {
    const result = normalize(patch);

    expect(result.quality).toBe("delayed");
    expect(result.asOf).toBe(new Date(YAHOO_AAPL_QUOTE.regularMarketTime).toISOString());
    expect(result.dataQuality.issues).toContainEqual({
      code: "provider_delayed",
      severity: "info",
      field: null,
    });
  });
});

describe("details numeric hygiene", () => {
  it("refuses a negative headcount but keeps the section it sits in", () => {
    const details = normalizeYahooDetails(
      { assetProfile: { sector: "Technology", fullTimeEmployees: -3 } },
      { descriptor: EQUITY_DESCRIPTOR, clock },
    );
    const profile = details.sections.find(({ id }) => id === "company_profile");

    expect(profile.fields.employees).toBeNull();
    expect(profile.fields.sector).toBe("Technology");
  });

  it.each([
    ["a boolean market cap", { summaryDetail: { marketCap: true, trailingPE: 31.2 } }, "marketCap"],
    ["a boolean beta", { defaultKeyStatistics: { beta: true, trailingEps: 9.5 } }, "beta"],
    ["an unreadable P/E", { summaryDetail: { trailingPE: "n/a", marketCap: 100 } }, "trailingPe"],
  ])("drops %s rather than coercing it", (_label, raw, field) => {
    const details = normalizeYahooDetails(raw, { descriptor: EQUITY_DESCRIPTOR, clock });

    expect(details.sections.find(({ id }) => id === "equity_fundamentals").fields[field]).toBeNull();
  });

  it("leaves a genuinely negative fundamental alone", () => {
    const details = normalizeYahooDetails(
      { defaultKeyStatistics: { trailingEps: -2.5, beta: 1.1 } },
      { descriptor: EQUITY_DESCRIPTOR, clock },
    );

    expect(details.sections.find(({ id }) => id === "equity_fundamentals").fields.epsTtm).toBe(-2.5);
  });
});

describe("details numeric hygiene beyond equities", () => {
  it("refuses a negative crypto volume", () => {
    const details = normalizeYahooDetails(
      { summaryDetail: { volume24Hr: -3, circulatingSupply: 19_000_000 } },
      { descriptor: CRYPTO_DESCRIPTOR, clock },
    );
    const section = details.sections.find(({ fields }) => "volume24h" in fields);

    expect(section.fields.volume24h).toBeNull();
    expect(section.fields.circulatingSupply).toBe(19_000_000);
  });

  it.each([
    ["a fund's total assets", ETF_DESCRIPTOR, { summaryDetail: { totalAssets: true, yield: 0.012 } }, "fund_stats", "totalAssets"],
    ["an index constituent count", INDEX_DESCRIPTOR, { defaultKeyStatistics: { constituents: true }, price: { marketCap: 5 } }, "market_stats", "marketCap"],
  ])("refuses %s as a boolean", (_label, descriptor, raw, sectionId, field) => {
    const details = normalizeYahooDetails(raw, { descriptor, clock });
    const section = details.sections.find(({ id }) => id === sectionId);

    if (!section || !(field in section.fields)) return;
    expect(section.fields[field]).not.toBe(true);
    expect(section.fields[field]).not.toBe(1);
  });
});

describe("market timestamp conversion", () => {
  it("refuses a boolean where a timestamp belongs", () => {
    const result = normalizeYahooQuote({ ...YAHOO_AAPL_QUOTE, regularMarketTime: true }, {
      descriptor: EQUITY_DESCRIPTOR,
      clock,
    });

    expect(result.asOf.startsWith("1970")).toBe(false);
    expect(result.asOf).toBe(result.fetchedAt);
  });

  it("refuses a negative analyst count", () => {
    const details = normalizeYahooDetails(
      { financialData: { numberOfAnalystOpinions: -3, targetMeanPrice: 92.5 } },
      { descriptor: EQUITY_DESCRIPTOR, clock },
    );
    const outlook = details.sections.find(({ id }) => id === "analyst_outlook");

    expect(outlook.fields.numberOfAnalysts).toBeNull();
    expect(outlook.fields.targetMeanPrice).toBe(92.5);
  });

  it("reads a bare chart-meta epoch as seconds, not milliseconds", () => {
    const seconds = Math.floor(Date.parse("2026-12-18T00:00:00.000Z") / 1000);
    const base = chart(healthy());
    const series = normalizeYahooHistory(
      { ...base, meta: { ...base.meta, instrumentType: "FUTURE", expireDate: seconds } },
      { descriptor: FUTURE_DESCRIPTOR, range: "1y", interval: "1d", priceBasis: "raw", clock },
    );

    expect(series.continuity.expirationDate).toBe("2026-12-18T00:00:00.000Z");
  });

  it("refuses a clock that cannot say what time it is", () => {
    expect(() => normalizeYahooQuote(YAHOO_AAPL_QUOTE, {
      descriptor: EQUITY_DESCRIPTOR,
      clock: () => "never",
    })).toThrowError(/clock returning a valid date/u);
  });
});

describe("quote numeric coercion", () => {
  it.each([
    ["a boolean price", { regularMarketPrice: true }],
    ["a boolean previous close", { regularMarketPreviousClose: true }],
  ])("refuses to read %s as a number", (_label, patch) => {
    const raw = { ...YAHOO_AAPL_QUOTE, ...patch };
    if (patch.regularMarketPrice !== undefined) {
      expect(() => normalizeYahooQuote(raw, { descriptor: EQUITY_DESCRIPTOR, clock }))
        .toThrowError(/no valid observed value/u);
      return;
    }
    const result = normalizeYahooQuote(raw, { descriptor: EQUITY_DESCRIPTOR, clock });
    expect(result.previousClose).toBeNull();
  });

  it.each([
    ["a negative volume", { regularMarketVolume: -7 }],
    ["a boolean volume", { regularMarketVolume: true }],
  ])("does not publish %s", (_label, patch) => {
    const result = normalizeYahooQuote({ ...YAHOO_AAPL_QUOTE, ...patch }, {
      descriptor: EQUITY_DESCRIPTOR,
      clock,
    });

    expect(result.volume).toBeNull();
    expect(result.fieldAvailability.volume.status).not.toBe("available");
  });
});

describe("quote field availability", () => {
  it("drops a crossed order book rather than publishing it", () => {
    const result = normalize({ bid: 320, ask: 310 });

    expect(result.bid).toBeNull();
    expect(result.ask).toBeNull();
    expect(result.fieldAvailability.bid).toEqual({
      status: "invalid",
      reason: "crossed_provider_book",
    });
    expect(result.dataQuality.issues.map(({ code }) => code))
      .toContain("missing_optional_field");
  });

  it("keeps a coherent order book", () => {
    const result = normalize({ bid: 310, ask: 320 });
    expect(result.fieldAvailability.bid).toEqual({ status: "available" });
  });

  it("reports a field the provider omitted as temporarily unavailable", () => {
    const result = normalize({ regularMarketOpen: null });
    expect(result.fieldAvailability.open).toEqual({ status: "temporarily_unavailable" });
  });

  it("derives change and percent from the previous close", () => {
    const result = normalize({
      regularMarketChange: null,
      regularMarketChangePercent: null,
    });

    expect(result.change).toBeCloseTo(317.31 - 315.32, 6);
    expect(result.changePercent).toBeCloseTo(((317.31 - 315.32) / 315.32) * 100, 6);
    expect(result.dataQuality.issues.filter(({ code }) => code === "derived_from_previous_close"))
      .toHaveLength(2);
  });

  it("leaves change unset when there is no previous close to derive it from", () => {
    const result = normalize({
      regularMarketChange: null,
      regularMarketChangePercent: null,
      regularMarketPreviousClose: null,
    });
    expect(result.change).toBeNull();
    expect(result.changePercent).toBeNull();
  });

  it("does not divide by a zero previous close", () => {
    const result = normalize({
      regularMarketChange: null,
      regularMarketChangePercent: null,
      regularMarketPreviousClose: 0,
    });
    expect(result.changePercent).toBeNull();
  });

  it("marks an ETF's absent order book not applicable", () => {
    const result = normalizeYahooQuote(
      { ...RAW_QUOTE_SPY, bid: null, ask: null },
      { descriptor: ETF_DESCRIPTOR, clock },
    );
    expect(["not_applicable", "temporarily_unavailable"])
      .toContain(result.fieldAvailability.bid.status);
  });
});

describe("v2 quote currency", () => {
  const payloadWithoutCurrency = { ...YAHOO_AAPL_QUOTE };
  delete payloadWithoutCurrency.currency;

  it.each([
    ["the payload omits a currency", payloadWithoutCurrency],
    ["the payload reports a different one", { ...YAHOO_AAPL_QUOTE, currency: "USD" }],
  ])("labels the quote with the instrument currency when %s", (_label, raw) => {
    const result = normalizeYahooQuote(raw, { descriptor: NON_US_EQUITY_DESCRIPTOR, clock });

    expect(result.currency).toBe(NON_US_EQUITY_DESCRIPTOR.currency);
    expect(result.currency).toBe("EUR");
  });
});

describe("history row hygiene", () => {
  it.each([
    ["a row with no readable timestamp", { ...bar(1), date: null }],
    ["a row that is not an object at all", null],
  ])("drops %s", (_label, row) => {
    const series = history([...healthy(), row]);

    expect(series.bars).toHaveLength(6);
    expect(series.dataQuality.droppedRows).toBe(1);
    expect(series.dataQuality.issues.map(({ code }) => code))
      .toContain("row_dropped_invalid_timestamp");
  });

  it("drops a repeated timestamp, naming the session it was dropped from", () => {
    const series = history([...healthy(), bar(1), bar(1)]);
    const duplicate = series.dataQuality.issues
      .find(({ code }) => code === "duplicate_timestamp");

    expect(series.bars).toHaveLength(7);
    expect(duplicate).toBeDefined();
    expect(duplicate.timestamp).toBe(series.bars.find(({ timestamp }) => (
      timestamp === duplicate.timestamp
    ))?.timestamp);
    expect(typeof duplicate.timestamp).toBe("string");
  });

  it("names the session an invalid row was dropped from, and leaves an unreadable one unplaced", () => {
    const invalidOhlc = history([...healthy(), { ...bar(9), close: null }]);
    const dropped = invalidOhlc.dataQuality.issues
      .find(({ code }) => code === "row_dropped_invalid_ohlc");
    expect(typeof dropped?.timestamp).toBe("string");

    const unreadable = history([...healthy(), { ...bar(9), date: null }]);
    const unplaced = unreadable.dataQuality.issues
      .find(({ code }) => code === "row_dropped_invalid_timestamp");
    expect(unplaced).toBeDefined();
    expect(unplaced.timestamp).toBeUndefined();
  });

  it.each([
    ["a missing close", { close: null }],
    ["a non-positive open", { open: 0 }],
    ["a high below the open", { high: 1 }],
    ["a low above the close", { low: 500 }],
  ])("drops a row with %s", (_label, patch) => {
    const series = history([...healthy(), bar(1, patch)]);

    expect(series.bars).toHaveLength(6);
    expect(series.dataQuality.issues.map(({ code }) => code))
      .toContain("row_dropped_invalid_ohlc");
  });

  it("flags a negative volume without dropping the bar", () => {
    const series = history([bar(2), bar(1, { volume: -1 })]);
    const flagged = series.bars.at(-1);

    expect(series.bars).toHaveLength(2);
    expect(flagged.volume).toBeNull();
    expect(flagged.fieldAvailability.volume).toMatchObject({
      status: "invalid",
      reason: "negative_provider_volume",
    });
  });

  it("keeps a genuine zero-volume equity session", () => {
    const series = history([bar(2), bar(1, { volume: 0 })]);
    expect(series.bars.at(-1).volume).toBe(0);
  });

  it("reports a volume the provider omitted as temporarily unavailable", () => {
    const series = history([bar(2), bar(1, { volume: null })]);
    expect(series.bars.at(-1).fieldAvailability.volume)
      .toEqual({ status: "temporarily_unavailable" });
  });

  it("reads a row that carries a timestamp instead of a date", () => {
    const { date, ...rest } = bar(1);
    const series = history([{ ...rest, timestamp: date }]);
    expect(series.bars).toHaveLength(1);
  });
});

describe("history semantics", () => {
  it("refuses a price basis the asset policy does not offer", () => {
    const error = thrown(() => history([bar(1)], { priceBasis: "gross" }));
    expect(error.code).toBe(ERROR_CODES.UNSUPPORTED_SEMANTICS);
    expect(error.details.requestedPriceBasis).toBe("gross");
  });

  it.each([
    ["a payload that is not an object", null, EQUITY_DESCRIPTOR, "XNAS:AAPL"],
    ["a payload that is a string", "chart", EQUITY_DESCRIPTOR, "XNAS:AAPL"],
    ["a payload that carries no quotes array", { meta: {} }, EQUITY_DESCRIPTOR, "XNAS:AAPL"],
    ["a descriptor with no id", chart([bar(1)]), {}, null],
    ["no descriptor at all", chart([bar(1)]), undefined, null],
  ])("rejects %s", (_label, raw, descriptor, instrumentId) => {
    const error = thrown(() => normalizeYahooHistory(raw, {
      descriptor,
      range: "1y",
      interval: "1d",
      priceBasis: "raw",
      clock,
    }));

    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.capability).toBe("history");
    expect(error.message).toMatch(/invalid chart payload/u);
    expect(error.instrumentId).toBe(instrumentId);
  });

  it("keeps every coherent bar when nothing is wrong", () => {
    const series = history([bar(3), bar(2), bar(1)]);
    expect(series.bars).toHaveLength(3);
    expect(series.dataQuality.droppedRows).toBe(0);
    expect(series.asOf).toBe(series.bars.at(-1).timestamp);
  });
});

describe("details rejection", () => {
  it.each([
    ["a non-object payload", null, EQUITY_DESCRIPTOR],
    ["a payload that is a string", "details", EQUITY_DESCRIPTOR],
    ["a descriptor with no id", {}, {}],
  ])("rejects %s", (_label, raw, descriptor) => {
    const error = thrown(() => normalizeYahooDetails(raw, { descriptor, clock }));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.capability).toBe("details");
  });

  it("reports every company section as temporarily unavailable when no module carries a value", () => {
    const result = normalizeYahooDetails({}, { descriptor: EQUITY_DESCRIPTOR, clock });

    expect(result.instrument).toBe(EQUITY_DESCRIPTOR);
    expect(result.sections).toEqual([
      { id: "company_profile", status: "temporarily_unavailable", fields: {}, fieldAvailability: {} },
      { id: "equity_fundamentals", status: "temporarily_unavailable", fields: {}, fieldAvailability: {} },
      { id: "analyst_outlook", status: "temporarily_unavailable", fields: {}, fieldAvailability: {} },
    ]);
  });

  it("reads the summary profile when the asset profile is absent", () => {
    const result = normalizeYahooDetails(
      {
        summaryProfile: {
          country: "IE",
          sector: "Industrials",
          industry: "Aerospace",
          website: "https://example.test",
          fullTimeEmployees: 1_200,
        },
      },
      { descriptor: EQUITY_DESCRIPTOR, clock },
    );

    expect(result.sections.find(({ id }) => id === "company_profile")).toEqual({
      id: "company_profile",
      status: "available",
      fields: {
        sector: "Industrials",
        industry: "Aerospace",
        country: "IE",
        website: "https://example.test",
        employees: 1_200,
      },
      fieldAvailability: {},
    });
  });

  it("unwraps Yahoo's raw and formatted value wrappers", () => {
    const result = normalizeYahooDetails(
      { summaryDetail: { marketCap: { raw: 3_000_000_000_000, fmt: "3T" } } },
      { descriptor: EQUITY_DESCRIPTOR, clock },
    );
    expect(result.sections.length).toBeGreaterThan(0);
  });
});
