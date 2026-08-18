import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import {
  isNewsArticle,
  isNewsBatchResponse,
  isNewsFeed,
  validateNewsArticle,
  validateNewsBatchResponse,
  validateNewsFeed,
} from "../../server/contracts/core/validators.js";

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

function article(overrides = {}) {
  return {
    id: "yahoo:article-1",
    title: "Apple expands its services business",
    publisher: "Reuters",
    url: "https://news.example.test/apple-services",
    publishedAt: "2026-07-13T19:00:00.000Z",
    instrumentIds: ["XNAS:AAPL"],
    provider: "yahoo",
    ...overrides,
  };
}

function feed(overrides = {}) {
  const articles = overrides.articles ?? [article()];
  const fetchedAt = overrides.fetchedAt || "2026-07-13T20:00:00.000Z";
  return {
    instrumentId: "XNAS:AAPL",
    articles,
    source: "yahoo",
    quality: "fresh",
    asOf: articles[0]?.publishedAt || fetchedAt,
    fetchedAt,
    ...overrides,
  };
}

describe("news contracts", () => {
  it("accepts normalized articles, non-empty feeds, and valid empty feeds", () => {
    const validArticle = article();
    const validFeed = feed();
    const emptyFeed = feed({ articles: [] });

    expect(validateNewsArticle(validArticle, { now: NOW })).toBe(validArticle);
    expect(validateNewsFeed(validFeed, { now: NOW })).toBe(validFeed);
    expect(validateNewsFeed(emptyFeed, { now: NOW })).toBe(emptyFeed);
    expect(isNewsArticle(validArticle)).toBe(true);
    expect(isNewsFeed(validFeed)).toBe(true);
  });

  it("rejects unsafe URLs, markup, provider/ID mismatches, and future dates", () => {
    for (const invalid of [
      article({ url: "http://news.example.test/story" }),
      article({ url: "https://user:secret@news.example.test/story" }),
      article({ title: "<b>Provider markup</b>" }),
      article({ publisher: " Reuters  News " }),
      article({ id: "finnhub:1" }),
      article({ publishedAt: "2026-07-13T20:06:00.000Z" }),
    ]) {
      expect(() => validateNewsArticle(invalid, { now: NOW })).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }),
      );
    }
  });

  it("enforces canonical unique instrument IDs, newest-first ordering, and the provider cap", () => {
    expect(() => validateNewsArticle(article({
      instrumentIds: ["XNAS:AAPL", "XNAS:AAPL"],
    }), { now: NOW })).toThrowError(expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }));

    const descendingViolation = feed({
      articles: [
        article({ id: "yahoo:older", publishedAt: "2026-07-12T10:00:00.000Z" }),
        article({ id: "yahoo:newer", url: "https://news.example.test/newer" }),
      ],
    });
    expect(() => validateNewsFeed(descendingViolation, { now: NOW })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }),
    );

    const tooMany = Array.from({ length: 9 }, (_, index) => article({
      id: `yahoo:${index}`,
      url: `https://news.example.test/${index}`,
      publishedAt: new Date(NOW - index * 60_000).toISOString(),
    }));
    expect(() => validateNewsFeed(feed({ articles: tooMany }), { now: NOW })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }),
    );
  });

  it("requires stale feeds to preserve their original provider explicitly", () => {
    const stale = feed({
      source: "last-known-good",
      quality: "stale",
      originalSource: "yahoo",
    });
    expect(validateNewsFeed(stale, { now: NOW })).toBe(stale);
    expect(() => validateNewsFeed({ ...stale, originalSource: undefined }, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }));
    expect(() => validateNewsFeed({ ...feed(), quality: "stale" }, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }));
  });

  it("validates aggregate envelopes, including item-error structure", () => {
    const response = {
      data: { articles: [article()] },
      errors: [{
        instrumentId: "XNAS:MSFT",
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        message: "No coverage is available",
        retryable: true,
      }],
      sources: { news: ["yahoo"] },
      meta: {
        lastUpdatedAt: null,
        nextRefreshAt: "2026-07-13T20:15:00.000Z",
      },
    };
    expect(validateNewsBatchResponse(response, { now: NOW })).toBe(response);
    expect(isNewsBatchResponse(response)).toBe(true);
    expect(() => validateNewsBatchResponse({
      ...response,
      errors: [{ code: "invented", retryable: "yes" }],
    }, { now: NOW })).toThrowError(expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }));
    expect(() => validateNewsBatchResponse({
      ...response,
      lastUpdatedAt: "not-a-timestamp",
    }, { now: NOW })).toThrowError(expect.objectContaining({ code: ERROR_CODES.SCHEMA_INVALID }));
  });
});
