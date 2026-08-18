import { describe, expect, it, vi } from "vitest";
import { createMarketDataHandler } from "../../server/http/createMarketDataHandler.js";
import {
  CAPABILITY_REVISION,
  MAX_BATCH_IDS,
  MARKET_SCHEMA_VERSION,
} from "../../server/contracts/market/constants.js";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import { MarketDataError } from "../../server/errors/MarketDataError.js";
import { Telemetry } from "../../server/observability/Telemetry.js";

const BASE = "https://marketmap.test/api/market/v1";

function buildHandler(overrides = {}) {
  return createMarketDataHandler({
    service: { getHealth: () => ({ status: "ok", providers: {} }) },
    clock: () => Date.parse("2026-07-16T20:00:00.000Z"),
    requestIdFactory: () => "req-v1-test",
    ...overrides,
  });
}

async function requestJson(handler, path, init = {}) {
  const response = await handler(new Request(`${BASE}${path}`, init));
  return { response, body: await response.json() };
}

describe("market API v1", () => {
  it("reports an unimplemented health probe rather than an internal error", async () => {
    const handler = buildHandler({ service: { getSnapshot: async () => ({ data: [] }) } });
    const { response, body } = await requestJson(handler, "/health");
    expect(response.status).toBe(501);
    expect(body.code).toBe(ERROR_CODES.NOT_IMPLEMENTED);
  });

  it("serves health with schema-2 meta, feature policy and manifest revisions", async () => {
    const telemetry = new Telemetry();
    const handler = buildHandler({ telemetry });
    const { response, body } = await requestJson(handler, "/health");
    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      apiVersion: "v1",
      schemaVersion: MARKET_SCHEMA_VERSION,
      semanticRevision: "market-data@1",
      capabilityRevision: CAPABILITY_REVISION,
      requestId: "req-v1-test",
    });
    expect(body.data.enabledAssetClasses).toEqual([
      "equity",
      "etf",
      "index",
      "fx",
      "crypto",
      "commodity_future",
      "rate_index",
    ]);
    expect(body.data.manifests).toEqual({
      yahoo: { manifestVersion: 1 },
      finnhub: { manifestVersion: 1 },
    });
    const counters = telemetry.snapshot().counters;
    expect(counters["v1_request{endpoint=health,outcome=ok}"]).toBe(1);
    expect(counters["api_request_total{apiVersion=v1,endpoint=health,outcome=ok}"]).toBe(1);
  });

  it("honours a custom feature policy and rejects an invalid one", async () => {
    const handler = buildHandler({ enabledAssetClasses: ["equity", "etf"] });
    const { body } = await requestJson(handler, "/health");
    expect(body.data.enabledAssetClasses).toEqual(["equity", "etf"]);
    expect(() => buildHandler({ enabledAssetClasses: ["bond"] })).toThrowError();
  });

  it("keeps the configurable transport limit independent from board size", async () => {
    const getSnapshot = vi.fn(async (ids) => ({ data: [], errors: ids.map((instrumentId) => ({
      instrumentId,
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      message: "fixture",
      retryable: true,
    })) }));
    const handler = buildHandler({
      maxBatchIds: 2,
      service: { getHealth: () => ({ status: "ok" }), getSnapshot },
    });

    const accepted = await requestJson(handler, "/snapshot?ids=XNAS:AAPL,XNAS:MSFT");
    const rejected = await requestJson(handler, "/snapshot?ids=XNAS:AAPL,XNAS:MSFT,XNAS:NVDA");

    expect(accepted.response.status).toBe(200);
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.details.maxBatchIds).toBe(2);
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(() => buildHandler({ maxBatchIds: 0 })).toThrow(/between 1 and 1000/);
  });

  it("renews the refresh hint on a revalidated snapshot response", async () => {
    const refreshHints = [
      "2026-07-16T20:00:05.000Z",
      "2026-07-16T20:00:10.000Z",
    ];
    const handler = buildHandler({
      service: {
        getHealth: () => ({ status: "ok" }),
        getSnapshot: vi.fn(async () => ({
          data: [],
          nextRefreshAt: refreshHints.shift(),
        })),
      },
    });
    const first = await handler(new Request(`${BASE}/snapshot?ids=XNAS:AAPL`));
    const etag = first.headers.get("etag");
    const second = await handler(new Request(`${BASE}/snapshot?ids=XNAS:AAPL`, {
      headers: { "if-none-match": etag },
    }));

    expect(first.status).toBe(200);
    expect(first.headers.get("x-next-refresh-at")).toBe("2026-07-16T20:00:05.000Z");
    expect(second.status).toBe(304);
    expect(second.headers.get("x-next-refresh-at")).toBe("2026-07-16T20:00:10.000Z");
  });

  it("does not expose unknown upstream Error messages in problems or item errors", async () => {
    const secret = "upstream-secret";
    const upstream = () => new Error(`request failed https://provider.test/data?api_key=${secret}`);
    const problem = await requestJson(buildHandler({
      service: { getHealth: vi.fn(async () => { throw upstream(); }) },
    }), "/health");
    const item = await requestJson(buildHandler({
      service: {
        getHealth: () => ({ status: "ok" }),
        getSnapshot: vi.fn(async () => ({ data: [], errors: [upstream()] })),
      },
    }), "/snapshot?ids=XNAS:AAPL");

    expect(problem.response.status).toBe(500);
    expect(problem.body.detail).toBe("Internal market data error");
    expect(item.body.errors[0].message).toBe("Market data unavailable");
    for (const body of [problem.body, item.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("api_key=");
      expect(serialized).not.toContain("https://provider.test");
    }
  });

  it("uses a bounded telemetry label for unknown routes", async () => {
    const telemetry = new Telemetry();
    const handler = buildHandler({ telemetry });

    await requestJson(handler, "/private/customer-123/resource-456");

    const counters = telemetry.snapshot().counters;
    expect(counters["v1_request{endpoint=not-found,outcome=error}"]).toBe(1);
    expect(counters["api_request_total{apiVersion=v1,endpoint=not-found,outcome=error}"]).toBe(1);
    expect(Object.keys(counters).join(" ")).not.toContain("customer-123");
  });

  it("validates snapshot input before declaring it unimplemented", async () => {
    const handler = buildHandler();
    const missing = await requestJson(handler, "/snapshot");
    expect(missing.response.status).toBe(400);
    expect(missing.body.code).toBe(ERROR_CODES.INVALID_REQUEST);

    const tooMany = await requestJson(handler, `/snapshot?ids=${Array.from(
      { length: MAX_BATCH_IDS + 1 },
      (_, index) => `XNAS:T${index}`,
    ).join(",")}`);
    expect(tooMany.response.status).toBe(400);

    const valid = await requestJson(handler, "/snapshot?ids=XNAS:AAPL,ARCX:SPY");
    expect(valid.response.status).toBe(501);
    expect(valid.body.code).toBe(ERROR_CODES.NOT_IMPLEMENTED);
    expect(valid.body.retryable).toBe(false);
    expect(valid.body.details).toMatchObject({ operation: "snapshot", plannedTranche: "tranche-2" });
  });

  it("rejects an unsupported price basis with unsupported_semantics", async () => {
    const handler = buildHandler();
    const { response, body } = await requestJson(
      handler,
      "/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=total_return",
    );
    expect(response.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.UNSUPPORTED_SEMANTICS);
    expect(body.details.requestedPriceBasis).toBe("total_return");

    const supported = await requestJson(
      handler,
      "/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=provider_adjusted",
    );
    expect(supported.response.status).toBe(501);
  });

  it("validates search filters against the current taxonomy", async () => {
    const handler = buildHandler();
    const shortQuery = await requestJson(handler, "/instruments/search?q=a");
    expect(shortQuery.response.status).toBe(400);

    const legacyClass = await requestJson(handler, "/instruments/search?q=apple&assetClass=mutual_fund");
    expect(legacyClass.response.status).toBe(400);

    const valid = await requestJson(handler, "/instruments/search?q=apple&assetClass=etf,fx&includeUnsupported=true");
    expect(valid.response.status).toBe(501);
    expect(valid.body.details.plannedTranche).toBe("tranche-1");
  });

  it("keeps instrument routes validated and unimplemented", async () => {
    const handler = buildHandler();
    const descriptor = await requestJson(handler, "/instruments/XNAS:AAPL");
    expect(descriptor.response.status).toBe(501);
    expect(descriptor.body.details.operation).toBe("instrument");

    const details = await requestJson(handler, "/instruments/XNAS:AAPL/details");
    expect(details.response.status).toBe(501);

    const invalidId = await requestJson(handler, "/instruments/aapl!");
    expect(invalidId.response.status).toBe(400);
  });

  it("serves the persisted movement snapshot with batch semantics and ETag", async () => {
    const telemetry = new Telemetry();
    const record = {
      instrumentId: "XNAS:AAPL",
      runId: `sha256:${"a".repeat(64)}`,
      computedAt: "2026-07-27T23:00:00.000Z",
      assessment: { schemaVersion: 1, instrumentId: "XNAS:AAPL", status: "available" },
    };
    const getAnalyticsSnapshot = vi.fn(async (ids) => ({
      data: ids.filter((id) => id === "XNAS:AAPL").map(() => record),
      errors: [new MarketDataError(ERROR_CODES.PERSISTENCE_UNAVAILABLE, "read failed", {
        instrumentId: "XNAS:MSFT",
      })],
    }));
    const handler = buildHandler({
      telemetry,
      service: { getHealth: () => ({ status: "ok" }), getAnalyticsSnapshot },
    });

    const { response, body } = await requestJson(
      handler,
      "/analytics/snapshot?ids=XNAS:AAPL,XNAS:MSFT",
    );
    expect(response.status).toBe(200);
    expect(getAnalyticsSnapshot).toHaveBeenCalledWith(
      ["XNAS:AAPL", "XNAS:MSFT"],
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(body.data).toEqual([record]);
    expect(body.errors).toMatchObject([{
      instrumentId: "XNAS:MSFT",
      operation: "analytics",
      code: ERROR_CODES.PERSISTENCE_UNAVAILABLE,
      retryable: true,
    }]);
    expect(body.meta.generatedAt).toBe("2026-07-16T20:00:00.000Z");

    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const revalidated = await handler(new Request(
      `${BASE}/analytics/snapshot?ids=XNAS:AAPL,XNAS:MSFT`,
      { headers: { "if-none-match": etag } },
    ));
    expect(revalidated.status).toBe(304);
    const counters = telemetry.snapshot().counters;
    expect(counters["v1_request{endpoint=analytics-snapshot,outcome=partial}"]).toBe(2);
  });

  it("caps analytics batches at 40 ids regardless of the transport limit", async () => {
    const getAnalyticsSnapshot = vi.fn(async () => ({ data: [] }));
    const handler = buildHandler({
      maxBatchIds: 100,
      service: { getHealth: () => ({ status: "ok" }), getAnalyticsSnapshot },
    });
    const ids = Array.from({ length: 41 }, (_, index) => `XNAS:T${String(index).padStart(2, "0")}`);

    const rejected = await requestJson(handler, `/analytics/snapshot?ids=${ids.join(",")}`);
    expect(rejected.response.status).toBe(400);
    const invalid = await requestJson(handler, "/analytics/snapshot?ids=aapl!");
    expect(invalid.response.status).toBe(400);
    expect(getAnalyticsSnapshot).not.toHaveBeenCalled();

    const accepted = await requestJson(
      handler,
      `/analytics/snapshot?ids=${ids.slice(0, 40).join(",")}`,
    );
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.data).toEqual([]);
  });

  it("rejects non-GET methods and unknown routes", async () => {
    const handler = buildHandler();
    const post = await requestJson(handler, "/snapshot?ids=XNAS:AAPL", { method: "POST" });
    expect(post.response.status).toBe(405);
    expect(post.response.headers.get("allow")).toBe("GET");

    const unknown = await requestJson(handler, "/quotes");
    expect(unknown.response.status).toBe(404);

    const profile = await requestJson(handler, "/instruments/XNAS:AAPL/profile");
    expect(profile.response.status).toBe(404);

    const unconfiguredAnalytics = await requestJson(handler, "/analytics/snapshot?ids=XNAS:AAPL");
    expect(unconfiguredAnalytics.response.status).toBe(501);
    expect(unconfiguredAnalytics.body.code).toBe("not_implemented");

    const removedV2 = await handler(new Request("https://marketmap.test/api/market/v2/health"));
    expect(removedV2.status).toBe(404);
  });
});

const INTERNALS = {
  status: "degraded",
  providers: {
    yahoo: { enabled: true, capabilities: { quote: true }, quarantinedCapabilities: { news: "x" } },
  },
  persistence: { enabled: true, healthy: false, adapter: "MySQLSnapshotStore", entries: 812 },
  memoryCache: { entries: 44 },
  singleFlight: { active: 3 },
  circuits: { "yahoo:quote": { state: "open", retryAt: 1_786_392_002_000 } },
  telemetry: { counters: { provider_error: 12 } },
};

describe("market API v1 health disclosure", () => {
  it("withholds circuits, cache depth and telemetry from an unauthenticated probe", async () => {
    const handler = buildHandler({ service: { getHealth: () => INTERNALS } });
    const { body } = await requestJson(handler, "/health");
    expect(body.data.status).toBe("degraded");
    expect(body.data.providers).toEqual({ yahoo: { enabled: true } });
    expect(body.data.persistence).toEqual({ enabled: true });
    for (const withheld of ["circuits", "memoryCache", "singleFlight", "telemetry"]) {
      expect(Object.hasOwn(body.data, withheld)).toBe(false);
    }
    expect(body.data.enabledAssetClasses).toBeInstanceOf(Array);
  });

  it("serves the whole picture once a host opts in", async () => {
    const handler = buildHandler({
      service: { getHealth: () => INTERNALS },
      exposeHealthInternals: true,
    });
    const { body } = await requestJson(handler, "/health");
    const { capabilities, enabledAssetClasses, maxBatchIds, manifests, ...restored } = body.data;
    expect(restored).toEqual(INTERNALS);
    expect(capabilities).toEqual(["health"]);
    expect(enabledAssetClasses).toBeInstanceOf(Array);
    expect(manifests).toBeTruthy();
    expect(maxBatchIds).toBeGreaterThan(0);
  });

  it("names the operations the wired service actually implements, so a client stops guessing", async () => {
    const handler = buildHandler({
      service: {
        getHealth: () => ({ status: "ok", providers: {} }),
        getSnapshot: async () => ({ data: [] }),
        getDetails: async () => ({ data: {} }),
        getNews: async () => ({ data: { articles: [] } }),
      },
      resolver: { searchInstruments: async () => [] },
    });
    const { body } = await requestJson(handler, "/health");
    expect(body.data.capabilities).toEqual([
      "details",
      "health",
      "instrument",
      "news",
      "search",
      "snapshot",
    ]);
    expect(body.data.capabilities).not.toContain("analytics-snapshot");
  });

  it("omits the resolver operations when no resolver is wired", async () => {
    const handler = buildHandler({
      service: {
        getHealth: () => ({ status: "ok", providers: {} }),
        getAnalyticsSnapshot: async () => ({ data: [] }),
      },
    });
    const { body } = await requestJson(handler, "/health");
    expect(body.data.capabilities).toEqual(["analytics-snapshot", "health"]);
  });
});

describe("market API v1 request quota", () => {
  const clientKey = (request) => request.headers.get("x-client") || null;
  const SEARCH_COST = 8;

  const metered = (quota, overrides = {}) => buildHandler({
    service: {
      getHealth: () => ({ status: "ok" }),
      getSnapshot: async () => ({ data: [] }),
      getDetails: async () => ({ data: {} }),
    },
    resolver: { searchInstruments: async () => [] },
    maxBatchIds: 3,
    quota: { clientKey, windowMs: 60_000, ...quota },
    ...overrides,
  });

  const spend = async (handler, path, times, headers) => {
    for (let attempt = 0; attempt < times; attempt += 1) {
      const { response } = await requestJson(handler, path, { headers });
      expect(response.status, `${path} #${attempt + 1}`).toBe(200);
    }
  };

  it("refuses a handler whose host cannot identify a caller", () => {
    expect(() => buildHandler({ quota: { limit: 10 } })).toThrow(TypeError);
  });

  it("refuses an allowance the dearest single request could never afford", () => {
    expect(() => buildHandler({ maxBatchIds: 3, quota: { clientKey, limit: SEARCH_COST - 1 } }))
      .toThrow(RangeError);
    expect(() => buildHandler({ maxBatchIds: 3, quota: { clientKey, limit: SEARCH_COST } }))
      .not.toThrow();
    expect(() => buildHandler({ maxBatchIds: 40, quota: { clientKey, limit: 39 } }))
      .toThrow(RangeError);
  });

  it("answers 429 with retry-after once a client spends its allowance", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "alice" };
    await spend(handler, "/health", 8, headers);

    const { response, body } = await requestJson(handler, "/health", { headers });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
    expect(body.code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
    expect(body.retryable).toBe(true);
  });

  it("charges a batch by the instruments it asks for", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "bob" };
    const path = "/snapshot?ids=XNAS:AAPL,XNAS:MSFT,ARCX:SPY";
    await spend(handler, path, 2, headers);
    expect((await requestJson(handler, path, { headers })).response.status).toBe(429);
    await spend(handler, "/health", 2, headers);
  });

  it("charges search for the instruments it may hydrate, not for one request", async () => {
    const handler = metered({ limit: 16 });
    const headers = { "x-client": "jude" };
    await spend(handler, "/instruments/search?q=apple", 1, headers);
    await spend(handler, "/health", 8, headers);
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("charges details for its cold-resolve hydration as well as its two own calls", async () => {
    const handler = metered({ limit: 9 });
    const headers = { "x-client": "kira" };
    await spend(handler, "/instruments/XNAS:AAPL/details", 3, headers);
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("does not charge details less than three", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "liam" };
    await spend(handler, "/instruments/XNAS:AAPL/details", 2, headers);
    expect((await requestJson(handler, "/instruments/XNAS:AAPL/details", { headers })).response.status)
      .toBe(429);
  });

  it("charges one for a route that does not take instruments, whatever ids it carries", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "erin" };
    await spend(handler, "/health?ids=XNAS:AAPL,XNAS:MSFT,ARCX:SPY", 8, headers);
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("takes nothing from a caller whose batch it refuses", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "iris" };
    await spend(handler, "/health", 6, headers);

    const refused = await requestJson(handler, "/snapshot?ids=XNAS:AAPL,XNAS:MSFT,ARCX:SPY", { headers });
    expect(refused.response.status).toBe(429);

    await spend(handler, "/health", 2, headers);
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("charges one, not the batch, for a batch whose ids do not validate", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "gina" };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { response } = await requestJson(handler, "/snapshot?ids=not-an-id", { headers });
      expect(response.status).toBe(400);
    }
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("charges one for a batch the service cannot serve at all", async () => {
    const handler = buildHandler({
      service: { getHealth: () => ({ status: "ok" }) },
      maxBatchIds: 3,
      quota: { clientKey, limit: 8, windowMs: 60_000 },
    });
    const headers = { "x-client": "hank" };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { response } = await requestJson(handler, "/snapshot?ids=XNAS:AAPL,XNAS:MSFT,ARCX:SPY", { headers });
      expect(response.status).toBe(501);
    }
    expect((await requestJson(handler, "/health", { headers })).response.status).toBe(429);
  });

  it("does not charge for a route it does not serve", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "frank" };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await requestJson(handler, "/nope?ids=XNAS:AAPL", { headers })).response.status).toBe(404);
    }
    await spend(handler, "/health", 8, headers);
  });

  it("keeps one caller's spending off another's allowance", async () => {
    const handler = metered({ limit: 8 });
    await spend(handler, "/health", 8, { "x-client": "a" });
    expect((await requestJson(handler, "/health", { headers: { "x-client": "a" } })).response.status).toBe(429);
    expect((await requestJson(handler, "/health", { headers: { "x-client": "b" } })).response.status).toBe(200);
  });

  it("lets a request the host declined to identify through unmetered", async () => {
    const handler = metered({ limit: 8 });
    await spend(handler, "/health", 20);
  });

  it("refuses to serve a caller the host could not reduce to a scalar", async () => {
    const handler = metered({ limit: 8 }, {
      quota: { clientKey: () => ({}), limit: 8, windowMs: 60_000 },
    });
    const { response, body } = await requestJson(handler, "/health");
    expect(response.status).toBe(500);
    expect(body.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });

  it("refuses to serve a caller whose identification threw", async () => {
    const handler = metered({ limit: 8 }, {
      quota: {
        clientKey: () => { throw new Error("proxy header missing"); },
        limit: 8,
        windowMs: 60_000,
      },
    });
    const { response, body } = await requestJson(handler, "/health");
    expect(response.status).toBe(500);
    expect(body.detail).not.toContain("proxy header missing");
  });

  it("counts a rejection in telemetry against the endpoint that was asked for", async () => {
    const telemetry = new Telemetry();
    const handler = metered({ limit: 8 }, { telemetry });
    const headers = { "x-client": "carol" };
    await spend(handler, "/health", 8, headers);
    await requestJson(handler, "/health", { headers });
    expect(telemetry.snapshot().counters["quota_rejected_total{endpoint=health}"]).toBe(1);
  });

  it("does not meter a request it is going to reject as a bad method", async () => {
    const handler = metered({ limit: 8 });
    const headers = { "x-client": "dave" };
    expect((await requestJson(handler, "/health", { method: "POST", headers })).response.status).toBe(405);
    await spend(handler, "/health", 8, headers);
  });
});
