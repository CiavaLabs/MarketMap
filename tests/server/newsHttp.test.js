import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import { MarketDataError } from "../../server/errors/MarketDataError.js";
import { createMarketDataHandler } from "../../server/http/createMarketDataHandler.js";
import { InstrumentCatalog } from "../../server/instruments/InstrumentCatalog.js";
import { MarketDataOrchestrator } from "../../server/orchestration/MarketDataOrchestrator.js";
import { FinnhubProvider } from "../../server/providers/finnhub/FinnhubProvider.js";
import { descriptorFromLegacyInstrument } from "../../server/instruments/descriptorFactory.js";

const newsCatalog = new InstrumentCatalog();
const descriptorResolver = {
  getDescriptor: async (value) => descriptorFromLegacyInstrument(
    newsCatalog.resolve(String(value).toUpperCase()),
    { verifiedAt: "2026-07-16T00:00:00.000Z" },
  ),
  idForProviderSymbol: (symbol) => newsCatalog.resolveByProviderSymbol?.(symbol)?.id || null,
  capabilitiesFor: () => ({ news: { status: "supported" } }),
  isAddable: () => ({ addable: true, reasonCode: null }),
  searchInstruments: async () => [],
};

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

function article(index, instrumentIds = ["XNAS:AAPL"]) {
  return {
    id: `yahoo:${index}`,
    title: `Coverage ${index}`,
    publisher: "Publisher",
    url: `https://news.example.test/${index}`,
    publishedAt: new Date(NOW - index * 60_000).toISOString(),
    instrumentIds,
    provider: "yahoo",
  };
}

function newsFeed(instrumentId = "XNAS:AAPL") {
  const articles = Array.from({ length: 8 }, (_, index) => article(index, [instrumentId]));
  return {
    instrumentId,
    articles,
    source: "yahoo",
    quality: "fresh",
    asOf: articles[0].publishedAt,
    fetchedAt: new Date(NOW).toISOString(),
  };
}

function service(overrides = {}) {
  return {
    getHealth: vi.fn(async () => ({ status: "ok" })),
    getNews: vi.fn(async (id) => ({
      data: newsFeed(id),
      sources: { news: ["yahoo"] },
      lastUpdatedAt: new Date(NOW).toISOString(),
      nextRefreshAt: new Date(NOW + 15 * 60_000).toISOString(),
    })),
    getNewsBatch: vi.fn(async () => ({
      data: { articles: Array.from({ length: 20 }, (_, index) => article(index)) },
      errors: [],
      sources: { news: ["yahoo"] },
      lastUpdatedAt: new Date(NOW).toISOString(),
      nextRefreshAt: new Date(NOW + 15 * 60_000).toISOString(),
    })),
    ...overrides,
  };
}

function request(path, options = {}) {
  return new Request(`http://localhost${path}`, options);
}

describe("news HTTP endpoints", () => {
  it("serves a canonicalized single feed, applies default limit six, and exposes refresh metadata", async () => {
    const core = service();
    const handler = createMarketDataHandler({
      service: core,
      clock: () => NOW,
      requestIdFactory: () => "news-single",
    });
    const response = await handler(request("/api/market/v1/instruments/xnas%3Aaapl/news"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      instrumentId: "XNAS:AAPL",
      source: "yahoo",
      quality: "fresh",
    });
    expect(payload.data.articles).toHaveLength(6);
    expect(payload.sources.news).toEqual(["yahoo"]);
    expect(payload.meta).toMatchObject({
      apiVersion: "v1",
      schemaVersion: 2,
      requestId: "news-single",
      lastUpdatedAt: "2026-07-13T20:00:00.000Z",
      nextRefreshAt: "2026-07-13T20:15:00.000Z",
    });
    expect(response.headers.get("x-next-refresh-at")).toBe("2026-07-13T20:15:00.000Z");
    expect(core.getNews).toHaveBeenCalledWith("XNAS:AAPL", {
      limit: 6,
      signal: expect.any(AbortSignal),
    });
  });

  it("serves a canonical unique board batch and enforces the requested output limit", async () => {
    const core = service();
    const handler = createMarketDataHandler({ service: core, clock: () => NOW });
    const response = await handler(request(
      "/api/market/v1/news?ids=xnas:aapl,XNAS:AAPL,xnas:msft&limit=3",
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.articles).toHaveLength(3);
    expect(core.getNewsBatch).toHaveBeenCalledWith(["XNAS:AAPL", "XNAS:MSFT"], {
      limit: 3,
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps partial item errors and effective sources inside the ETag", async () => {
    let failed = false;
    const core = service({
      getNewsBatch: vi.fn(async () => ({
        data: { articles: [article(1)] },
        errors: failed ? [new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "offline", {
          instrumentId: "XNAS:MSFT",
          retryable: true,
          details: { retryAfterSeconds: 7 },
        })] : [],
        sources: { news: [failed ? "last-known-good" : "yahoo"] },
        nextRefreshAt: new Date(NOW + 60_000).toISOString(),
      })),
    });
    const handler = createMarketDataHandler({ service: core, clock: () => NOW });
    const first = await handler(request("/api/market/v1/news?ids=XNAS:AAPL,XNAS:MSFT"));
    const firstEtag = first.headers.get("etag");
    failed = true;
    const second = await handler(request("/api/market/v1/news?ids=XNAS:AAPL,XNAS:MSFT"));
    const payload = await second.json();

    expect(second.headers.get("etag")).not.toBe(firstEtag);
    expect(payload.errors).toEqual([expect.objectContaining({
      instrumentId: "XNAS:MSFT",
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      message: "offline",
      retryable: true,
      operation: "news",
    })]);
    expect(payload.sources.news).toEqual(["last-known-good"]);
    expect(second.headers.get("retry-after")).toBe("7");
  });

  it("returns 304 for a matching news representation ETag", async () => {
    const handler = createMarketDataHandler({ service: service(), clock: () => NOW });
    const first = await handler(request("/api/market/v1/instruments/XNAS:AAPL/news?limit=8"));
    const cached = await handler(request("/api/market/v1/instruments/XNAS:AAPL/news?limit=8", {
      headers: { "if-none-match": first.headers.get("etag") },
    }));
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
  });

  it("changes the news ETag when only the upstream confirmation timestamp changes", async () => {
    let lastUpdatedAt = "2026-07-13T19:55:00.000Z";
    const core = service({
      getNews: vi.fn(async (id) => ({
        data: newsFeed(id),
        sources: { news: ["yahoo"] },
        lastUpdatedAt,
        nextRefreshAt: new Date(NOW + 15 * 60_000).toISOString(),
      })),
    });
    const handler = createMarketDataHandler({ service: core, clock: () => NOW });
    const first = await handler(request("/api/market/v1/instruments/XNAS:AAPL/news"));
    const firstEtag = first.headers.get("etag");
    lastUpdatedAt = "2026-07-13T20:00:00.000Z";
    const second = await handler(request("/api/market/v1/instruments/XNAS:AAPL/news"));
    const payload = await second.json();

    expect(second.headers.get("etag")).not.toBe(firstEtag);
    expect(payload.meta.lastUpdatedAt).toBe(lastUpdatedAt);
  });

  it("rejects missing IDs, malformed IDs, and limit values at every boundary", async () => {
    const handler = createMarketDataHandler({ service: service(), clock: () => NOW });
    for (const path of [
      "/api/market/v1/news",
      "/api/market/v1/news?ids=not-an-id",
      "/api/market/v1/news?ids=A:B",
      "/api/market/v1/news?ids=XNAS:AAPL&limit=0",
      "/api/market/v1/news?ids=XNAS:AAPL&limit=21",
      "/api/market/v1/instruments/XNAS:AAPL/news?limit=9",
      "/api/market/v1/instruments/not-an-id/news",
      "/api/market/v1/instruments/A:B/news",
    ]) {
      const response = await handler(request(path));
      expect(response.status, path).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
    }
  });

  it("rejects more than forty unique board instruments", async () => {
    const ids = Array.from({ length: 41 }, (_, index) => `XNAS:TEST${index}`).join(",");
    const handler = createMarketDataHandler({ service: service(), clock: () => NOW });
    const response = await handler(request(`/api/market/v1/news?ids=${ids}`));
    expect(response.status).toBe(400);
  });

  it("keeps Finnhub tokens out of single problems and batch error envelopes", async () => {
    const secret = "http-server-secret";
    const provider = new FinnhubProvider({
      apiKey: secret,
      fetch: vi.fn(async () => {
        throw new Error(`request failed https://finnhub.io/api/v1/company-news?token=${secret}`);
      }),
      clock: () => NOW,
    });
    const catalog = new InstrumentCatalog();
    const core = new MarketDataOrchestrator({
      providers: [provider],
      catalog,
      instrumentResolver: descriptorResolver,
      clock: () => NOW,
    });
    const handler = createMarketDataHandler({ service: core, clock: () => NOW });

    const single = await handler(request("/api/market/v1/instruments/XNAS:AAPL/news"));
    const singleBody = await single.text();
    const batch = await handler(request("/api/market/v1/news?ids=XNAS:AAPL"));
    const batchBody = await batch.text();

    expect(single.status).toBe(503);
    expect(batch.status).toBe(200);
    expect(JSON.parse(batchBody).errors).toEqual([
      expect.objectContaining({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        message: "Finnhub upstream request failed",
      }),
    ]);
    for (const publicBody of [singleBody, batchBody]) {
      expect(publicBody).not.toContain(secret);
      expect(publicBody).not.toContain("token=");
      expect(publicBody).not.toContain("https://finnhub.io");
    }
  });
});
