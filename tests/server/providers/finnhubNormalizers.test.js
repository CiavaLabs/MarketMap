import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import {
  normalizeFinnhubNews,
  normalizeFinnhubNewsArticle,
  normalizeFinnhubQuote,
} from "../../../server/providers/finnhub/normalizers.js";
import { EQUITY_DESCRIPTOR } from "../fixtures/market/descriptors.js";
import {
  FINNHUB_AAPL_QUOTE,
} from "./fixtures/finnhub.js";
import { FIXED_NOW } from "./fixtures/yahoo.js";

const catalog = new InstrumentCatalog();
const INSTRUMENT = catalog.resolve("AAPL");
const clock = () => FIXED_NOW;

function thrown(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("finnhub v2 quote normalization", () => {
  const options = { descriptor: EQUITY_DESCRIPTOR, clock };

  it("stamps the snapshot with the provider trade time and the descriptor's currency", () => {
    const quote = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, options);
    expect(quote.asOf).toBe(new Date(FINNHUB_AAPL_QUOTE.t * 1_000).toISOString());
    expect(quote.fetchedAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(quote.currency).toBe("USD");
    const inEuros = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, {
      ...options,
      descriptor: { ...EQUITY_DESCRIPTOR, currency: "EUR" },
    });
    expect(inEuros.currency).toBe("EUR");
  });

  it.each([
    ["omits the trade time", null],
    ["sends a zero trade time", 0],
  ])("falls back to the fetch time when the provider %s", (_label, t) => {
    const quote = normalizeFinnhubQuote({ ...FINNHUB_AAPL_QUOTE, t }, options);
    expect(quote.fetchedAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(quote.asOf).toBe(quote.fetchedAt);
  });

  it("derives change and percent from the previous close when the provider omits them", () => {
    const derived = normalizeFinnhubQuote({ ...FINNHUB_AAPL_QUOTE, d: null, dp: null }, options);
    expect(derived.change).toBeCloseTo(317.31 - 315.32, 10);
    expect(derived.changePercent).toBeCloseTo(((317.31 - 315.32) / 315.32) * 100, 10);
    const fromProviderChange = normalizeFinnhubQuote({ ...FINNHUB_AAPL_QUOTE, d: 4, dp: null }, options);
    expect(fromProviderChange.change).toBe(4);
    expect(fromProviderChange.changePercent).toBeCloseTo((4 / 315.32) * 100, 10);
  });


  it("marks the snapshot as a fallback and reports unsupported fields", () => {
    const quote = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, options);
    expect(quote.provenance).toMatchObject({
      source: "finnhub",
      providerSymbol: "AAPL",
      fallback: true,
      fallbackFrom: "yahoo",
      fallbackReason: "upstream_unavailable",
      semanticMatch: "raw_quote",
    });
    expect(quote.fieldAvailability.volume).toEqual({
      status: "unsupported",
      reason: "provider_does_not_expose",
    });
    expect(quote.fieldAvailability.open).toEqual({ status: "available" });
  });

  it("marks derivable fields the provider omitted as temporarily unavailable", () => {
    const quote = normalizeFinnhubQuote(
      { ...FINNHUB_AAPL_QUOTE, o: null, pc: null, d: null, dp: null, h: null, l: null },
      options,
    );
    expect(quote.fieldAvailability.open).toEqual({ status: "temporarily_unavailable" });
    expect(quote.fieldAvailability.change).toEqual({ status: "temporarily_unavailable" });
    expect(quote.changePercent).toBeNull();
  });

  it("normalizes an unrecognised fallback origin and provenance labels", () => {
    const quote = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, {
      ...options,
      fallbackFrom: "somewhere-else",
      fallbackReason: "  RATE_Limited  ",
      semanticMatch: "!!invalid!!",
    });
    expect(quote.provenance).toMatchObject({
      fallbackFrom: "yahoo",
      fallbackReason: "rate_limited",
      semanticMatch: "raw_quote",
    });
  });

  it.each([
    ["a non-object payload", "quote", options, "XNAS:AAPL"],
    ["an array payload", [], options, "XNAS:AAPL"],
    ["a descriptor without an ID", FINNHUB_AAPL_QUOTE, { clock }, null],
    ["a descriptor without a finnhub symbol", FINNHUB_AAPL_QUOTE, {
      clock,
      descriptor: { ...EQUITY_DESCRIPTOR, providerSymbols: {} },
    }, "XNAS:AAPL"],
  ])("rejects %s", (_label, raw, callOptions, instrumentId) => {
    const error = thrown(() => normalizeFinnhubQuote(raw, callOptions));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.instrumentId).toBe(instrumentId);
  });

  it("rejects a missing, negative or unreadable quote value", () => {
    const { c, ...withoutValue } = FINNHUB_AAPL_QUOTE;
    const payloads = [
      withoutValue,
      ...[null, -2, "n/a"].map((value) => ({ ...FINNHUB_AAPL_QUOTE, c: value })),
    ];
    for (const raw of payloads) {
      const error = thrown(() => normalizeFinnhubQuote(raw, options));
      expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    }
  });

  it("reports a zero quote value as an unknown instrument", () => {
    const error = thrown(() => normalizeFinnhubQuote({ ...FINNHUB_AAPL_QUOTE, c: 0 }, options));
    expect(error.code).toBe(ERROR_CODES.INSTRUMENT_NOT_FOUND);
  });

  it("rejects a day high below the day low", () => {
    const error = thrown(() => normalizeFinnhubQuote(
      { ...FINNHUB_AAPL_QUOTE, h: 10, l: 20 },
      options,
    ));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.details).toEqual({ dayHigh: 10, dayLow: 20 });
  });

  it("accepts a clock object exposing now()", () => {
    const quote = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, {
      ...options,
      clock: { now: () => FIXED_NOW },
    });
    expect(quote.fetchedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("accepts a Date-returning clock and falls back to the wall clock otherwise", () => {
    const dated = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, {
      ...options,
      clock: () => new Date(FIXED_NOW),
    });
    expect(dated.fetchedAt).toBe(new Date(FIXED_NOW).toISOString());
    const before = Date.now();
    const walled = normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, { ...options, clock: "not-a-clock" });
    expect(Date.parse(walled.fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(walled.fetchedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a clock that does not produce a valid date", () => {
    expect(() => normalizeFinnhubQuote(FINNHUB_AAPL_QUOTE, {
      ...options,
      clock: () => "never",
    })).toThrowError(TypeError);
  });
});

describe("finnhub news normalization", () => {
  const article = (patch = {}) => ({
    id: 5001,
    headline: "Apple ships a thing",
    source: "Reuters",
    url: "https://news.example.test/apple-ships",
    datetime: FIXED_NOW / 1_000 - 3_600,
    ...patch,
  });

  it("namespaces the article and attaches the instrument", () => {
    const normalized = normalizeFinnhubNewsArticle(article(), { instrument: INSTRUMENT, clock });
    expect(normalized).toMatchObject({
      id: "finnhub:5001",
      title: "Apple ships a thing",
      publisher: "Reuters",
      instrumentIds: ["XNAS:AAPL"],
      provider: "finnhub",
    });
  });

  it.each([
    ["a non-object row", null, { instrument: INSTRUMENT }],
    ["a row with no instrument", article(), {}],
    ["a row without an ID", article({ id: null }), { instrument: INSTRUMENT }],
    ["a row without a headline", article({ headline: "   " }), { instrument: INSTRUMENT }],
    ["a row without a publisher", article({ source: null }), { instrument: INSTRUMENT }],
    ["a row without a usable URL", article({ url: "http://insecure.example.test/a" }), { instrument: INSTRUMENT }],
    ["a row without a timestamp", article({ datetime: null }), { instrument: INSTRUMENT }],
    ["a row published outside the window", article({ datetime: FIXED_NOW / 1_000 - 30 * 86_400 }), { instrument: INSTRUMENT }],
    ["a row dated in the future", article({ datetime: FIXED_NOW / 1_000 + 86_400 }), { instrument: INSTRUMENT }],
  ])("drops %s", (_label, raw, options) => {
    expect(normalizeFinnhubNewsArticle(raw, { ...options, clock })).toBeNull();
  });

  it("drops an article the news contract rejects", () => {
    const instrument = { ...INSTRUMENT, id: "not-canonical" };
    expect(normalizeFinnhubNewsArticle(article(), { instrument, clock })).toBeNull();
  });

  it("builds a feed, drops unusable rows and caps the provider limit", () => {
    const rows = Array.from({ length: 12 }, (_, index) => article({
      id: 6000 + index,
      url: `https://news.example.test/item-${index}`,
      datetime: FIXED_NOW / 1_000 - index * 600,
    }));
    const feed = normalizeFinnhubNews([...rows, null, article({ headline: null })], {
      instrument: INSTRUMENT,
      clock,
    });
    expect(feed.articles).toHaveLength(8);
    expect(feed).toMatchObject({ instrumentId: "XNAS:AAPL", source: "finnhub", quality: "fresh" });
    expect(feed.asOf).toBe(feed.articles[0].publishedAt);
  });

  it("stamps an empty feed with the fetch time", () => {
    const feed = normalizeFinnhubNews([], { instrument: INSTRUMENT, clock });
    expect(feed.articles).toEqual([]);
    expect(feed.asOf).toBe(feed.fetchedAt);
  });

  it("rejects a feed with no instrument and a non-array payload", () => {
    expect(thrown(() => normalizeFinnhubNews([], { clock })).code).toBe(ERROR_CODES.SCHEMA_INVALID);
    const error = thrown(() => normalizeFinnhubNews({ news: [] }, { instrument: INSTRUMENT, clock }));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
  });

  it("reports a feed the news contract rejects", () => {
    const instrument = { ...INSTRUMENT, id: "XNAS:AAPL " };
    const error = thrown(() => normalizeFinnhubNews([], { instrument, clock }));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(error.message).toContain("failed validation");
  });
});
