import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ETAG_CACHE_MAX_ENTRIES,
  MarketDataClient,
  MarketDataClientError,
  validateMarketDataEnvelope,
} from "../src/api/MarketDataClient.js";

const GENERATED_AT = "2026-07-13T20:00:00.000Z";

const envelope = (data, meta = {}) => ({
  data,
  meta: { apiVersion: "v1", schemaVersion: 2, generatedAt: GENERATED_AT, ...meta },
});

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(value === undefined ? "" : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const client = (options = {}) => new MarketDataClient({
  fetchImpl: vi.fn(async () => jsonResponse(envelope({ status: "ok" }))),
  timeoutMs: 0,
  ...options,
});

function respondingWith(...responses) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next();
    return next.clone();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("API base URL validation", () => {
  it.each([
    ["a relative path without a leading slash", "api/market/v1", null],
    ["a trailing slash", "/api/market/v1/", null],
    ["an absolute same-origin URL", "https://site.example/api/market/v1", "https://site.example"],
  ])("accepts %s", (_label, apiBaseUrl, origin) => {
    expect(() => client({ apiBaseUrl, origin })).not.toThrow();
  });

  it("normalizes a trailing slash away from the request URL", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({ status: "ok" })));
    await client({ apiBaseUrl: "/api/market/v1/", fetchImpl }).health();
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/market/v1/health");
  });

  it.each([
    ["an empty string", { apiBaseUrl: "   " }, /non-empty string|\/v1/u],
    ["a query string", { apiBaseUrl: "/api/market/v1?x=1" }, /query string or fragment/u],
    ["a fragment", { apiBaseUrl: "/api/market/v1#top" }, /query string or fragment/u],
    ["an unversioned path", { apiBaseUrl: "/api/market/v2" }, /\/v1/u],
  ])("rejects %s", (_label, options, pattern) => {
    expect(() => client(options)).toThrowError(pattern);
  });

  it.each([
    ["an absolute URL with no origin to check it against", {
      apiBaseUrl: "https://site.example/api/market/v1",
      origin: null,
    }, /An origin is required/u],
    ["a protocol-relative URL with no origin", {
      apiBaseUrl: "//site.example/api/market/v1",
      origin: null,
    }, /An origin is required/u],
    ["a non-HTTP scheme", {
      apiBaseUrl: "ftp://site.example/api/market/v1",
      origin: "https://site.example",
    }, /same-origin/u],
    ["an absolute URL carrying a query string", {
      apiBaseUrl: "https://site.example/api/market/v1?x=1",
      origin: "https://site.example",
    }, /query string or fragment/u],
    ["an unparseable origin", {
      apiBaseUrl: "https://site.example/api/market/v1",
      origin: "not a url",
    }, /valid same-origin URL/u],
  ])("rejects %s", (_label, options, pattern) => {
    expect(() => client(options)).toThrowError(pattern);
  });

  it("falls back to the runtime origin when the caller supplies none", () => {
    vi.stubGlobal("location", { origin: "https://site.example" });
    expect(() => client({ apiBaseUrl: "https://site.example/api/market/v1" })).not.toThrow();
    expect(() => client({ apiBaseUrl: "https://other.example/api/market/v1" }))
      .toThrowError(/same-origin/u);
  });
});

describe("client construction", () => {
  it("requires a fetch implementation", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => new MarketDataClient({ fetchImpl: null, timeoutMs: 0 }))
      .toThrowError(/requires a fetch implementation/u);
  });

  it("falls back to the ambient fetch when the caller supplies none", async () => {
    const ambient = vi.fn(async () => jsonResponse(envelope({ status: "ok" })));
    vi.stubGlobal("fetch", ambient);
    await new MarketDataClient({ timeoutMs: 0 }).health();
    expect(ambient).toHaveBeenCalledOnce();
  });

  it.each([
    ["a negative timeout", { timeoutMs: -1 }],
    ["a non-finite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["a non-numeric timeout", { timeoutMs: "fast" }],
  ])("rejects %s", (_label, options) => {
    expect(() => client(options)).toThrowError(/non-negative finite number/u);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 2.5],
  ])("rejects a %s ETag cache size", (_label, maxEtagEntries) => {
    expect(() => client({ maxEtagEntries })).toThrowError(/positive integer/u);
  });

  it("rejects a cache adapter missing part of the interface", () => {
    expect(() => client({ etagCache: { get: () => {}, set: () => {} } }))
      .toThrowError(/must implement get, set, and clear/u);
  });

  it("accepts a custom cache adapter and clears it on request", () => {
    const etagCache = { get: vi.fn(), set: vi.fn(), clear: vi.fn() };
    client({ etagCache }).clearCache();
    expect(etagCache.clear).toHaveBeenCalledOnce();
  });

  it("publishes its default cache bound", () => {
    expect(DEFAULT_ETAG_CACHE_MAX_ENTRIES).toBe(200);
  });
});

describe("request argument validation", () => {
  const api = () => client();

  it.each([
    ["a non-string instrument", 42],
    ["an empty instrument", "   "],
  ])("rejects %s", (_label, id) => {
    expect(() => api().details(id)).toThrowError(/must be a non-empty string/u);
  });

  it("keeps a non-canonical instrument as written rather than upper-casing it", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    await client({ fetchImpl }).details("some-alias");
    expect(fetchImpl.mock.calls[0][0]).toContain("some-alias");
  });

  it("upper-cases a canonical instrument", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    await client({ fetchImpl }).details("xnas:aapl");
    expect(fetchImpl.mock.calls[0][0]).toContain("XNAS%3AAAPL");
  });

  it("rejects duplicate ids where uniqueness is required", () => {
    expect(() => api().newsBatch(["XNAS:AAPL", "XNAS:AAPL"])).toThrowError(/must be unique/u);
  });

  it("rejects a batch beyond its own limit", () => {
    const ids = Array.from({ length: 41 }, (_, index) => `XNAS:A${index}`);
    expect(() => api().newsBatch(ids)).toThrowError(/at most 40/u);
    expect(() => api().analyticsSnapshot(ids)).toThrowError(/at most 40/u);
  });

  it.each([
    ["zero", 0],
    ["above the cap", 9],
    ["fractional", 1.5],
  ])("rejects a %s news limit", (_label, limit) => {
    expect(() => api().news("XNAS:AAPL", { limit })).toThrowError(/between 1 and 8/u);
  });

  it("rejects a news batch limit above its own cap", () => {
    expect(() => api().newsBatch(["XNAS:AAPL"], { limit: 21 }))
      .toThrowError(/between 1 and 20/u);
  });

  it.each([
    ["a blank range", { range: "   " }],
    ["a blank interval", { interval: "  " }],
  ])("rejects history with %s", (_label, options) => {
    expect(() => api().history("XNAS:AAPL", options)).toThrowError(/non-empty strings/u);
    expect(() => api().historyBatch(["XNAS:AAPL"], options)).toThrowError(/non-empty strings/u);
  });

  it("rejects an ambiguous includePrePost on either history call", () => {
    expect(() => api().history("XNAS:AAPL", { includePrePost: "yes" }))
      .toThrowError(/must be a boolean/u);
    expect(() => api().historyBatch(["XNAS:AAPL"], { includePrePost: 1 }))
      .toThrowError(/must be a boolean/u);
  });
});

describe("query construction", () => {
  it("omits the section parameter when no section is requested", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    await client({ fetchImpl }).details("XNAS:AAPL");
    expect(fetchImpl.mock.calls[0][0]).not.toContain("section");
  });

  it("joins requested sections and drops blank ones", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    await client({ fetchImpl }).details("XNAS:AAPL", { sections: ["profile", "  ", "valuation"] });
    expect(fetchImpl.mock.calls[0][0]).toContain("section=profile%2Cvaluation");
  });

  it("carries a provider symbol hint only when it has content", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    const api = client({ fetchImpl });

    await api.instrument("XNAS:AAPL", { providerSymbol: "  AAPL " });
    expect(fetchImpl.mock.calls[0][0]).toContain("providerSymbol=AAPL");

    await api.instrument("XNAS:AAPL", { providerSymbol: "   " });
    expect(fetchImpl.mock.calls[1][0]).not.toContain("providerSymbol");
  });

  it.each([
    ["a single asset class", { assetClass: "equity" }, "assetClass=equity"],
    ["an asset class list", { assetClasses: ["equity", "etf"] }, "assetClass=equity%2Cetf"],
    ["a venue", { venue: " XNAS " }, "venue=XNAS"],
    ["a MIC alias", { mic: "XNAS" }, "venue=XNAS"],
    ["an exchange alias", { exchange: "Nasdaq" }, "venue=Nasdaq"],
    ["a currency", { currency: " USD " }, "currency=USD"],
    ["an explicit unsupported flag", { includeUnsupported: false }, "includeUnsupported=false"],
    ["a limit", { limit: 5 }, "limit=5"],
  ])("carries %s into the search query", async (_label, options, expected) => {
    const fetchImpl = respondingWith(jsonResponse(envelope([])));
    await client({ fetchImpl }).search("apple", options);
    expect(fetchImpl.mock.calls[0][0]).toContain(expected);
  });

  it.each([
    ["an empty asset class list", { assetClasses: [] }, "assetClass"],
    ["a blank venue", { venue: "   " }, "venue"],
    ["a blank currency", { currency: "  " }, "currency"],
  ])("omits %s from the search query", async (_label, options, absent) => {
    const fetchImpl = respondingWith(jsonResponse(envelope([])));
    await client({ fetchImpl }).search("apple", options);
    expect(fetchImpl.mock.calls[0][0]).not.toContain(absent);
  });

  it("trims a search query before measuring it", () => {
    expect(() => client().search("  a  ")).toThrowError(/between 2 and 80/u);
    expect(() => client().search("x".repeat(81))).toThrowError(/between 2 and 80/u);
    expect(() => client().search(null)).toThrowError(/between 2 and 80/u);
  });

  it("defaults history to a raw one-day series", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({})));
    await client({ fetchImpl }).history("XNAS:AAPL");
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain("range=1d");
    expect(url).toContain("interval=5m");
    expect(url).toContain("priceBasis=raw");
    expect(url).not.toContain("includePrePost");
  });
});

describe("envelope validation", () => {
  it.each([
    ["a non-object", "payload"],
    ["an array", []],
    ["an object with no data key", { meta: {} }],
  ])("rejects %s", (_label, value) => {
    expect(() => validateMarketDataEnvelope(value, "/test"))
      .toThrowError(/invalid response envelope/u);
  });

  it("rejects an envelope with no metadata", () => {
    expect(() => validateMarketDataEnvelope({ data: [] }, "/test"))
      .toThrowError(/missing envelope metadata/u);
  });

  it.each([
    ["the wrong API version", { apiVersion: "v0", schemaVersion: 2 }, /wrong API version/u],
    ["the wrong schema version", { apiVersion: "v1", schemaVersion: 1 }, /wrong schema version/u],
  ])("rejects %s", (_label, meta, pattern) => {
    expect(() => validateMarketDataEnvelope({ data: [], meta }, "/test", {
      apiVersion: "v1",
      schemaVersion: 2,
    })).toThrowError(pattern);
  });

  it("rejects errors that are not an array", () => {
    expect(() => validateMarketDataEnvelope({ data: [], meta: {}, errors: {} }, "/test"))
      .toThrowError(/errors must be an array/u);
  });

  it("rejects an unreadable nextRefreshAt but accepts a null one", () => {
    expect(() => validateMarketDataEnvelope({ data: [], meta: { nextRefreshAt: "soon" } }, "/test"))
      .toThrowError(/invalid nextRefreshAt/u);
    expect(validateMarketDataEnvelope({ data: [], meta: { nextRefreshAt: null } }, "/test"))
      .toBeDefined();
  });
});

describe("HTTP failures", () => {
  it("maps a problem document onto a typed error", async () => {
    const problem = {
      type: "https://errors.example/rate-limited",
      title: "Rate limited",
      detail: "Slow down",
      code: "rate_limited",
      status: 429,
      retryable: true,
      requestId: "req-1",
    };
    const fetchImpl = respondingWith(jsonResponse(problem, {
      status: 429,
      headers: { "retry-after": "30" },
    }));

    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
      title: "Rate limited",
      requestId: "req-1",
      retryAfterMs: 30_000,
    });
  });

  it("falls back to the response status when the body carries none", async () => {
    const fetchImpl = respondingWith(jsonResponse({ title: "Gone" }, { status: 410 }));
    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      code: "http_error",
      status: 410,
      retryable: false,
      message: "Gone",
    });
  });

  it("reads the request id from the response header when the body omits it", async () => {
    const fetchImpl = respondingWith(jsonResponse({}, {
      status: 500,
      headers: { "x-request-id": "req-header" },
    }));
    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      requestId: "req-header",
      retryable: true,
    });
  });

  it.each([
    ["an absolute date", new Date(Date.now() + 60_000).toUTCString(), (ms) => ms > 0],
    ["a past date", new Date(Date.now() - 60_000).toUTCString(), (ms) => ms === 0],
    ["an unreadable value", "whenever", (ms) => ms === null],
    ["no header at all", null, (ms) => ms === null],
  ])("reads retry-after given %s", async (_label, header, assertion) => {
    const fetchImpl = respondingWith(jsonResponse({}, {
      status: 503,
      ...(header === null ? {} : { headers: { "retry-after": header } }),
    }));
    const error = await client({ fetchImpl }).health().catch((caught) => caught);
    expect(assertion(error.retryAfterMs)).toBe(true);
  });

  it.each([
    ["a body that is not JSON", () => new Response("<html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })],
    ["an empty body", () => new Response("", { status: 200 })],
  ])("rejects %s", async (_label, response) => {
    const fetchImpl = respondingWith(response);
    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      code: "schema_invalid",
      status: 502,
      retryable: false,
    });
  });

  it("reports an unreachable API as a retryable network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const error = await client({ fetchImpl }).health().catch((caught) => caught);

    expect(error).toBeInstanceOf(MarketDataClientError);
    expect(error).toMatchObject({ code: "network_error", retryable: true });
    expect(error.url).toContain("/health");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("keeps a client error raised inside the request untouched", async () => {
    const fetchImpl = respondingWith(jsonResponse({ data: [] }));
    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      code: "schema_invalid",
    });
  });
});

describe("conditional requests", () => {
  it("sends no validator on the first request", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope({ status: "ok" })));
    await client({ fetchImpl }).health();
    expect(fetchImpl.mock.calls[0][1].headers["If-None-Match"]).toBeUndefined();
  });

  it("rejects a 304 it has no cached body for", async () => {
    const fetchImpl = respondingWith(new Response(null, { status: 304 }));
    await expect(client({ fetchImpl }).health()).rejects.toMatchObject({
      code: "schema_invalid",
      status: 502,
    });
  });

  it("refreshes the next-refresh hint carried on a 304", async () => {
    const first = jsonResponse(envelope({ status: "ok" }, { nextRefreshAt: GENERATED_AT }), {
      headers: { etag: "W/\"1\"" },
    });
    const revalidated = new Response(null, {
      status: 304,
      headers: { etag: "W/\"1\"", "x-next-refresh-at": "2026-07-13T20:05:00.000Z" },
    });
    const fetchImpl = respondingWith(first, revalidated);
    const api = client({ fetchImpl });

    await api.health();
    const second = await api.health();

    expect(second.meta.nextRefreshAt).toBe("2026-07-13T20:05:00.000Z");
    expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe("W/\"1\"");
  });

  it("keeps the cached envelope when a 304 carries no refresh hint", async () => {
    const first = jsonResponse(envelope({ status: "ok" }), { headers: { etag: "W/\"1\"" } });
    const fetchImpl = respondingWith(first, new Response(null, { status: 304 }));
    const api = client({ fetchImpl });

    const original = await api.health();
    expect(await api.health()).toEqual(original);
  });

  it("forgets a cached validator when the endpoint stops sending one", async () => {
    const tagged = jsonResponse(envelope({ status: "ok" }), { headers: { etag: "W/\"1\"" } });
    const untagged = jsonResponse(envelope({ status: "ok" }));
    const fetchImpl = respondingWith(tagged, untagged, untagged);
    const api = client({ fetchImpl });

    await api.health();
    await api.health();
    await api.health();

    expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe("W/\"1\"");
    expect(fetchImpl.mock.calls[2][1].headers["If-None-Match"]).toBeUndefined();
  });

  it("evicts the oldest endpoint once the cache is full", async () => {
    const fetchImpl = vi.fn(async (url) => jsonResponse(envelope({ url }), {
      headers: { etag: `W/"${url}"` },
    }));
    const api = client({ fetchImpl, maxEtagEntries: 2 });

    await api.details("XNAS:AAPL");
    await api.details("XNAS:MSFT");
    await api.details("XNAS:NVDA");

    expect(api.etagCache.size).toBe(2);
    expect([...api.etagCache.keys()].some((key) => key.includes("AAPL"))).toBe(false);
  });

  it("tolerates a cache adapter that cannot be iterated for eviction", async () => {
    const store = new Map();
    const etagCache = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      clear: () => store.clear(),
    };
    const fetchImpl = vi.fn(async (url) => jsonResponse(envelope({ url }), {
      headers: { etag: `W/"${url}"` },
    }));
    const api = client({ fetchImpl, etagCache, maxEtagEntries: 1 });

    await api.details("XNAS:AAPL");
    await api.details("XNAS:MSFT");
    expect(store.size).toBe(2);
  });

  it("stores a tombstone when an adapter cannot delete", async () => {
    const store = new Map();
    const etagCache = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      clear: () => store.clear(),
    };
    const tagged = jsonResponse(envelope({ status: "ok" }), { headers: { etag: "W/\"1\"" } });
    const untagged = jsonResponse(envelope({ status: "ok" }));
    const fetchImpl = respondingWith(tagged, untagged);
    const api = client({ fetchImpl, etagCache });

    await api.health();
    await api.health();
    expect(store.get("/api/market/v1/health")).toBeNull();
  });
});

describe("cancellation and timeouts", () => {
  it("refuses a request whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    const fetchImpl = vi.fn();

    await expect(client({ fetchImpl }).health({ signal: controller.signal }))
      .rejects.toThrowError("caller went away");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("raises an AbortError when the caller aborts without a reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await client({ fetchImpl: vi.fn() })
      .health({ signal: controller.signal })
      .catch((caught) => caught);
    expect(error.name).toBe("AbortError");
  });

  it("stops reading a response the caller abandoned mid-flight", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort(new Error("caller went away"));
      return jsonResponse(envelope({ status: "ok" }));
    });

    await expect(client({ fetchImpl }).health({ signal: controller.signal }))
      .rejects.toThrowError("caller went away");
  });

  it("reports a timeout as retryable and names the budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = client({ fetchImpl, timeoutMs: 50 }).health();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      message: expect.stringContaining("50ms"),
    });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("never arms a timer when the budget is zero", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = respondingWith(jsonResponse(envelope({ status: "ok" })));
    await client({ fetchImpl, timeoutMs: 0 }).health();
    expect(timeout).not.toHaveBeenCalled();
  });

  it("clears its timer once the request settles", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const fetchImpl = respondingWith(jsonResponse(envelope({ status: "ok" })));
    await client({ fetchImpl, timeoutMs: 5_000 }).health();
    expect(clear).toHaveBeenCalled();
  });
});

const article = (patch = {}) => ({
  id: "yahoo:aapl-1",
  title: "Apple expands its developer tools",
  publisher: "Reuters",
  url: "https://news.example/apple-tools",
  publishedAt: "2026-07-13T19:30:00.000Z",
  instrumentIds: ["XNAS:AAPL"],
  provider: "yahoo",
  ...patch,
});

const feed = (patch = {}) => ({
  instrumentId: "XNAS:AAPL",
  articles: [article()],
  source: "yahoo",
  quality: "fresh",
  asOf: "2026-07-13T19:30:00.000Z",
  fetchedAt: GENERATED_AT,
  ...patch,
});

const newsEnvelope = (data, patch = {}) => ({
  ...envelope(data),
  sources: { news: ["yahoo"] },
  ...patch,
});

function newsRejects(payload) {
  const fetchImpl = respondingWith(jsonResponse(payload));
  return expect(client({ fetchImpl }).news("XNAS:AAPL")).rejects.toMatchObject({
    code: "schema_invalid",
    retryable: false,
  });
}

function batchRejects(payload) {
  const fetchImpl = respondingWith(jsonResponse(payload));
  return expect(client({ fetchImpl }).newsBatch(["XNAS:AAPL"])).rejects.toMatchObject({
    code: "schema_invalid",
    retryable: false,
  });
}

describe("news article validation", () => {
  it("accepts a well-formed feed", async () => {
    const fetchImpl = respondingWith(jsonResponse(newsEnvelope(feed())));
    await expect(client({ fetchImpl }).news("XNAS:AAPL")).resolves.toMatchObject({
      data: { instrumentId: "XNAS:AAPL" },
    });
  });

  it.each([
    ["a non-object article", "story"],
    ["a blank id", article({ id: "   " })],
    ["a non-string title", article({ title: 42 })],
    ["a blank publisher", article({ publisher: "  " })],
    ["an unparseable url", article({ url: "not-a-url" })],
    ["a plain-HTTP url", article({ url: "http://news.example/a" })],
    ["a url carrying credentials", article({ url: "https://user:pw@news.example/a" })],
    ["an unreadable publish time", article({ publishedAt: "yesterday" })],
    ["no instrument ids", article({ instrumentIds: [] })],
    ["instrument ids that are not an array", article({ instrumentIds: "XNAS:AAPL" })],
    ["a non-canonical instrument id", article({ instrumentIds: ["AAPL"] })],
    ["a repeated instrument id", article({ instrumentIds: ["XNAS:AAPL", "XNAS:AAPL"] })],
    ["an unknown provider", article({ provider: "reuters" })],
    ["an id that is not namespaced", article({ id: "aapl-1" })],
    ["an id that is only its namespace", article({ id: "yahoo:" })],
  ])("rejects %s", async (_label, entry) => {
    await newsRejects(newsEnvelope(feed({ articles: [entry] })));
  });
});

describe("news feed validation", () => {
  it.each([
    ["a non-object feed", "feed"],
    ["a non-canonical instrument", feed({ instrumentId: "AAPL" })],
    ["articles that are not an array", feed({ articles: null })],
    ["more articles than the per-instrument cap", feed({
      articles: Array.from({ length: 9 }, (_, index) => article({
        id: `yahoo:aapl-${index}`,
        url: `https://news.example/a-${index}`,
      })),
    })],
    ["an article for another instrument", feed({
      articles: [article({ instrumentIds: ["XNAS:MSFT"] })],
    })],
    ["an unknown source", feed({ source: "reuters" })],
    ["an unknown quality", feed({ quality: "cached" })],
    ["an unreadable asOf", feed({ asOf: "recently" })],
    ["an unreadable fetchedAt", feed({ fetchedAt: null })],
    ["a last-known-good feed with no original source", feed({
      source: "last-known-good",
      quality: "stale",
    })],
  ])("rejects %s", async (_label, payload) => {
    await newsRejects(newsEnvelope(payload));
  });

  it("accepts a last-known-good feed that names its original source", async () => {
    const fetchImpl = respondingWith(jsonResponse(newsEnvelope(
      feed({ source: "last-known-good", quality: "stale", originalSource: "yahoo" }),
      { sources: { news: ["last-known-good"] } },
    )));
    await expect(client({ fetchImpl }).news("XNAS:AAPL")).resolves.toBeDefined();
  });

  it("rejects a feed for an instrument the caller did not request", async () => {
    const fetchImpl = respondingWith(jsonResponse(newsEnvelope(
      feed({ instrumentId: "XNAS:MSFT", articles: [article({ instrumentIds: ["XNAS:MSFT"] })] }),
    )));
    await expect(client({ fetchImpl }).news("XNAS:AAPL")).rejects
      .toThrowError(/news for the wrong instrument/u);
  });
});

describe("news provenance and batch validation", () => {
  it.each([
    ["sources that are not an object", { sources: null }],
    ["a news source list that is not an array", { sources: { news: "yahoo" } }],
    ["an unknown source", { sources: { news: ["reuters"] } }],
    ["a repeated source", { sources: { news: ["yahoo", "yahoo"] } }],
  ])("rejects %s", async (_label, patch) => {
    await newsRejects(newsEnvelope(feed(), patch));
  });

  it.each([
    ["data that is not an object", "articles"],
    ["articles that are not an array", { articles: null }],
    ["more articles than the batch cap", {
      articles: Array.from({ length: 21 }, (_, index) => article({
        id: `yahoo:a-${index}`,
        url: `https://news.example/a-${index}`,
      })),
    }],
  ])("rejects a batch with %s", async (_label, data) => {
    await batchRejects(newsEnvelope(data));
  });

  it.each([
    ["a duplicate article id", [article(), article({ url: "https://news.example/other" })]],
    ["a duplicate article url", [article(), article({ id: "yahoo:aapl-2", url: "https://news.example/apple-tools#tail" })]],
  ])("rejects a batch containing %s", async (_label, articles) => {
    await batchRejects(newsEnvelope({ articles }));
  });

  it.each([
    ["a non-object entry", "boom"],
    ["a non-canonical instrument", { instrumentId: "AAPL", code: "timeout", message: "x", retryable: true }],
    ["a blank code", { instrumentId: "XNAS:MSFT", code: "  ", message: "x", retryable: true }],
    ["a blank message", { instrumentId: "XNAS:MSFT", code: "timeout", message: " ", retryable: true }],
    ["a non-boolean retryable", { instrumentId: "XNAS:MSFT", code: "timeout", message: "x", retryable: "yes" }],
  ])("rejects a batch error entry with %s", async (_label, error) => {
    await batchRejects(newsEnvelope({ articles: [] }, { errors: [error] }));
  });

  it("rejects a batch repeating a per-instrument error", async () => {
    const entry = { instrumentId: "XNAS:MSFT", code: "timeout", message: "x", retryable: true };
    await batchRejects(newsEnvelope({ articles: [] }, { errors: [entry, { ...entry, code: "other" }] }));
  });

  it.each([
    ["in meta", { meta: { apiVersion: "v1", schemaVersion: 2, lastUpdatedAt: "recently" } }],
    ["at the top level", { lastUpdatedAt: "recently" }],
  ])("rejects an unreadable lastUpdatedAt %s", async (_label, patch) => {
    await batchRejects({ ...newsEnvelope({ articles: [] }), ...patch });
  });

  it("accepts a batch with declared errors and a readable lastUpdatedAt", async () => {
    const fetchImpl = respondingWith(jsonResponse(newsEnvelope({ articles: [article()] }, {
      errors: [{ instrumentId: "XNAS:MSFT", code: "timeout", message: "slow", retryable: true }],
      lastUpdatedAt: GENERATED_AT,
    })));
    await expect(client({ fetchImpl }).newsBatch(["XNAS:AAPL", "XNAS:MSFT"])).resolves.toBeDefined();
  });
});

describe("analytics envelope validation", () => {
  const record = (patch = {}) => ({
    instrumentId: "XNAS:AAPL",
    runId: `sha256:${"a".repeat(64)}`,
    computedAt: GENERATED_AT,
    assessment: {
      schemaVersion: 1,
      instrumentId: "XNAS:AAPL",
      status: "available",
      sessionDate: "2026-07-13",
      quality: { reasonCodes: [] },
      forecast: { instrumentId: "XNAS:AAPL" },
      evidence: { instrumentId: "XNAS:AAPL" },
    },
    ...patch,
  });

  const rejects = (data) => {
    const fetchImpl = respondingWith(jsonResponse(envelope(data)));
    return expect(client({ fetchImpl }).analyticsSnapshot(["XNAS:AAPL"])).rejects.toMatchObject({
      code: "schema_invalid",
      retryable: false,
    });
  };

  it("accepts a well-formed ledger page", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope([record()])));
    await expect(client({ fetchImpl }).analyticsSnapshot(["XNAS:AAPL"])).resolves.toBeDefined();
  });

  it("accepts an unavailable assessment carrying no results", async () => {
    const fetchImpl = respondingWith(jsonResponse(envelope([record({
      assessment: {
        schemaVersion: 1,
        instrumentId: "XNAS:AAPL",
        status: "unavailable",
        sessionDate: null,
        quality: { reasonCodes: ["stale_input"] },
        forecast: null,
        evidence: null,
      },
    })])));
    await expect(client({ fetchImpl }).analyticsSnapshot(["XNAS:AAPL"])).resolves.toBeDefined();
  });

  it.each([
    ["data that is not an array", "records"],
    ["more records than instruments can be requested", Array.from({ length: 41 }, () => record())],
  ])("rejects %s", async (_label, data) => {
    await rejects(data);
  });

  it.each([
    ["a non-object record", "record"],
    ["a non-canonical instrument", record({ instrumentId: "AAPL" })],
    ["a malformed run id", record({ runId: "sha256:short" })],
    ["an unreadable computedAt", record({ computedAt: "recently" })],
    ["a non-object assessment", record({ assessment: "available" })],
  ])("rejects %s", async (_label, entry) => {
    await rejects([entry]);
  });

  it("rejects a repeated instrument", async () => {
    await rejects([record(), record()]);
  });

  it.each([
    ["a schema version from another release", { schemaVersion: 2 }],
    ["an instrument that contradicts its record", { instrumentId: "XNAS:MSFT" }],
    ["an unsupported status", { status: "partial" }],
    ["a malformed session date", { sessionDate: "13-07-2026" }],
    ["quality that is not an object", { quality: null }],
  ])("rejects an assessment with %s", async (_label, patch) => {
    await rejects([record({ assessment: { ...record().assessment, ...patch } })]);
  });

  it.each([
    ["no forecast", { forecast: null }],
    ["no evidence", { evidence: null }],
  ])("rejects an available assessment with %s", async (_label, patch) => {
    await rejects([record({ assessment: { ...record().assessment, ...patch } })]);
  });

  it.each([
    ["a forecast", { forecast: { instrumentId: "XNAS:AAPL" } }],
    ["evidence", { evidence: { instrumentId: "XNAS:AAPL" } }],
  ])("rejects an unavailable assessment carrying %s", async (_label, patch) => {
    await rejects([record({
      assessment: {
        schemaVersion: 1,
        instrumentId: "XNAS:AAPL",
        status: "unavailable",
        sessionDate: null,
        quality: {},
        forecast: null,
        evidence: null,
        ...patch,
      },
    })]);
  });
});
