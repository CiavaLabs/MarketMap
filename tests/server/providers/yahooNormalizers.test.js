import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import {
  clockTimestamp,
  finiteOrNull,
  normalizeYahooNews,
  normalizeYahooNewsArticle,
  toIsoTimestamp,
} from "../../../server/providers/yahoo/normalizers.js";
import {
  FIXED_NOW,
} from "./fixtures/yahoo.js";

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

describe("yahoo scalar helpers", () => {
  it("unwraps the raw form Yahoo wraps numbers in", () => {
    expect(finiteOrNull({ raw: 12.5, fmt: "12.50" })).toBe(12.5);
    expect(finiteOrNull({ raw: null })).toBeNull();
    expect(toIsoTimestamp({ raw: 1_784_061_540 })).toBe("2026-07-14T20:39:00.000Z");
  });


  it("accepts a function clock, a now() clock and neither", () => {
    const expected = new Date(FIXED_NOW).toISOString();
    expect(clockTimestamp(() => FIXED_NOW)).toBe(expected);
    expect(clockTimestamp(() => new Date(FIXED_NOW))).toBe(expected);
    expect(clockTimestamp({ now: () => FIXED_NOW })).toBe(expected);
    expect(Number.isFinite(Date.parse(clockTimestamp("nonsense")))).toBe(true);
  });

  it("rejects a clock that does not produce a valid date", () => {
    expect(() => clockTimestamp(() => "never")).toThrowError(TypeError);
  });
});

describe("yahoo news normalization", () => {
  const article = (patch = {}) => ({
    uuid: "aapl-story",
    title: "Apple ships a thing",
    publisher: "Reuters",
    link: "https://news.example.test/apple-ships",
    providerPublishTime: new Date(FIXED_NOW - 3_600_000),
    ...patch,
  });

  it("resolves related tickers into canonical instrument IDs", () => {
    const normalized = normalizeYahooNewsArticle(
      article({ relatedTickers: ["MSFT", "AAPL", "  ", "UNKNOWN-TICKER"] }),
      {
        instrument: INSTRUMENT,
        resolveProviderSymbol: (symbol) => catalog.resolveByProviderSymbol(symbol)?.id || null,
        clock,
      },
    );
    expect(normalized.instrumentIds).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("keeps only the instrument itself without related tickers", () => {
    const normalized = normalizeYahooNewsArticle(article(), {
      instrument: INSTRUMENT,
      catalog,
      clock,
    });
    expect(normalized.instrumentIds).toEqual(["XNAS:AAPL"]);
    expect(normalized.id).toBe("yahoo:aapl-story");
  });

  it("survives a catalog that throws on a related ticker", () => {
    const angry = { resolve: () => { throw new Error("catalog offline"); } };
    const normalized = normalizeYahooNewsArticle(article({ relatedTickers: ["MSFT"] }), {
      instrument: INSTRUMENT,
      catalog: angry,
      clock,
    });
    expect(normalized.instrumentIds).toEqual(["XNAS:AAPL"]);
  });

  it.each([
    ["a non-object row", null, { instrument: INSTRUMENT }],
    ["a row with no instrument", article(), {}],
    ["a row without a UUID", article({ uuid: null }), { instrument: INSTRUMENT }],
    ["a row without a title", article({ title: "  " }), { instrument: INSTRUMENT }],
    ["a row without a publisher", article({ publisher: null }), { instrument: INSTRUMENT }],
    ["a row without a usable link", article({ link: "javascript:void(0)" }), { instrument: INSTRUMENT }],
    ["a row without a publish time", article({ providerPublishTime: null }), { instrument: INSTRUMENT }],
    ["a row outside the news window", article({
      providerPublishTime: new Date(FIXED_NOW - 30 * 86_400_000),
    }), { instrument: INSTRUMENT }],
  ])("drops %s", (_label, raw, options) => {
    expect(normalizeYahooNewsArticle(raw, { ...options, catalog, clock })).toBeNull();
  });

  it("drops an article the news contract rejects", () => {
    const instrument = { ...INSTRUMENT, id: "not-canonical" };
    expect(normalizeYahooNewsArticle(article(), { instrument, catalog, clock })).toBeNull();
  });

  it("accepts both a bare array and the wrapped news payload", () => {
    const rows = [article(), article({ uuid: "second", link: "https://news.example.test/second" })];
    const fromArray = normalizeYahooNews(rows, { instrument: INSTRUMENT, catalog, clock });
    const fromObject = normalizeYahooNews({ news: rows }, { instrument: INSTRUMENT, catalog, clock });
    expect(fromArray.articles).toHaveLength(2);
    expect(fromObject.articles).toHaveLength(2);
    expect(fromArray.asOf).toBe(fromArray.articles[0].publishedAt);
  });

  it("caps the feed at the provider limit", () => {
    const rows = Array.from({ length: 11 }, (_, index) => article({
      uuid: `story-${index}`,
      link: `https://news.example.test/story-${index}`,
      providerPublishTime: new Date(FIXED_NOW - index * 600_000),
    }));
    expect(normalizeYahooNews(rows, { instrument: INSTRUMENT, catalog, clock }).articles)
      .toHaveLength(8);
  });

  it("stamps an empty feed with the fetch time", () => {
    const feed = normalizeYahooNews([], { instrument: INSTRUMENT, catalog, clock });
    expect(feed.asOf).toBe(feed.fetchedAt);
  });

  it.each([
    ["no instrument", [], {}],
    ["a payload that is neither an array nor a news envelope", { items: [] }, { instrument: INSTRUMENT }],
  ])("rejects a feed with %s", (_label, payload, options) => {
    const error = thrown(() => normalizeYahooNews(payload, { ...options, catalog, clock }));
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
  });

  it("reports a feed the news contract rejects", () => {
    const instrument = { ...INSTRUMENT, id: "XNAS:AAPL " };
    const error = thrown(() => normalizeYahooNews([], { instrument, catalog, clock }));
    expect(error.message).toContain("failed validation");
  });
});
