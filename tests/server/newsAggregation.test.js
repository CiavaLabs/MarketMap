import { describe, expect, it } from "vitest";
import {
  deduplicateNewsArticles,
  normalizeNewsUrl,
  selectBalancedNewsArticles,
} from "../../server/metrics/news.js";

function article(id, publishedAt, instrumentIds, overrides = {}) {
  return {
    id: `yahoo:${id}`,
    title: `Coverage ${id}`,
    publisher: "Publisher",
    url: `https://news.example.test/${id}`,
    publishedAt,
    instrumentIds,
    provider: "yahoo",
    ...overrides,
  };
}

describe("news aggregation", () => {
  it("normalizes only safe HTTPS URLs and removes fragments without changing the query", () => {
    expect(normalizeNewsUrl("https://News.Example.test/story?a=1#section"))
      .toBe("https://news.example.test/story?a=1");
    expect(normalizeNewsUrl("http://news.example.test/story")).toBeNull();
    expect(normalizeNewsUrl("https://user:password@news.example.test/story")).toBeNull();
  });

  it("deduplicates cross-provider URLs and merges canonical instrument IDs", () => {
    const older = article("shared-yahoo", "2026-07-13T18:00:00.000Z", ["XNAS:AAPL"], {
      url: "https://news.example.test/shared#yahoo",
    });
    const newer = article("shared-finnhub", "2026-07-13T19:00:00.000Z", ["XNAS:MSFT"], {
      id: "finnhub:42",
      provider: "finnhub",
      url: "https://news.example.test/shared#finnhub",
    });
    const result = deduplicateNewsArticles([older, newer]);

    expect(result).toEqual([expect.objectContaining({
      id: "finnhub:42",
      provider: "finnhub",
      url: "https://news.example.test/shared",
      instrumentIds: ["XNAS:AAPL", "XNAS:MSFT"],
    })]);
  });

  it("deduplicates a provider article ID even when its URLs differ", () => {
    const newest = article("same-id", "2026-07-13T19:00:00.000Z", ["XNAS:AAPL"], {
      url: "https://news.example.test/new-location",
    });
    const older = article("same-id", "2026-07-13T18:00:00.000Z", ["XNAS:MSFT"], {
      url: "https://news.example.test/old-location",
    });

    expect(deduplicateNewsArticles([older, newest])).toEqual([
      expect.objectContaining({
        id: "yahoo:same-id",
        url: "https://news.example.test/new-location",
        instrumentIds: ["XNAS:AAPL", "XNAS:MSFT"],
      }),
    ]);
  });

  it("merges transitive ID and cross-provider URL duplicates deterministically", () => {
    const newest = article("bridge", "2026-07-13T20:00:00.000Z", ["XNAS:AAPL"], {
      url: "https://news.example.test/location-a",
    });
    const sameId = article("bridge", "2026-07-13T19:00:00.000Z", ["XNAS:MSFT"], {
      url: "https://news.example.test/location-b#copy",
    });
    const sharedUrl = article("finnhub-copy", "2026-07-13T18:00:00.000Z", ["XNAS:NVDA"], {
      id: "finnhub:copy",
      provider: "finnhub",
      url: "https://news.example.test/location-b#provider",
    });

    expect(deduplicateNewsArticles([sharedUrl, sameId, newest])).toEqual([
      expect.objectContaining({
        id: "yahoo:bridge",
        url: "https://news.example.test/location-a",
        instrumentIds: ["XNAS:AAPL", "XNAS:MSFT", "XNAS:NVDA"],
      }),
    ]);
  });

  it("balances first representation while keeping a shared story unique", () => {
    const sharedA = article("shared", "2026-07-13T10:00:00.000Z", ["XNAS:AAPL"], {
      url: "https://news.example.test/shared#aapl",
    });
    const sharedB = article("shared-copy", "2026-07-13T10:00:00.000Z", ["XNAS:MSFT"], {
      url: "https://news.example.test/shared#msft",
    });
    const aSecond = article("a-second", "2026-07-13T09:00:00.000Z", ["XNAS:AAPL"]);
    const bSecond = article("b-second", "2026-07-13T08:00:00.000Z", ["XNAS:MSFT"]);
    const cFirst = article("c-first", "2026-07-13T07:00:00.000Z", ["XNAS:NVDA"]);
    const feeds = [
      { instrumentId: "XNAS:AAPL", articles: [sharedA, aSecond] },
      { instrumentId: "XNAS:MSFT", articles: [sharedB, bSecond] },
      { instrumentId: "XNAS:NVDA", articles: [cFirst] },
    ];

    const result = selectBalancedNewsArticles(feeds, { limit: 3 });
    expect(result.map((item) => item.id)).toEqual([
      "yahoo:shared",
      "yahoo:c-first",
      "yahoo:a-second",
    ]);
    expect(result[0].instrumentIds).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("uses the stable ID tie-breaker and respects the requested limit", () => {
    const timestamp = "2026-07-13T10:00:00.000Z";
    const feeds = [
      { instrumentId: "XNAS:AAPL", articles: [article("z", timestamp, ["XNAS:AAPL"])] },
      { instrumentId: "XNAS:MSFT", articles: [article("a", timestamp, ["XNAS:MSFT"])] },
    ];
    expect(selectBalancedNewsArticles(feeds, 1).map((item) => item.id)).toEqual(["yahoo:a"]);
  });
});
