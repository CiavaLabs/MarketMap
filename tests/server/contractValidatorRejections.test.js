import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import {
  isBar,
  isInstrument,
  isMetric,
  isNewsArticle,
  isNewsBatchResponse,
  isNewsFeed,
  isQuoteSnapshot,
  isIsoTimestamp,
  validateBar,
  validateBars,
  validateInstrument,
  validateMetric,
  validateNewsArticle,
  validateNewsBatchResponse,
  validateNewsFeed,
  validateQuoteSnapshot,
} from "../../server/contracts/core/validators.js";

const NOW = Date.parse("2026-07-13T20:00:00.000Z");
const clock = () => NOW;

const INSTRUMENT = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  status: "active",
  exchange: "Nasdaq",
  mic: "XNAS",
  currency: "USD",
  country: "US",
  category: "Common Stock",
  sector: "Technology",
});

const QUOTE = Object.freeze({
  instrumentId: "XNAS:AAPL",
  price: 317.31,
  change: 1.99,
  changePercent: 0.63,
  open: 317.01,
  previousClose: 315.32,
  dayHigh: 323.45,
  dayLow: 315.78,
  bid: 316.03,
  ask: 317.96,
  volume: 41_376_714,
  averageVolume3m: 54_682_654,
  marketState: "regular",
  asOf: "2026-07-13T19:59:00.000Z",
  fetchedAt: "2026-07-13T20:00:00.000Z",
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
});

const METRIC = Object.freeze({
  id: "market_cap",
  value: 4_740_000_000_000,
  unit: "currency",
  period: "instant",
  asOf: "2026-07-13T20:00:00.000Z",
  source: "yahoo",
  quality: "fresh",
});

const BAR = Object.freeze({
  timestamp: "2026-07-13T20:00:00.000Z",
  open: 315,
  high: 320,
  low: 314,
  close: 318,
  volume: 1_000,
  adjustedClose: 318,
  source: "yahoo",
  quality: "fresh",
});

const ARTICLE = Object.freeze({
  id: "yahoo:story-1",
  title: "Apple ships a thing",
  publisher: "Reuters",
  url: "https://news.example.test/apple-ships",
  publishedAt: "2026-07-13T19:00:00.000Z",
  instrumentIds: ["XNAS:AAPL"],
  provider: "yahoo",
});

const FEED = Object.freeze({
  instrumentId: "XNAS:AAPL",
  articles: [ARTICLE],
  source: "yahoo",
  quality: "fresh",
  asOf: ARTICLE.publishedAt,
  fetchedAt: "2026-07-13T20:00:00.000Z",
});

function paths(validate, subject, mutate, options = {}) {
  const candidate = structuredClone(subject);
  mutate(candidate);
  try {
    validate(candidate, { clock, ...options });
  } catch (error) {
    expect(error.code).toBe(options.code || ERROR_CODES.SCHEMA_INVALID);
    return error.details.issues.map((entry) => entry.path);
  }
  return [];
}

describe("ISO timestamp recognition", () => {
  it.each([
    ["2026-07-13T20:00:00.000Z", true],
    ["2026-07-13T20:00:00Z", true],
    ["2026-07-13T20:00:00+02:00", true],
    ["2026-07-13", false],
    ["2026-07-13 20:00:00Z", false],
    ["2026-13-13T20:00:00.000Z", false],
    [1_784_061_540_000, false],
    [null, false],
  ])("reads %s as %s", (value, expected) => {
    expect(isIsoTimestamp(value)).toBe(expected);
  });
});

describe("instrument validation", () => {
  it("accepts a catalog instrument and returns it unchanged", () => {
    expect(validateInstrument(INSTRUMENT)).toBe(INSTRUMENT);
    expect(isInstrument(INSTRUMENT)).toBe(true);
  });

  it("accepts an instrument with no optional descriptive fields", () => {
    const bare = {
      id: "XNAS:AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      assetClass: "equity",
      status: "active",
    };
    expect(validateInstrument(bare)).toBe(bare);
  });

  it.each([
    ["a non-object", (i) => { Object.keys(i).forEach((key) => delete i[key]); }, "instrument.id"],
    ["a blank id", (i) => { i.id = "  "; }, "instrument.id"],
    ["a missing symbol", (i) => { delete i.symbol; }, "instrument.symbol"],
    ["a blank name", (i) => { i.name = ""; }, "instrument.name"],
    ["an unsupported asset class", (i) => { i.assetClass = "warrant"; }, "instrument.assetClass"],
    ["an unsupported status", (i) => { i.status = "halted"; }, "instrument.status"],
    ["a blank exchange", (i) => { i.exchange = "   "; }, "instrument.exchange"],
    ["a numeric mic", (i) => { i.mic = 1234; }, "instrument.mic"],
    ["a blank sector", (i) => { i.sector = ""; }, "instrument.sector"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateInstrument, INSTRUMENT, mutate)).toContain(path);
  });

  it("rejects a value that is not an object at all", () => {
    expect(() => validateInstrument([])).toThrowError(/failed runtime validation/u);
    expect(isInstrument(null)).toBe(false);
  });

  it("reports issues under a caller-supplied path and error code", () => {
    const issues = paths(
      validateInstrument,
      INSTRUMENT,
      (i) => { i.status = "halted"; },
      { path: "row", code: ERROR_CODES.INVALID_REQUEST },
    );
    expect(issues).toContain("row.status");
  });
});

describe("quote snapshot validation", () => {
  it("accepts a normalized quote", () => {
    expect(validateQuoteSnapshot(QUOTE)).toBe(QUOTE);
    expect(isQuoteSnapshot(QUOTE)).toBe(true);
  });

  it("accepts null for every optional numeric field", () => {
    const sparse = { ...QUOTE };
    for (const key of ["change", "changePercent", "open", "previousClose", "dayHigh", "dayLow", "bid", "ask", "volume", "averageVolume3m"]) {
      sparse[key] = null;
    }
    sparse.currency = null;
    expect(validateQuoteSnapshot(sparse)).toBe(sparse);
  });

  it.each([
    ["a missing instrument ID", (q) => { delete q.instrumentId; }, "quote.instrumentId"],
    ["a missing price key", (q) => { delete q.price; }, "quote.price"],
    ["a non-finite price", (q) => { q.price = Number.NaN; }, "quote.price"],
    ["a string change", (q) => { q.change = "1.99"; }, "quote.change"],
    ["a negative volume", (q) => { q.volume = -1; }, "quote.volume"],
    ["a negative average volume", (q) => { q.averageVolume3m = -1; }, "quote.averageVolume3m"],
    ["an unsupported market state", (q) => { q.marketState = "auction"; }, "quote.marketState"],
    ["a non-ISO asOf", (q) => { q.asOf = "2026-07-13"; }, "quote.asOf"],
    ["a non-ISO fetchedAt", (q) => { q.fetchedAt = null; }, "quote.fetchedAt"],
    ["a blank currency", (q) => { q.currency = "  "; }, "quote.currency"],
    ["an unsupported quality", (q) => { q.quality = "cached"; }, "quote.quality"],
    ["an unsupported source", (q) => { q.source = "bloomberg"; }, "quote.source"],
    ["a day high below the day low", (q) => { q.dayHigh = 10; q.dayLow = 20; }, "quote.dayHigh"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateQuoteSnapshot, QUOTE, mutate)).toContain(path);
  });
});

describe("metric validation", () => {
  it("accepts numeric, string and null metric values", () => {
    expect(validateMetric(METRIC)).toBe(METRIC);
    expect(isMetric({ ...METRIC, value: "buy", unit: "text" })).toBe(true);
    expect(isMetric({ ...METRIC, value: null })).toBe(true);
  });

  it("accepts a metric with no period, asOf or formula version", () => {
    const bare = { id: "beta", value: 1.2, unit: "ratio", source: "derived", quality: "fresh" };
    expect(validateMetric(bare)).toBe(bare);
  });

  it.each([
    ["a blank id", (m) => { m.id = ""; }, "metric.id"],
    ["a boolean value", (m) => { m.value = true; }, "metric.value"],
    ["a non-finite value", (m) => { m.value = Number.POSITIVE_INFINITY; }, "metric.value"],
    ["an unsupported unit", (m) => { m.unit = "furlongs"; }, "metric.unit"],
    ["an unsupported source", (m) => { m.source = "guesswork"; }, "metric.source"],
    ["an unsupported quality", (m) => { m.quality = "cached"; }, "metric.quality"],
    ["an unsupported period", (m) => { m.period = "decade"; }, "metric.period"],
    ["a non-ISO asOf", (m) => { m.asOf = "yesterday"; }, "metric.asOf"],
    ["a blank formula version", (m) => { m.formulaVersion = "  "; }, "metric.formulaVersion"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateMetric, METRIC, mutate)).toContain(path);
  });
});

describe("bar validation", () => {
  it("accepts a complete bar and one with only the required fields", () => {
    expect(validateBar(BAR)).toBe(BAR);
    const bare = { timestamp: BAR.timestamp, open: 1, high: 2, low: 1, close: 2, volume: null };
    expect(validateBar(bare)).toBe(bare);
    expect(isBar(BAR)).toBe(true);
  });

  it.each([
    ["a non-ISO timestamp", (b) => { b.timestamp = "2026-07-13"; }, "bar.timestamp"],
    ["a non-finite open", (b) => { b.open = null; }, "bar.open"],
    ["a string close", (b) => { b.close = "318"; }, "bar.close"],
    ["a negative volume", (b) => { b.volume = -1; }, "bar.volume"],
    ["a non-finite adjusted close", (b) => { b.adjustedClose = "318"; }, "bar.adjustedClose"],
    ["an unsupported source", (b) => { b.source = "bloomberg"; }, "bar.source"],
    ["an unsupported quality", (b) => { b.quality = "cached"; }, "bar.quality"],
    ["a high below the open", (b) => { b.high = 100; }, "bar.high"],
    ["a low above the close", (b) => { b.low = 400; }, "bar.low"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateBar, BAR, mutate)).toContain(path);
  });

  it("accepts a null adjusted close", () => {
    const bar = { ...BAR, adjustedClose: null };
    expect(validateBar(bar)).toBe(bar);
  });
});

describe("bar list validation", () => {
  const later = { ...BAR, timestamp: "2026-07-14T20:00:00.000Z" };

  it("accepts a strictly ascending series", () => {
    const bars = [BAR, later];
    expect(validateBars(bars)).toBe(bars);
    expect(validateBars([])).toEqual([]);
  });

  it("rejects a value that is not an array", () => {
    try {
      validateBars("bars");
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error.details.issues).toEqual([{ path: "bars", message: "must be an array" }]);
    }
  });

  it.each([
    ["repeated timestamps", [BAR, { ...BAR }]],
    ["descending timestamps", [later, BAR]],
  ])("rejects %s", (_label, bars) => {
    expect(() => validateBars(bars)).toThrowError(/failed runtime validation/u);
  });

  it("reports the offending index under the caller's path", () => {
    try {
      validateBars([BAR, BAR], { path: "history.bars" });
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error.details.issues[0].path).toBe("history.bars[1].timestamp");
    }
  });

  it("surfaces a malformed bar from inside the list", () => {
    try {
      validateBars([{ ...BAR, open: null }]);
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error.details.issues[0].path).toBe("bars[0].open");
    }
  });
});

describe("news article validation", () => {
  it("accepts a normalized article", () => {
    expect(validateNewsArticle(ARTICLE, { clock })).toBe(ARTICLE);
    expect(isNewsArticle(ARTICLE)).toBe(true);
  });

  it.each([
    ["a blank id", (a) => { a.id = ""; }, "article.id"],
    ["an id not namespaced by provider", (a) => { a.id = "finnhub:1"; }, "article.id"],
    ["untrimmed title whitespace", (a) => { a.title = " Apple ships "; }, "article.title"],
    ["a double-spaced title", (a) => { a.title = "Apple  ships"; }, "article.title"],
    ["a title with a newline", (a) => { a.title = "Apple\nships"; }, "article.title"],
    ["markup in the title", (a) => { a.title = "Apple <b>ships</b>"; }, "article.title"],
    ["a blank publisher", (a) => { a.publisher = "   "; }, "article.publisher"],
    ["a non-HTTPS URL", (a) => { a.url = "http://news.example.test/a"; }, "article.url"],
    ["a URL with credentials", (a) => { a.url = "https://user:pass@news.example.test/a"; }, "article.url"],
    ["an unparseable URL", (a) => { a.url = "not-a-url"; }, "article.url"],
    ["a non-ISO publish time", (a) => { a.publishedAt = "2026-07-13"; }, "article.publishedAt"],
    ["a non-UTC publish time", (a) => { a.publishedAt = "2026-07-13T19:00:00.000+02:00"; }, "article.publishedAt"],
    ["a publish time in the future", (a) => { a.publishedAt = "2026-07-14T20:00:00.000Z"; }, "article.publishedAt"],
    ["no instrument IDs", (a) => { a.instrumentIds = []; }, "article.instrumentIds"],
    ["a malformed instrument ID", (a) => { a.instrumentIds = ["AAPL"]; }, "article.instrumentIds[0]"],
    ["duplicate instrument IDs", (a) => { a.instrumentIds = ["XNAS:AAPL", "XNAS:AAPL"]; }, "article.instrumentIds[1]"],
    ["an unsupported provider", (a) => { a.provider = "reuters"; }, "article.provider"],
    ["a body field", (a) => { a.body = "text"; }, "article.body"],
    ["a summary field", (a) => { a.summary = "text"; }, "article.summary"],
    ["an image field", (a) => { a.image = "https://images.example.test/a.jpg"; }, "article.image"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateNewsArticle, ARTICLE, mutate)).toContain(path);
  });

  it("honours a caller-supplied future tolerance", () => {
    const ahead = { ...ARTICLE, publishedAt: "2026-07-13T20:02:00.000Z" };
    expect(validateNewsArticle(ahead, { clock })).toBe(ahead);
    expect(paths(validateNewsArticle, ahead, () => {}, { futureToleranceMs: 0 }))
      .toContain("article.publishedAt");
  });

  it("accepts a Date-like clock and falls back when the clock is unreadable", () => {
    expect(validateNewsArticle(ARTICLE, { now: new Date(NOW) })).toBe(ARTICLE);
    expect(validateNewsArticle(ARTICLE, { now: { now: () => NOW } })).toBe(ARTICLE);
    expect(validateNewsArticle(ARTICLE, { now: "not-a-clock" })).toBe(ARTICLE);
  });
});

describe("news feed validation", () => {
  it("accepts a single-article feed", () => {
    expect(validateNewsFeed(FEED, { clock })).toBe(FEED);
    expect(isNewsFeed(FEED)).toBe(true);
  });

  it("accepts an empty feed stamped with its fetch time", () => {
    const empty = { ...FEED, articles: [], asOf: FEED.fetchedAt };
    expect(validateNewsFeed(empty, { clock })).toBe(empty);
  });

  it("accepts a last-known-good feed", () => {
    const stale = {
      ...FEED,
      source: "last-known-good",
      originalSource: "yahoo",
      quality: "stale",
    };
    expect(validateNewsFeed(stale, { clock })).toBe(stale);
  });

  it.each([
    ["a malformed instrument ID", (f) => { f.instrumentId = "AAPL"; }, "news.instrumentId"],
    ["articles that are not an array", (f) => { f.articles = null; }, "news.articles"],
    ["an unsupported source", (f) => { f.source = "reuters"; }, "news.source"],
    ["an unsupported quality", (f) => { f.quality = "cached"; }, "news.quality"],
    ["an asOf that does not match the newest article", (f) => {
      f.asOf = "2026-07-13T18:00:00.000Z";
    }, "news.asOf"],
    ["an article that does not carry the feed instrument", (f) => {
      f.articles[0].instrumentIds = ["XNAS:MSFT"];
    }, "news.articles[0].instrumentIds"],
    ["a malformed article", (f) => { f.articles[0].title = ""; }, "news.articles[0].title"],
    ["a stale quality on a provider feed", (f) => { f.quality = "stale"; }, "news.quality"],
    ["an originalSource on a provider feed", (f) => { f.originalSource = "yahoo"; }, "news.originalSource"],
    ["an article from another provider", (f) => { f.articles[0].provider = "finnhub"; }, "news.articles[0].provider"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateNewsFeed, FEED, mutate)).toContain(path);
  });

  it("rejects more articles than the provider limit allows", () => {
    const articles = Array.from({ length: 9 }, (_, index) => ({
      ...ARTICLE,
      id: `yahoo:story-${index}`,
      url: `https://news.example.test/story-${index}`,
      publishedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
    }));
    const feed = { ...FEED, articles, asOf: articles[0].publishedAt };
    expect(paths(validateNewsFeed, feed, () => {})).toContain("news.articles");
  });

  it("rejects articles that are not sorted newest first", () => {
    const older = { ...ARTICLE, id: "yahoo:story-2", url: "https://news.example.test/b", publishedAt: "2026-07-13T18:00:00.000Z" };
    const feed = { ...FEED, articles: [older, ARTICLE], asOf: older.publishedAt };
    expect(paths(validateNewsFeed, feed, () => {})).toContain("news.articles[1].publishedAt");
  });

  it("rejects a tie broken in the wrong ID order", () => {
    const first = { ...ARTICLE, id: "yahoo:story-9", url: "https://news.example.test/b" };
    const second = { ...ARTICLE, id: "yahoo:story-1" };
    const feed = { ...FEED, articles: [first, second], asOf: first.publishedAt };
    expect(paths(validateNewsFeed, feed, () => {})).toContain("news.articles[1].publishedAt");
  });

  it("rejects duplicate article IDs and URLs", () => {
    const duplicateId = {
      ...FEED,
      articles: [ARTICLE, { ...ARTICLE, url: "https://news.example.test/other" }],
    };
    expect(paths(validateNewsFeed, duplicateId, () => {})).toContain("news.articles[1].id");

    const duplicateUrl = {
      ...FEED,
      articles: [ARTICLE, { ...ARTICLE, id: "yahoo:story-2", url: `${ARTICLE.url}#comments` }],
    };
    expect(paths(validateNewsFeed, duplicateUrl, () => {})).toContain("news.articles[1].url");
  });

  it.each([
    ["an unknown original source", (f) => { f.originalSource = "reuters"; }, "news.originalSource"],
    ["a fresh quality", (f) => { f.quality = "fresh"; }, "news.quality"],
  ])("rejects a last-known-good feed with %s", (_label, mutate, path) => {
    const stale = {
      ...FEED,
      source: "last-known-good",
      originalSource: "yahoo",
      quality: "stale",
    };
    expect(paths(validateNewsFeed, stale, mutate)).toContain(path);
  });

  it("rejects a value that is not an object", () => {
    expect(() => validateNewsFeed([], { clock })).toThrowError(/failed runtime validation/u);
  });
});

describe("news batch response validation", () => {
  const BATCH = Object.freeze({
    data: { articles: [ARTICLE] },
    errors: [],
    sources: { news: ["yahoo"] },
    nextRefreshAt: "2026-07-13T20:05:00.000Z",
    lastUpdatedAt: "2026-07-13T20:00:00.000Z",
  });

  it("accepts a batch and a bare articles envelope", () => {
    expect(validateNewsBatchResponse(BATCH, { clock })).toBe(BATCH);
    const bare = { articles: [ARTICLE] };
    expect(validateNewsBatchResponse(bare, { clock })).toBe(bare);
    expect(isNewsBatchResponse(BATCH)).toBe(true);
  });

  it("reads the refresh hints from a meta envelope", () => {
    const withMeta = {
      data: { articles: [] },
      meta: { nextRefreshAt: "2026-07-13T20:05:00.000Z", lastUpdatedAt: null },
    };
    expect(validateNewsBatchResponse(withMeta, { clock })).toBe(withMeta);
  });

  it("accepts a declared error entry", () => {
    const withError = {
      data: { articles: [] },
      errors: [{
        instrumentId: "XNAS:MSFT",
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        message: "provider down",
        retryable: true,
      }],
    };
    expect(validateNewsBatchResponse(withError, { clock })).toBe(withError);
  });

  it.each([
    ["articles that are not an array", (b) => { b.data.articles = null; }, "newsBatch.data.articles"],
    ["a malformed article", (b) => { b.data.articles[0].title = ""; }, "newsBatch.data.articles[0].title"],
    ["errors that are not an array", (b) => { b.errors = {}; }, "newsBatch.errors"],
    ["an unknown source", (b) => { b.sources = { news: ["reuters"] }; }, "newsBatch.sources.news"],
    ["duplicate sources", (b) => { b.sources = { news: ["yahoo", "yahoo"] }; }, "newsBatch.sources.news"],
    ["sources that are not an array", (b) => { b.sources = { news: "yahoo" }; }, "newsBatch.sources.news"],
    ["a non-ISO refresh time", (b) => { b.nextRefreshAt = "soon"; }, "newsBatch.nextRefreshAt"],
    ["a non-ISO last update", (b) => { b.lastUpdatedAt = "recently"; }, "newsBatch.lastUpdatedAt"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(paths(validateNewsBatchResponse, BATCH, mutate)).toContain(path);
  });

  it.each([
    ["a non-object entry", "boom", "newsBatch.errors[0]"],
    ["a malformed instrument ID", { instrumentId: "MSFT", code: ERROR_CODES.TIMEOUT, message: "x", retryable: true }, "newsBatch.errors[0].instrumentId"],
    ["an unknown code", { instrumentId: "XNAS:MSFT", code: "kaput", message: "x", retryable: true }, "newsBatch.errors[0].code"],
    ["a blank message", { instrumentId: "XNAS:MSFT", code: ERROR_CODES.TIMEOUT, message: " ", retryable: true }, "newsBatch.errors[0].message"],
    ["a non-boolean retryable", { instrumentId: "XNAS:MSFT", code: ERROR_CODES.TIMEOUT, message: "x", retryable: "yes" }, "newsBatch.errors[0].retryable"],
  ])("rejects an error entry with %s", (_label, entry, path) => {
    expect(paths(validateNewsBatchResponse, BATCH, (b) => { b.errors = [entry]; }))
      .toContain(path);
  });

  it("rejects more articles than the batch limit allows", () => {
    const articles = Array.from({ length: 21 }, (_, index) => ({
      ...ARTICLE,
      id: `yahoo:story-${index}`,
      url: `https://news.example.test/story-${index}`,
      publishedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
    }));
    expect(paths(validateNewsBatchResponse, { data: { articles } }, () => {}))
      .toContain("newsBatch.data.articles");
  });

  it("rejects duplicate article IDs and URLs across the batch", () => {
    expect(paths(
      validateNewsBatchResponse,
      { data: { articles: [ARTICLE, { ...ARTICLE, url: "https://news.example.test/other" }] } },
      () => {},
    )).toContain("newsBatch.data.articles[1].id");

    expect(paths(
      validateNewsBatchResponse,
      { data: { articles: [ARTICLE, { ...ARTICLE, id: "yahoo:story-2", url: `${ARTICLE.url}#tail` }] } },
      () => {},
    )).toContain("newsBatch.data.articles[1].url");
  });

  it("rejects a value that is not an object", () => {
    expect(() => validateNewsBatchResponse([], { clock })).toThrowError(/failed runtime validation/u);
  });
});
