import { describe, expect, it, vi } from "vitest";
import { InMemoryAnalyticsStore } from "../../server/analytics/persistence/InMemoryAnalyticsStore.js";
import { MySQLSnapshotStore } from "../../server/cache/MySQLSnapshotStore.js";
import { createMarketDataService } from "../../server/createMarketDataService.js";
import { YahooClient } from "../../server/providers/yahoo/yahooClient.js";
import { MySQLInstrumentCatalogStore } from "../../server/instruments/MySQLInstrumentCatalogStore.js";
import { AnalyticsEngine } from "../../server/analytics/AnalyticsEngine.js";
import { movementFixture } from "./analytics/fixtures.js";
import { catalogDescriptorResolver } from "./fixtures/market/curatedDescriptors.js";

function quote(instrumentId) {
  const timestamp = "2026-07-13T20:00:00.000Z";
  return {
    instrumentId,
    price: 317.31,
    change: 1.99,
    changePercent: 0.63,
    open: 317.01,
    previousClose: 315.32,
    dayHigh: 323.45,
    dayLow: 315.78,
    bid: null,
    ask: null,
    volume: 1,
    averageVolume3m: 2,
    marketState: "closed",
    asOf: timestamp,
    fetchedAt: timestamp,
    currency: "USD",
    quality: "fresh",
    source: "yahoo",
  };
}

function lifecycleProvider() {
  return {
    id: "fixture",
    capabilities: () => ({}),
    supports: () => false,
  };
}

describe("createMarketDataService", () => {
  it("wires a provider fixture through core and the web-standard handler", async () => {
    const getSnapshot = vi.fn(async (ids) => ({
      data: ids.map((instrumentId) => quote(instrumentId)),
      errors: [],
      sources: { quote: ["yahoo"] },
      descriptorRevision: 1,
      nextRefreshAt: "2026-07-13T20:05:00.000Z",
    }));
    const orchestrator = {
      getSnapshot,
      getHistory: vi.fn(),
      getHistoryBatch: vi.fn(),
      getDetails: vi.fn(),
      getNews: vi.fn(),
      getNewsBatch: vi.fn(),
      getHealth: vi.fn(() => ({ status: "ok", providers: {} })),
      searchInstruments: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      orchestrator,
      logLevel: "silent",
      clock: () => Date.parse("2026-07-13T20:00:00.000Z"),
      requestIdFactory: () => "factory-test",
    });
    const response = await service.handleRequest(new Request(
      "http://localhost/api/market/v1/snapshot?ids=XNAS:AAPL",
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", price: 317.31 });
    expect(payload.meta).toMatchObject({ apiVersion: "v1", schemaVersion: 2 });
    expect(payload.meta.requestId).toBe("factory-test");
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it("exposes current instrument search through the resolver, not the legacy orchestrator facade", async () => {
    const results = [{ id: "XNAS:AAPL", displaySymbol: "AAPL" }];
    const resolver = {
      searchInstruments: vi.fn(async () => results),
      capabilitiesFor: vi.fn(),
      isAddable: vi.fn(),
    };
    const orchestrator = {
      getSnapshot: vi.fn(),
      getHistory: vi.fn(),
      getHistoryBatch: vi.fn(),
      getDetails: vi.fn(),
      getNews: vi.fn(),
      getNewsBatch: vi.fn(),
      getHealth: vi.fn(() => ({ status: "ok", providers: {} })),
      searchInstruments: vi.fn(async () => {
        throw new Error("legacy search must not be called");
      }),
      close: vi.fn(async () => {}),
    };
    const service = createMarketDataService({
      providers: [lifecycleProvider()],
      orchestrator,
      resolver,
      logLevel: "silent",
    });

    await expect(service.searchInstruments("apple", { limit: 5 })).resolves.toBe(results);
    expect(resolver.searchInstruments).toHaveBeenCalledWith("apple", { limit: 5 });
    expect(orchestrator.searchInstruments).not.toHaveBeenCalled();
  });

  it("reports provider capabilities without probing upstream", () => {
    const capabilities = vi.fn(() => ({ quote: { enabled: true } }));
    const provider = { id: "yahoo", capabilities, supports: () => false };
    const service = createMarketDataService({ providers: [provider], resolver: catalogDescriptorResolver(), logLevel: "silent" });
    const health = service.getHealth();
    expect(health.providers.yahoo.enabled).toBe(true);
    expect(capabilities).toHaveBeenCalledOnce();
  });

  it("reports an unconfigured Finnhub fallback as off without probing either provider", () => {
    const yahooClient = {
      quote: vi.fn(),
      search: vi.fn(),
      chart: vi.fn(),
      quoteSummary: vi.fn(),
    };
    const fetch = vi.fn();
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      yahooClient,
      finnhubApiKey: "",
      fetch,
      logLevel: "silent",
    });
    const health = service.getHealth();

    expect(health.status).toBe("ok");
    expect(health.providers.yahoo.enabled).toBe(true);
    expect(health.providers.finnhub.enabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("reports degraded when every configured provider capability is disabled", () => {
    const provider = {
      id: "disabled",
      capabilities: () => ({ quote: { enabled: false } }),
      supports: () => false,
    };
    const service = createMarketDataService({ providers: [provider], resolver: catalogDescriptorResolver(), logLevel: "silent" });
    expect(service.getHealth()).toMatchObject({
      status: "degraded",
      providers: { disabled: { enabled: false } },
    });
  });

  it("composes the analytics slice only when the host injects a dedicated store", async () => {
    const withoutStore = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      logLevel: "silent",
    });
    expect(withoutStore.runDailyAnalytics).toBeUndefined();
    expect(withoutStore.getAnalyticsSnapshot).toBeUndefined();
    const unmounted = await withoutStore.handleRequest(new Request(
      "https://marketmap.test/api/market/v1/analytics/snapshot?ids=XNAS:AAPL",
    ));
    expect(unmounted.status).toBe(501);
    await withoutStore.close();

    const fixture = movementFixture();
    const analyticsStore = new InMemoryAnalyticsStore();
    const getHistoryBatch = vi.fn(async () => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const orchestrator = {
      getSnapshot: vi.fn(),
      getHistory: vi.fn(),
      getHistoryBatch,
      getDetails: vi.fn(),
      getNews: vi.fn(),
      getNewsBatch: vi.fn(),
      getHealth: vi.fn(() => ({ status: "ok", providers: {} })),
      close: vi.fn(async () => {}),
    };
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      orchestrator,
      analyticsStore,
      analyticsConfig: {
        equityInstrumentIds: ["XNAS:AAPL"],
        clock: () => new Date("2026-04-08T23:00:00.000Z"),
      },
      logLevel: "silent",
    });

    const summary = await service.runDailyAnalytics({
      completedSessionDate: "2026-04-08",
      nextSessionDate: "2026-04-09",
      sessionGrid: fixture.sessionGrid,
    });
    expect(summary.status).toBe("completed");
    expect(summary.counts).toMatchObject({ requested: 1, available: 1, failed: 0 });
    expect(getHistoryBatch).toHaveBeenCalledWith(
      ["XNAS:AAPL", "ARCX:SPY"],
      expect.objectContaining({ range: "5y", interval: "1d", priceBasis: "provider_adjusted" }),
    );

    const snapshot = await service.getAnalyticsSnapshot(["XNAS:AAPL", "XNAS:MSFT"]);
    expect(snapshot.errors).toBeUndefined();
    expect(snapshot.data).toHaveLength(1);
    expect(snapshot.data[0]).toMatchObject({
      instrumentId: "XNAS:AAPL",
      runId: summary.runId,
      assessment: { status: "available", sessionDate: "2026-04-08" },
    });

    const mounted = await service.handleRequest(new Request(
      "https://marketmap.test/api/market/v1/analytics/snapshot?ids=XNAS:AAPL",
    ));
    expect(mounted.status).toBe(200);
    const body = await mounted.json();
    expect(body.data[0].assessment.evidence.reference.scoreCount).toBe(756);
    await service.close();
  });

  it("requires explicit analytics configuration and closes a distinct analytics store once", async () => {
    expect(() => createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      analyticsStore: new InMemoryAnalyticsStore(),
      logLevel: "silent",
    })).toThrow(/equityInstrumentIds/u);

    const analyticsStore = Object.assign(new InMemoryAnalyticsStore(), {});
    const closeSpy = vi.spyOn(analyticsStore, "close");
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      analyticsStore,
      analyticsConfig: {
        equityInstrumentIds: ["XNAS:AAPL"],
        engine: new AnalyticsEngine(),
      },
      logLevel: "silent",
    });
    await service.close();
    await service.close();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("closes distinct snapshot and catalog stores exactly once", async () => {
    const snapshotStore = { close: vi.fn(async () => {}) };
    const instrumentCatalogStore = { close: vi.fn(async () => {}) };
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      snapshotStore,
      instrumentCatalogStore,
      logLevel: "silent",
    });

    const first = service.close();
    const second = service.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(snapshotStore.close).toHaveBeenCalledOnce();
    expect(instrumentCatalogStore.close).toHaveBeenCalledOnce();
  });

  it("does not close a shared snapshot/catalog adapter twice", async () => {
    const sharedStore = { close: vi.fn(async () => {}) };
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      snapshotStore: sharedStore,
      instrumentCatalogStore: sharedStore,
      logLevel: "silent",
    });

    await service.close();
    await service.close();

    expect(sharedStore.close).toHaveBeenCalledOnce();
  });

  it("starts catalog closure even when snapshot closure fails", async () => {
    const timeout = Object.assign(new Error("snapshot close timed out"), { code: "timeout" });
    const snapshotStore = { close: vi.fn(async () => { throw timeout; }) };
    const instrumentCatalogStore = { close: vi.fn(async () => {}) };
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      snapshotStore,
      instrumentCatalogStore,
      logLevel: "silent",
    });

    await expect(service.close()).rejects.toBe(timeout);
    await expect(service.close()).rejects.toBe(timeout);

    expect(snapshotStore.close).toHaveBeenCalledOnce();
    expect(instrumentCatalogStore.close).toHaveBeenCalledOnce();
  });

  it("closes distinct adapters sharing an owned pool without ending the pool twice", async () => {
    const pool = {
      execute: vi.fn(),
      end: vi.fn(async () => {}),
    };
    const snapshotStore = new MySQLSnapshotStore({ pool, ownsPool: true });
    const instrumentCatalogStore = new MySQLInstrumentCatalogStore({ pool, ownsPool: true });
    const snapshotClose = vi.spyOn(snapshotStore, "close");
    const catalogClose = vi.spyOn(instrumentCatalogStore, "close");
    const service = createMarketDataService({
      resolver: catalogDescriptorResolver(),
      providers: [lifecycleProvider()],
      snapshotStore,
      instrumentCatalogStore,
      logLevel: "silent",
    });

    await service.close();

    expect(snapshotClose).toHaveBeenCalledOnce();
    expect(catalogClose).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("aborts a Yahoo request still in flight when the service it owns closes", async () => {
    let observed = null;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const document = (setCookie = [], body = "") => ({
      status: 200,
      headers: { get: () => null, getSetCookie: () => setCookie },
      text: async () => body,
    });
    const fetchImpl = vi.fn(async (url, options) => {
      const href = String(url);
      if (href === "https://finance.yahoo.com/quote/AAPL") {
        return document(["A1=live; Domain=.yahoo.com"]);
      }
      if (href === "https://query1.finance.yahoo.com/v1/test/getcrumb") {
        return document([], "crumb-live");
      }
      observed = options.signal;
      await Promise.race([gate, new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })]);
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}", clone() { return this; } };
    });

    const service = createMarketDataService({
      fetch: fetchImpl,
      resolver: catalogDescriptorResolver(),
      logLevel: "silent",
    });
    const client = service.providers.find((provider) => provider.id === "yahoo").client;
    const pending = client.search("apple").catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.pending.size).toBe(1);

    await service.close();

    expect(observed.aborted).toBe(true);
    expect(await pending).toBeTruthy();
    release();
  });
});
