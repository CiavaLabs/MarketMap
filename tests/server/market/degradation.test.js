import { describe, expect, it, vi } from "vitest";

import { InMemorySnapshotStore } from "../../../server/cache/InMemorySnapshotStore.js";
import { MARKET_ASSET_CLASSES } from "../../../server/contracts/market/constants.js";
import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { RAW_QUOTE_GSPC, RAW_QUOTE_SPY } from "../fixtures/market/rawYahoo.js";
import { YAHOO_AAPL_QUOTE } from "../providers/fixtures/yahoo.js";

const BASE = "https://marketmap.test/api/market/v1";
const NOW = Date.parse("2026-07-16T20:00:00.000Z");

const QUOTES = Object.freeze({ AAPL: YAHOO_AAPL_QUOTE, SPY: RAW_QUOTE_SPY, "^GSPC": RAW_QUOTE_GSPC });

function chartFor(symbol) {
  const close = QUOTES[symbol].regularMarketPrice;
  return {
    meta: {
      symbol,
      instrumentType: symbol === "SPY" ? "ETF" : "EQUITY",
      currency: "USD",
      exchangeTimezoneName: "America/New_York",
    },
    quotes: [
      { date: new Date(NOW - 86_400_000), open: close, high: close, low: close, close, adjclose: close, volume: 10 },
      { date: new Date(NOW), open: close, high: close, low: close, close, adjclose: close, volume: 11 },
    ],
    events: {},
  };
}

function fakeYahooClient(overrides = {}) {
  return {
    quote: vi.fn(async (symbols) => symbols.map((symbol) => structuredClone(QUOTES[symbol])).filter(Boolean)),
    chart: vi.fn(async (symbol) => chartFor(symbol)),
    quoteSummary: vi.fn(async () => ({})),
    search: vi.fn(async () => ({ quotes: [], news: [] })),
    ...overrides,
  };
}

function market({ yahooClient = fakeYahooClient(), now = NOW, ...options } = {}) {
  return {
    yahooClient,
    service: createMarketDataService({
      yahooClient,
      finnhubApiKey: "",
      enabledAssetClasses: [...MARKET_ASSET_CLASSES],
      clock: () => now,
      logLevel: "silent",
      exposeHealthInternals: true,
      ...options,
    }),
  };
}

const get = (service, path) => service.handleRequest(new Request(`${BASE}${path}`));
const body = async (response) => response.json();

describe("v2 capability gating", () => {
  it("refuses a quote for an asset class the host has switched off", async () => {
    const { service, yahooClient } = market({ enabledAssetClasses: ["equity"] });

    const response = await get(service, "/snapshot?ids=ARCX:SPY");
    const payload = await body(response);

    expect(payload.data).toEqual([]);
    expect(payload.errors[0]).toMatchObject({ instrumentId: "ARCX:SPY" });
    expect(yahooClient.quote).not.toHaveBeenCalled();
    await service.close();
  });

  it("still serves an enabled class alongside a disabled one", async () => {
    const { service } = market({ enabledAssetClasses: ["equity"] });

    const payload = await body(await get(service, "/snapshot?ids=XNAS:AAPL,ARCX:SPY"));

    expect(payload.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
    expect(payload.errors).toHaveLength(1);
    await service.close();
  });

  it("refuses history for a disabled class without calling the provider", async () => {
    const { service, yahooClient } = market({ enabledAssetClasses: ["equity"] });

    const response = await get(service, "/instruments/ARCX:SPY/history?range=1y&interval=1d");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(yahooClient.chart).not.toHaveBeenCalled();
    await service.close();
  });

  it("refuses details for a disabled class", async () => {
    const { service, yahooClient } = market({ enabledAssetClasses: ["equity"] });

    const response = await get(service, "/instruments/ARCX:SPY/details");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(yahooClient.quoteSummary).not.toHaveBeenCalled();
    await service.close();
  });
});

describe("news capability gating", () => {
  it("refuses news for an asset class the host has switched off", async () => {
    const { service, yahooClient } = market({ enabledAssetClasses: ["equity"] });

    const response = await get(service, "/instruments/ARCX:SPY/news");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(yahooClient.search).not.toHaveBeenCalled();
    await service.close();
  });
});

describe("v2 provider payload rejection", () => {
  it.each([
    ["nothing at all", async () => null],
    ["a bare array", async () => []],
    ["a quote for a symbol nobody asked about", async () => [{ ...QUOTES.AAPL, symbol: "ZZZZ" }]],
  ])("reports an upstream failure when the provider answers a quote with %s", async (_label, quote) => {
    const { service } = market({ yahooClient: fakeYahooClient({ quote: vi.fn(quote) }) });

    const payload = await body(await get(service, "/snapshot?ids=XNAS:AAPL"));

    expect(payload.data).toEqual([]);
    expect(payload.errors[0].instrumentId).toBe("XNAS:AAPL");
    await service.close();
  });

  it("reports an upstream failure when the quote call throws", async () => {
    const { service } = market({
      yahooClient: fakeYahooClient({
        quote: vi.fn(async () => { throw new Error("upstream down"); }),
      }),
    });

    const payload = await body(await get(service, "/snapshot?ids=XNAS:AAPL"));

    expect(payload.data).toEqual([]);
    expect(payload.errors[0]).toMatchObject({ instrumentId: "XNAS:AAPL", retryable: true });
    await service.close();
  });

  it.each([
    ["an empty chart", async () => ({ meta: {}, quotes: [], events: {} })],
    ["no chart at all", async () => null],
    ["a chart that throws", async () => { throw new Error("upstream down"); }],
  ])("reports a history failure for %s", async (_label, chart) => {
    const { service } = market({ yahooClient: fakeYahooClient({ chart: vi.fn(chart) }) });

    const response = await get(service, "/instruments/XNAS:AAPL/history?range=1y&interval=1d");

    expect(response.status).toBeGreaterThanOrEqual(400);
    await service.close();
  });

  it("keeps serving details when the summary modules come back empty", async () => {
    const { service } = market({ yahooClient: fakeYahooClient({ quoteSummary: vi.fn(async () => ({})) }) });

    const response = await get(service, "/instruments/XNAS:AAPL/details");

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.data.instrument.id).toBe("XNAS:AAPL");
    await service.close();
  });

  it("reports a details failure when the summary call throws", async () => {
    const { service } = market({
      yahooClient: fakeYahooClient({
        quoteSummary: vi.fn(async () => { throw new Error("upstream down"); }),
      }),
    });

    const response = await get(service, "/instruments/XNAS:AAPL/details");
    expect(response.status).toBeGreaterThanOrEqual(400);
    await service.close();
  });
});

describe("v2 history last known good", () => {
  it("serves an aged series as stale once the chart provider stops answering", async () => {
    let now = NOW;
    const yahooClient = fakeYahooClient();
    const { service } = market({ yahooClient, clock: () => now });
    const path = "/history?ids=XNAS:AAPL&range=1d&interval=15m";
    const first = await body(await get(service, path));
    expect(first.data[0].quality).toBe("fresh");

    now = NOW + 121_000;
    yahooClient.chart = vi.fn(async () => { throw new Error("chart offline"); });
    const aged = await body(await get(service, path));

    expect(aged.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", quality: "stale" });
    expect(aged.errors ?? []).toEqual([]);
    expect(yahooClient.chart).toHaveBeenCalled();
    await service.close();
  });
});

describe("v2 batch failure accounting", () => {
  it("opens the quote circuit when every item drifts, though each item error is final", async () => {
    const yahooClient = fakeYahooClient({
      quote: vi.fn(async (symbols) => symbols.map((symbol) => ({
        ...structuredClone(QUOTES[symbol]),
        regularMarketPrice: undefined,
      }))),
    });
    const { service } = market({ yahooClient, breakerOptions: { failureThreshold: 1 } });

    const snapshot = await get(service, "/snapshot?ids=XNAS:AAPL");
    const failed = await body(snapshot);
    expect(snapshot.status).toBe(200);
    expect(failed.data).toEqual([]);
    expect(failed.errors.map((error) => error.instrumentId)).toEqual(["XNAS:AAPL"]);

    const health = await body(await get(service, "/health"));
    const open = Object.entries(health.data.circuits)
      .filter(([, circuit]) => circuit.state !== "closed")
      .map(([name]) => name);
    expect(open.some((name) => name.startsWith("yahoo:quote"))).toBe(true);
  });

  it("advertises a near retry pinned to the stale item, not to the fresh one", async () => {
    let now = NOW;
    const yahooClient = fakeYahooClient();
    const { service } = market({ yahooClient, clock: () => now });
    expect((await get(service, "/snapshot?ids=XNAS:AAPL")).status).toBe(200);

    now = NOW + 31_000;
    yahooClient.quote = vi.fn(async (symbols) => symbols
      .filter((symbol) => symbol === "^GSPC")
      .map((symbol) => structuredClone(QUOTES[symbol])));
    const mixed = await body(await get(service, "/snapshot?ids=XNAS:AAPL,INDEX:^GSPC"));

    const quality = Object.fromEntries(mixed.data.map((item) => [item.instrumentId, item.quality]));
    expect(quality).toEqual({ "XNAS:AAPL": "stale", "INDEX:^GSPC": "fresh" });
    expect(mixed.meta.nextRefreshAt).toBe(new Date(now + 30_000).toISOString());
    await service.close();
  });
});

describe("v2 shared work and caller cancellation", () => {
  it("does not let one caller abort poison the work another is waiting on", async () => {
    let release;
    let providerEntered;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { providerEntered = resolve; });
    const yahooClient = fakeYahooClient({
      quoteSummary: vi.fn(async () => { providerEntered(); await gate; return {}; }),
    });
    const { service } = market({ yahooClient });

    const controller = new AbortController();
    const abandoned = service.getDetails("XNAS:AAPL", { signal: controller.signal });
    await entered;
    const waiting = service.getDetails("XNAS:AAPL");
    controller.abort(new DOMException("tab closed", "AbortError"));

    await expect(abandoned).rejects.toMatchObject({ details: { reason: "request_aborted" } });
    release();
    await expect(waiting).resolves.toMatchObject({ sources: { details: "yahoo" } });
    expect(yahooClient.quoteSummary).toHaveBeenCalledOnce();
  });

  it("bounds a store that never answers instead of holding the response hostage", async () => {
    const pending = () => new Promise(() => {});
    const snapshotStore = { get: vi.fn(pending), set: vi.fn(pending), delete: vi.fn(async () => true) };
    const { service, yahooClient } = market({ snapshotStore, persistenceTimeoutMs: 10 });
    const startedAt = Date.now();

    const served = await body(await get(service, "/snapshot?ids=XNAS:AAPL,ARCX:SPY"));

    expect(served.data.map((item) => item.instrumentId)).toEqual(["XNAS:AAPL", "ARCX:SPY"]);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(yahooClient.quote).toHaveBeenCalled();
    expect(snapshotStore.get).toHaveBeenCalledTimes(2);
    expect(snapshotStore.set).toHaveBeenCalledTimes(2);

    const health = await body(await get(service, "/health"));
    expect(health.data).toMatchObject({ status: "degraded", persistence: { healthy: false } });
    await service.close();
  });

  it("lets a caller abort a hanging persistence read before any provider work", async () => {
    let readStarted;
    const reading = new Promise((resolve) => { readStarted = resolve; });
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    snapshotStore.get = vi.fn(() => { readStarted(); return new Promise(() => {}); });
    const yahooClient = fakeYahooClient();
    const { service } = market({ snapshotStore, yahooClient, persistenceTimeoutMs: 10_000 });

    const controller = new AbortController();
    const request = service.getDetails("XNAS:AAPL", { signal: controller.signal });
    await reading;
    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(request).rejects.toMatchObject({ details: { reason: "request_aborted" } });
    expect(snapshotStore.get).toHaveBeenCalled();
    expect(yahooClient.quoteSummary).not.toHaveBeenCalled();
  });

  it("turns an abort during a batch read into an item error without reaching the provider", async () => {
    let readStarted;
    const reading = new Promise((resolve) => { readStarted = resolve; });
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    snapshotStore.get = vi.fn(() => { readStarted(); return new Promise(() => {}); });
    const yahooClient = fakeYahooClient();
    const { service } = market({ snapshotStore, yahooClient, persistenceTimeoutMs: 10_000 });

    const controller = new AbortController();
    const request = service.getSnapshot(["XNAS:AAPL"], { signal: controller.signal });
    await reading;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const result = await request;

    expect(result.data).toEqual([]);
    expect(result.errors[0]).toMatchObject({ details: { reason: "request_aborted" } });
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });
});

describe("v2 provider quarantine", () => {
  const authFailure = () => Object.assign(new Error("Invalid API key"), { code: "auth_failed" });

  it("quarantines a provider that reports an authentication failure", async () => {
    const quote = vi.fn(async () => { throw authFailure(); });
    const { service } = market({ yahooClient: fakeYahooClient({ quote }) });

    const first = await body(await get(service, "/snapshot?ids=XNAS:AAPL"));
    expect(first.errors).toHaveLength(1);

    const second = await body(await get(service, "/snapshot?ids=XNAS:MSFT"));
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0].retryable).toBe(false);

    const health = await body(await get(service, "/health"));
    expect(health.data.status).toBe("degraded");
    await service.close();
  });

  it("reports a quarantined provider in the health payload", async () => {
    const quote = vi.fn(async () => { throw authFailure(); });
    const { service } = market({ yahooClient: fakeYahooClient({ quote }) });
    await get(service, "/snapshot?ids=XNAS:AAPL");

    const health = await body(await get(service, "/health"));
    expect(Object.keys(health.data.providers.yahoo.quarantinedCapabilities).length)
      .toBeGreaterThan(0);
    await service.close();
  });

  it("reports degraded once a circuit leaves the closed state", async () => {
    const yahooClient = fakeYahooClient({
      quote: vi.fn(async () => { throw new Error("upstream down"); }),
    });
    const { service } = market({ yahooClient, breakerOptions: { failureThreshold: 1 } });

    await get(service, "/snapshot?ids=XNAS:AAPL");
    const health = await body(await get(service, "/health"));

    expect(Object.values(health.data.circuits).some((circuit) => circuit.state !== "closed")).toBe(true);
    expect(health.data.status).toBe("degraded");
  });

  it("reports degraded while the snapshot store is unreachable, and serves anyway", async () => {
    const down = async () => { throw new Error("db down"); };
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    snapshotStore.get = vi.fn(down);
    snapshotStore.set = vi.fn(down);
    const { service, yahooClient } = market({ snapshotStore });

    const snapshot = await get(service, "/snapshot?ids=XNAS:AAPL");
    const health = await body(await get(service, "/health"));

    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).data).toHaveLength(1);
    expect(yahooClient.quote).toHaveBeenCalled();
    expect(snapshotStore.get).toHaveBeenCalled();
    expect(health.data.persistence).toMatchObject({ enabled: true, healthy: false });
    expect(health.data.status).toBe("degraded");
  });

  it("restores its reported health on a read that serves from the store", async () => {
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    const warm = market({ snapshotStore });
    expect((await get(warm.service, "/snapshot?ids=XNAS:AAPL")).status).toBe(200);
    await warm.service.close();

    const healthyRead = snapshotStore.get.bind(snapshotStore);
    snapshotStore.get = vi.fn(async () => { throw new Error("db down"); });
    const { service, yahooClient } = market({ snapshotStore });

    yahooClient.quote.mockRejectedValueOnce(new Error("upstream down"));
    await get(service, "/snapshot?ids=XNAS:AAPL");
    expect((await body(await get(service, "/health"))).data.persistence.healthy).toBe(false);

    snapshotStore.get = vi.fn(healthyRead);
    yahooClient.quote.mockClear();
    const served = await get(service, "/snapshot?ids=XNAS:AAPL");

    expect(served.status).toBe(200);
    expect(yahooClient.quote).not.toHaveBeenCalled();
    expect((await body(await get(service, "/health"))).data.persistence.healthy).toBe(true);
  });

  it("reports a healthy provider before anything has failed", async () => {
    const { service } = market();
    await get(service, "/snapshot?ids=XNAS:AAPL");

    const health = await body(await get(service, "/health"));
    expect(health.data.status).toBe("ok");
    expect(health.data.providers.yahoo.quarantinedCapabilities).toEqual({});
    expect(Object.values(health.data.circuits).every(({ state }) => state === "closed")).toBe(true);
    await service.close();
  });
});

describe("v2 batch request limits", () => {
  it.each([
    ["no ids at all", "/snapshot?ids="],
    ["a blank id", "/snapshot?ids=%20"],
  ])("rejects a snapshot with %s", async (_label, path) => {
    const { service } = market();
    const response = await get(service, path);
    expect(response.status).toBeGreaterThanOrEqual(400);
    await service.close();
  });

  it("rejects a snapshot larger than the request limit", async () => {
    const { service } = market();
    const ids = Array.from({ length: 200 }, (_, index) => `XNAS:A${index}`).join(",");
    const response = await get(service, `/snapshot?ids=${ids}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    await service.close();
  });

  it("reports an unknown instrument rather than inventing one", async () => {
    const { service } = market();
    const payload = await body(await get(service, "/snapshot?ids=XNAS:NOTREAL"));
    expect(payload.data).toEqual([]);
    expect(payload.errors[0].instrumentId).toBe("XNAS:NOTREAL");
    await service.close();
  });

  it("collapses a repeated id into one provider call", async () => {
    const { service, yahooClient } = market();
    const payload = await body(await get(service, "/snapshot?ids=XNAS:AAPL,XNAS:AAPL"));

    expect(payload.data).toHaveLength(1);
    expect(yahooClient.quote).toHaveBeenCalledOnce();
    await service.close();
  });
});

describe("history semantics", () => {
  it.each([
    ["an unsupported range", "/instruments/XNAS:AAPL/history?range=99y&interval=1d"],
    ["an unsupported interval", "/instruments/XNAS:AAPL/history?range=1y&interval=3s"],
    ["an unsupported price basis", "/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=gross"],
  ])("rejects %s", async (_label, path) => {
    const { service, yahooClient } = market();
    const response = await get(service, path);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(yahooClient.chart).not.toHaveBeenCalled();
    await service.close();
  });

  it("serves a supported range and caches it for the next caller", async () => {
    const { service, yahooClient } = market();

    const first = await get(service, "/instruments/XNAS:AAPL/history?range=1y&interval=1d");
    const second = await get(service, "/instruments/XNAS:AAPL/history?range=1y&interval=1d");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(yahooClient.chart).toHaveBeenCalledOnce();
    await service.close();
  });

  it("treats a different price basis as a different series", async () => {
    const { service, yahooClient } = market();

    await get(service, "/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=raw");
    await get(service, "/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=provider_adjusted");

    expect(yahooClient.chart).toHaveBeenCalledTimes(2);
    await service.close();
  });
});

describe("v2 history batch", () => {
  it("returns one series per requested instrument", async () => {
    const { service } = market();

    const payload = await body(await get(service, "/history?ids=XNAS:AAPL,ARCX:SPY&range=1y&interval=1d"));

    expect(payload.data.map(({ instrumentId }) => instrumentId))
      .toEqual(["XNAS:AAPL", "ARCX:SPY"]);
    expect(payload.errors).toBeUndefined();
    expect(payload.sources.history).toEqual(["yahoo"]);
    await service.close();
  });

  it("collapses a repeated id into a single series", async () => {
    const { service, yahooClient } = market();

    const payload = await body(await get(service, "/history?ids=XNAS:AAPL,XNAS:AAPL&range=1y&interval=1d"));

    expect(payload.data).toHaveLength(1);
    expect(yahooClient.chart).toHaveBeenCalledOnce();
    await service.close();
  });

  it("reports the instruments that failed and keeps the ones that did not", async () => {
    const chart = vi.fn(async (symbol) => {
      if (symbol === "SPY") throw new Error("upstream down");
      return chartFor(symbol);
    });
    const { service } = market({ yahooClient: fakeYahooClient({ chart }) });

    const payload = await body(await get(service, "/history?ids=XNAS:AAPL,ARCX:SPY&range=1y&interval=1d"));

    expect(payload.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
    expect(payload.errors.map(({ instrumentId }) => instrumentId)).toEqual(["ARCX:SPY"]);
    await service.close();
  });

  it("reports every instrument when the provider is down entirely", async () => {
    const { service } = market({
      yahooClient: fakeYahooClient({
        chart: vi.fn(async () => { throw new Error("upstream down"); }),
      }),
    });

    const payload = await body(await get(service, "/history?ids=XNAS:AAPL,ARCX:SPY&range=1y&interval=1d"));

    expect(payload.data).toEqual([]);
    expect(payload.errors).toHaveLength(2);
    await service.close();
  });

  it.each([
    ["no ids", "/history?ids=&range=1y&interval=1d"],
    ["an unsupported range", "/history?ids=XNAS:AAPL&range=99y&interval=1d"],
  ])("rejects a batch with %s", async (_label, path) => {
    const { service } = market();
    expect((await get(service, path)).status).toBeGreaterThanOrEqual(400);
    await service.close();
  });
});

describe("v2 stale details", () => {
  it("relabels a stale details payload's sections and available fields", async () => {
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    const { service } = market({ snapshotStore });
    const fresh = await body(await get(service, "/instruments/XNAS:AAPL/details"));
    expect(fresh.data.sections.length).toBeGreaterThan(0);
    expect(fresh.data.quality).toBe("fresh");
    await service.close();

    const { service: later } = market({
      snapshotStore,
      now: NOW + 2 * 24 * 60 * 60 * 1_000,
      yahooClient: fakeYahooClient({
        quoteSummary: vi.fn(async () => { throw new Error("upstream down"); }),
      }),
    });

    const stale = await body(await get(later, "/instruments/XNAS:AAPL/details"));

    expect(stale.data.quality).toBe("stale");
    expect(stale.data.provenance.originalSource).toBe("yahoo");
    expect(stale.data.dataQuality.issues.map(({ code }) => code))
      .toContain("stale_last_known_good");
    expect(stale.data.sections.every(({ status }) => status !== "available")).toBe(true);
    await later.close();
  });
});
