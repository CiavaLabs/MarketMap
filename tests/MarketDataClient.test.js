import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MarketDataClient,
  MarketDataClientError,
} from "../src/api/MarketDataClient.js";
import { movementAnalyticsRecord } from "./fixtures/movementAnalyticsRecord.js";

const generatedAt = "2026-07-13T20:00:00.000Z";

function envelope(data, meta = {}) {
  return { data, meta: { apiVersion: "v1", schemaVersion: 2, generatedAt, ...meta } };
}

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: {
      "content-type": options.contentType || "application/json",
      ...options.headers,
    },
  });
}

function abortableFetch() {
  return vi.fn((_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}

function newsArticle(overrides = {}) {
  return {
    id: "yahoo:aapl-1",
    title: "Apple expands its developer tools",
    publisher: "Reuters",
    url: "https://news.example/apple-tools",
    publishedAt: "2026-07-13T19:30:00.000Z",
    instrumentIds: ["XNAS:AAPL"],
    provider: "yahoo",
    ...overrides,
  };
}

function newsFeed(overrides = {}) {
  return {
    instrumentId: "XNAS:AAPL",
    articles: [newsArticle()],
    source: "yahoo",
    quality: "fresh",
    asOf: "2026-07-13T19:30:00.000Z",
    fetchedAt: generatedAt,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MarketDataClient", () => {
  it("invokes fetch without using the client instance as its receiver", async () => {
    const receivers = [];
    const fetchImpl = vi.fn(function receiverSensitiveFetch() {
      receivers.push(this);
      if (this instanceof MarketDataClient) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(envelope({ status: "ok" })));
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.health()).resolves.toEqual(envelope({ status: "ok" }));
    expect(receivers).toEqual([undefined]);
  });

  it("uses the single v1 API for every market-data resource", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await client.snapshot(["XNAS:AAPL", "XNYS:JPM"]);
    await client.search("apple inc", {
      assetClass: ["equity", "etf"],
      exchange: "XNAS",
      includeUnsupported: true,
      limit: 10,
    });
    await client.instrument("XNAS:AAPL", { providerSymbol: "AAPL" });
    await client.history("XNAS:AAPL", { range: "1m", interval: "1d" });
    await client.health();

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/market/v1/snapshot?ids=XNAS%3AAAPL%2CXNYS%3AJPM",
      "/api/market/v1/instruments/search?q=apple+inc&assetClass=equity%2Cetf&venue=XNAS&includeUnsupported=true&limit=10",
      "/api/market/v1/instruments/XNAS%3AAAPL?providerSymbol=AAPL",
      "/api/market/v1/instruments/XNAS%3AAAPL/history?range=1m&interval=1d&priceBasis=raw",
      "/api/market/v1/health",
    ]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-cache",
    });
  });

  it("reads persisted analytics snapshots and rejects malformed records", async () => {
    const record = movementAnalyticsRecord();
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([record])));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const accepted = await client.analyticsSnapshot(["xnas:aapl", "XNAS:AAPL", "XNAS:MSFT"]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/market/v1/analytics/snapshot?ids=XNAS%3AAAPL%2CXNAS%3AMSFT",
    ]);
    expect(accepted.data).toEqual([record]);

    expect(() => client.analyticsSnapshot([])).toThrow(/non-empty/u);
    expect(() => client.analyticsSnapshot(
      Array.from({ length: 41 }, (_, index) => `XNAS:T${String(index).padStart(2, "0")}`),
    )).toThrow(/at most 40/u);

    const malformedCases = [
      movementAnalyticsRecord((value) => { value.assessment.schemaVersion = 2; }),
      movementAnalyticsRecord((value) => { value.assessment.status = "pending"; }),
      movementAnalyticsRecord((value) => { value.assessment.instrumentId = "XNAS:MSFT"; }),
      movementAnalyticsRecord((value) => { value.runId = "not-a-digest"; }),
      movementAnalyticsRecord((value) => { value.assessment.forecast = null; }),
      movementAnalyticsRecord((value) => {
        value.assessment.status = "unavailable";
        value.assessment.evidence = null;
      }),
    ];
    for (const malformed of malformedCases) {
      const rejectingClient = new MarketDataClient({
        fetchImpl: vi.fn(async () => jsonResponse(envelope([malformed]))),
        timeoutMs: 0,
      });
      await expect(rejectingClient.analyticsSnapshot(["XNAS:AAPL"]))
        .rejects.toMatchObject({ code: "schema_invalid", retryable: false });
    }
  });

  it("revalidates cached envelopes with ETag and serves HTTP 304", async () => {
    const cachedEnvelope = envelope(
      { status: "ok" },
      { nextRefreshAt: "2026-07-13T20:00:05.000Z" },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cachedEnvelope, { headers: { etag: 'W/"health-1"' } }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { "x-next-refresh-at": "2026-07-13T20:00:10.000Z" },
      }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const first = await client.health();
    const second = await client.health();

    expect(first).toEqual(cachedEnvelope);
    expect(second).not.toBe(first);
    expect(second).toEqual(envelope(
      { status: "ok" },
      { nextRefreshAt: "2026-07-13T20:00:10.000Z" },
    ));
    expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe('W/"health-1"');
  });

  it("bounds ETag entries and retains recently revalidated endpoints", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope({ status: "ok" }), {
      headers: { etag: 'W/"stable"' },
    }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0, maxEtagEntries: 2 });

    await client.health();
    await client.search("apple");
    await client.health();
    await client.search("tesla");

    expect(client.etagCache.size).toBe(2);
    expect(client.etagCache.has("/api/market/v1/health")).toBe(true);
    expect(client.etagCache.has("/api/market/v1/instruments/search?q=apple")).toBe(false);
    expect(client.etagCache.has("/api/market/v1/instruments/search?q=tesla")).toBe(true);
  });

  it("calls the single and board news endpoints with canonical limits", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const responseEnvelope = url.includes("/instruments/")
        ? { ...envelope(newsFeed()), sources: { news: ["yahoo"] } }
        : {
            ...envelope({ articles: [newsArticle()] }),
            errors: [],
            sources: { news: ["yahoo"] },
          };
      return jsonResponse(responseEnvelope);
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.news("XNAS:AAPL", { limit: 6 })).resolves.toMatchObject({
      data: { instrumentId: "XNAS:AAPL" },
    });
    await expect(client.newsBatch(["XNAS:AAPL", "XNYS:JPM"], { limit: 12 }))
      .resolves.toMatchObject({ data: { articles: [expect.objectContaining({ id: "yahoo:aapl-1" })] } });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/market/v1/instruments/XNAS%3AAAPL/news?limit=6",
      "/api/market/v1/news?ids=XNAS%3AAAPL%2CXNYS%3AJPM&limit=12",
    ]);
  });

  it("canonicalizes lowercase news IDs before URL construction and response comparison", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ...envelope(newsFeed()),
      sources: { news: ["yahoo"] },
    }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.news("xnas:aapl")).resolves.toMatchObject({
      data: { instrumentId: "XNAS:AAPL" },
    });
    expect(fetchImpl.mock.calls[0][0])
      .toBe("/api/market/v1/instruments/XNAS%3AAAPL/news?limit=4");

    const batchFetch = vi.fn(async () => jsonResponse({
      ...envelope({ articles: [newsArticle()] }),
      errors: [],
      sources: { news: ["yahoo"] },
    }));
    const batchClient = new MarketDataClient({ fetchImpl: batchFetch, timeoutMs: 0 });
    await batchClient.newsBatch(["xnas:aapl"]);
    expect(batchFetch.mock.calls[0][0])
      .toBe("/api/market/v1/news?ids=XNAS%3AAAPL&limit=12");
  });

  it("revalidates a cached news envelope with its endpoint ETag", async () => {
    const cached = { ...envelope(newsFeed()), sources: { news: ["yahoo"] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cached, { headers: { etag: 'W/"news-aapl"' } }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { "x-next-refresh-at": "2026-07-13T20:15:00.000Z" },
      }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await client.news("XNAS:AAPL");
    const revalidated = await client.news("XNAS:AAPL");

    expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe('W/"news-aapl"');
    expect(revalidated.meta.nextRefreshAt).toBe("2026-07-13T20:15:00.000Z");
    expect(revalidated.data.articles).toHaveLength(1);
  });

  it("uses the 30-second batch timeout while preserving caller cancellation", async () => {
    vi.useFakeTimers();
    const fetchImpl = abortableFetch();
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 5 });

    const timedOut = client.newsBatch(["XNAS:AAPL"]);
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutAssertion;

    const controller = new AbortController();
    const cancelled = client.news("XNAS:AAPL", { signal: controller.signal, timeoutMs: 30_000 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it("rejects malformed news contracts before exposing them to views", async () => {
    const invalidArticle = newsArticle({
      id: "finnhub:wrong-provider-prefix",
      url: "https://user:password@news.example/private",
      instrumentIds: ["AAPL", "AAPL"],
    });
    const fetchImpl = vi.fn(async () => jsonResponse({
      ...envelope({ articles: [invalidArticle] }),
      errors: [{ instrumentId: "XNAS:AAPL", message: "Unavailable", retryable: true }],
      sources: { news: ["yahoo"] },
    }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.newsBatch(["XNAS:AAPL"])).rejects.toMatchObject({
      code: "schema_invalid",
      retryable: false,
    });
    expect(() => client.news("XNAS:AAPL", { limit: 9 })).toThrow("between 1 and 8");
    expect(() => client.newsBatch(["XNAS:AAPL"], { limit: 21 })).toThrow("between 1 and 20");
  });

  it("rejects invalid confirmation timestamps and globally duplicated batch articles", async () => {
    const duplicateByUrl = newsArticle({
      id: "finnhub:second-id",
      provider: "finnhub",
      url: "https://news.example/apple-tools#duplicate-fragment",
    });
    const responses = [
      {
        ...envelope({ articles: [newsArticle()] }, { lastUpdatedAt: "not-a-date" }),
        errors: [],
        sources: { news: ["yahoo"] },
      },
      {
        ...envelope({ articles: [newsArticle(), duplicateByUrl] }),
        errors: [],
        sources: { news: ["yahoo", "finnhub"] },
      },
      {
        ...envelope({ articles: [newsArticle()] }),
        errors: [
          { instrumentId: "XNAS:AAPL", code: "offline", message: "Offline", retryable: true },
          { instrumentId: "XNAS:AAPL", code: "timeout", message: "Timed out", retryable: true },
        ],
        sources: { news: ["yahoo"] },
      },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(responses.shift()));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    for (let index = 0; index < 3; index += 1) {
      await expect(client.newsBatch(["XNAS:AAPL"])).rejects.toMatchObject({
        code: "schema_invalid",
        retryable: false,
      });
    }
  });

  it("turns application/problem+json responses into typed client errors", async () => {
    const problem = {
      type: "urn:market-map:error:rate_limited",
      title: "Upstream rate limit",
      status: 429,
      detail: "Please retry later",
      code: "rate_limited",
      retryable: true,
      requestId: "req-42",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(problem, {
      status: 429,
      contentType: "application/problem+json",
      headers: { "retry-after": "3" },
    }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.health()).rejects.toMatchObject({
      name: "MarketDataClientError",
      message: "Please retry later",
      code: "rate_limited",
      status: 429,
      retryable: true,
      requestId: "req-42",
      retryAfterMs: 3_000,
      problem,
    });
  });

  it("isolates a malformed snapshot chunk as item-local errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.snapshot(["XNAS:AAPL"])).resolves.toMatchObject({
      data: [],
      errors: [expect.objectContaining({
        instrumentId: "XNAS:AAPL",
        code: "schema_invalid",
        retryable: false,
      })],
    });
  });

  it("rejects an obsolete schema-1 envelope received from the current v1 route", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [],
      meta: { apiVersion: "v1", schemaVersion: 1, generatedAt },
    }));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await expect(client.snapshot(["XNAS:AAPL"])).resolves.toMatchObject({
      data: [],
      errors: [expect.objectContaining({ code: "schema_invalid" })],
    });
  });

  it("chunks 47 snapshots into 40 + 7 and restores board order", async () => {
    const ids = Array.from({ length: 47 }, (_, index) => `XNAS:T${index}`);
    const fetchImpl = vi.fn(async (url) => {
      const chunk = new URL(url, "https://marketmap.test").searchParams.get("ids").split(",");
      return jsonResponse(envelope([...chunk].reverse().map((instrumentId) => ({
        instrumentId,
        provenance: { source: "yahoo" },
      }))));
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });
    const result = await client.snapshot(ids);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url, "https://marketmap.test").searchParams.get("ids").split(",").length))
      .toEqual([40, 7]);
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(ids);
  });

  it("deduplicates snapshot ids in first-seen board order before planning chunks", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const ids = new URL(url, "https://marketmap.test").searchParams.get("ids").split(",");
      return jsonResponse(envelope(ids.map((instrumentId) => ({
        instrumentId,
        provenance: { source: "yahoo" },
      }))));
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const result = await client.snapshot(["XNAS:AAPL", "XNYS:IBM", "XNAS:AAPL"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(fetchImpl.mock.calls[0][0], "https://marketmap.test").searchParams.get("ids"))
      .toBe("XNAS:AAPL,XNYS:IBM");
    expect(result.data.map(({ instrumentId }) => instrumentId))
      .toEqual(["XNAS:AAPL", "XNYS:IBM"]);
  });

  it("canonicalizes lowercase snapshot ids before batching and merging results", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const ids = new URL(url, "https://marketmap.test").searchParams.get("ids").split(",");
      return jsonResponse(envelope(ids.map((instrumentId) => ({
        instrumentId,
        provenance: { source: "yahoo" },
      }))));
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const result = await client.snapshot(["xnas:aapl", "XNAS:AAPL"]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(fetchImpl.mock.calls[0][0], "https://marketmap.test").searchParams.get("ids"))
      .toBe("XNAS:AAPL");
    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
  });

  it("serializes false includePrePost values and rejects ambiguous values", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    await client.historyBatch(["xnas:aapl"], { includePrePost: false });

    expect(fetchImpl.mock.calls[0][0])
      .toBe("/api/market/v1/history?ids=XNAS%3AAAPL&range=1d&interval=5m&priceBasis=raw&includePrePost=false");
    expect(() => client.history("XNAS:AAPL", { includePrePost: "false" }))
      .toThrow("includePrePost must be a boolean");
    expect(() => client.historyBatch(["XNAS:AAPL"], { includePrePost: "true" }))
      .toThrow("includePrePost must be a boolean");
  });

  it("forwards caller cancellation through AbortSignal", async () => {
    const fetchImpl = abortableFetch();
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });
    const controller = new AbortController();

    const request = client.health({ signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("aborts requests that exceed their timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = abortableFetch();
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 50 });

    const request = client.health();
    const assertion = expect(request).rejects.toMatchObject({
      name: "MarketDataClientError",
      code: "timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("rejects cross-origin or unversioned API bases and invalid limits", () => {
    expect(() => new MarketDataClient({
      apiBaseUrl: "https://data.example/api/market/v1",
      origin: "https://site.example",
      fetchImpl: vi.fn(),
    })).toThrow("same-origin");
    expect(() => new MarketDataClient({
      apiBaseUrl: "/api/market",
      fetchImpl: vi.fn(),
    })).toThrow("/v1");

    const client = new MarketDataClient({ fetchImpl: vi.fn(), timeoutMs: 0 });
    expect(() => client.snapshot([])).toThrow("non-empty array");
    expect(() => client.search("a")).toThrow("between 2 and 80");
    expect(() => client.search("apple", { limit: 21 })).toThrow("between 1 and 20");
    expect(() => client.search("apple", { includeUnsupported: "true" })).toThrow("must be a boolean");
    expect(MarketDataClientError).toBeTypeOf("function");
  });
});
