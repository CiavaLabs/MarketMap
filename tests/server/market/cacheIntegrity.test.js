import { describe, expect, it, vi } from "vitest";

import { InMemorySnapshotStore } from "../../../server/cache/InMemorySnapshotStore.js";
import { MemoryCache } from "../../../server/cache/MemoryCache.js";
import { marketCacheKey } from "../../../server/contracts/market/constants.js";
import { createMarketDataService } from "../../../server/createMarketDataService.js";

const BASE = "https://marketmap.test/api/market/v1";
const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const QUOTE_KEY = marketCacheKey("quote", "XNAS:AAPL", "observation");

const AAPL = Object.freeze({
  symbol: "AAPL",
  quoteType: "EQUITY",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  currency: "USD",
  regularMarketPrice: 200,
  regularMarketPreviousClose: 198,
  regularMarketOpen: 199,
  regularMarketDayHigh: 201,
  regularMarketDayLow: 197,
  regularMarketVolume: 1_000,
  averageDailyVolume3Month: 900,
  regularMarketTime: new Date(NOW),
  marketState: "REGULAR",
  exchangeTimezoneName: "America/New_York",
});

const CHART = Object.freeze({
  meta: {
    symbol: "AAPL",
    instrumentType: "EQUITY",
    currency: "USD",
    exchangeTimezoneName: "America/New_York",
  },
  quotes: [
    { date: new Date("2026-07-15T20:00:00.000Z"), open: 196, high: 199, low: 195, close: 198, adjclose: 197.5, volume: 800 },
    { date: new Date("2026-07-16T20:00:00.000Z"), open: 199, high: 201, low: 197, close: 200, adjclose: 199.5, volume: 1_000 },
  ],
  events: {},
});

function fakeYahooClient() {
  return {
    quote: vi.fn(async (symbols) => (symbols.includes("AAPL") ? [{ ...AAPL }] : [])),
    chart: vi.fn(async () => structuredClone(CHART)),
    search: vi.fn(async () => ({ quotes: [], news: [] })),
    quoteSummary: vi.fn(async () => ({})),
  };
}

function service({ snapshotStore, now = NOW, ...options } = {}) {
  const yahooClient = options.yahooClient || fakeYahooClient();
  return {
    yahooClient,
    market: createMarketDataService({
      yahooClient,
      finnhubApiKey: "",
      enabledAssetClasses: ["equity"],
      clock: () => now,
      logLevel: "silent",
      exposeHealthInternals: true,
      snapshotStore,
      ...options,
    }),
  };
}

const snapshot = (market) => market.handleRequest(new Request(`${BASE}/snapshot?ids=XNAS:AAPL`));

async function populatedStore() {
  const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
  const { market } = service({ snapshotStore });
  const response = await snapshot(market);
  expect(response.status).toBe(200);
  await market.close();
  expect(snapshotStore.records.has(QUOTE_KEY)).toBe(true);
  return snapshotStore;
}

describe("v2 persistent cache integrity", () => {
  it.each([
    ["a schema version from another release", (r) => { r.schemaVersion = 99; }],
    ["a cache key that does not match", (r) => { r.cacheKey = marketCacheKey("quote", "XNAS:MSFT", "observation"); }],
    ["a resource type that does not match", (r) => { r.resourceType = "v2_history"; }],
    ["an instrument that does not match", (r) => { r.instrumentId = "XNAS:MSFT"; }],
    ["a payload hash that does not match", (r) => { r.payloadHash = "sha256-c14n-v1:deadbeef"; }],
    ["a payload for another instrument", (r) => { r.payload = { ...r.payload, instrumentId: "XNAS:MSFT" }; }],
    ["a payload that fails its contract", (r) => { r.payload = { ...r.payload, value: "two hundred" }; }],
    ["deadlines in the wrong order", (r) => { r.staleUntil = new Date(NOW - 60_000).toISOString(); }],
    ["an unreadable freshness deadline", (r) => { r.freshUntil = "soon"; }],
    ["an unreadable origin", (r) => { r.lastSuccessAt = "recently"; r.fetchedAt = "recently"; }],
    ["an origin past its own freshness deadline", (r) => {
      r.lastSuccessAt = new Date(Date.parse(r.freshUntil) + 60_000).toISOString();
    }],
  ])("discards a v2 snapshot with %s and refetches", async (_label, corrupt) => {
    const snapshotStore = await populatedStore();
    corrupt(snapshotStore.records.get(QUOTE_KEY));

    const { market, yahooClient } = service({ snapshotStore });
    const response = await snapshot(market);

    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    expect((await snapshotStore.get(QUOTE_KEY)).schemaVersion).toBe(2);
    await market.close();
  });

  it("serves a healthy v2 snapshot without touching the provider", async () => {
    const snapshotStore = await populatedStore();
    const { market, yahooClient } = service({ snapshotStore });

    const response = await snapshot(market);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(yahooClient.quote).not.toHaveBeenCalled();
    expect(body.data[0].instrumentId).toBe("XNAS:AAPL");
    await market.close();
  });

  it("drops a v2 snapshot that has outlived its stale window", async () => {
    const snapshotStore = await populatedStore();
    const { market, yahooClient } = service({
      snapshotStore,
      now: NOW + 25 * 60 * 60 * 1_000,
    });

    const response = await snapshot(market);
    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    await market.close();
  });

  it("keeps serving when the v2 store cannot be read", async () => {
    const snapshotStore = await populatedStore();
    snapshotStore.get = vi.fn(async () => { throw new Error("db down"); });

    const { market, yahooClient } = service({ snapshotStore });
    const response = await snapshot(market);

    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    await market.close();
  });

  it("keeps serving when the v2 store cannot be written", async () => {
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    snapshotStore.set = vi.fn(async () => { throw new Error("disk full"); });

    const { market, yahooClient } = service({ snapshotStore });
    const response = await snapshot(market);

    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    await market.close();
  });

  it("keeps serving when the cleanup delete fails", async () => {
    const snapshotStore = await populatedStore();
    snapshotStore.records.get(QUOTE_KEY).schemaVersion = 99;
    snapshotStore.delete = vi.fn(async () => { throw new Error("db down"); });

    const { market, yahooClient } = service({ snapshotStore });
    const response = await snapshot(market);

    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    await market.close();
  });
});

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, member]) => [key, reverseObjectKeys(member)]),
  );
}

describe("v2 canonical payload hashing", () => {
  it("keeps a payload hash stable when a datastore hands the keys back in another order", async () => {
    const snapshotStore = await populatedStore();
    const record = snapshotStore.records.get(QUOTE_KEY);
    expect(record.payloadHash).toMatch(/^sha256-c14n-v1:[a-f0-9]{64}$/u);
    await snapshotStore.set({ ...record, payload: reverseObjectKeys(record.payload) });

    const { market, yahooClient } = service({ snapshotStore });
    const response = await snapshot(market);
    const served = await response.json();

    expect(response.status).toBe(200);
    expect(served.data[0].instrumentId).toBe("XNAS:AAPL");
    expect(yahooClient.quote).not.toHaveBeenCalled();
    await market.close();
  });
});

describe("v2 last known good across a restart", () => {
  it("serves a stale snapshot written before the restart while both providers are down", async () => {
    const snapshotStore = await populatedStore();
    const later = NOW + 31_000;
    const yahooClient = fakeYahooClient();
    yahooClient.quote = vi.fn(async () => { throw new Error("offline"); });
    const { market } = service({ snapshotStore, yahooClient, now: later });

    const response = await snapshot(market);
    const served = await response.json();

    expect(response.status).toBe(200);
    expect(served.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", quality: "stale" });
    expect(served.data[0].provenance.originalSource).toBe("yahoo");
    expect(yahooClient.quote).toHaveBeenCalled();
    await market.close();
  });
});

describe("v2 memory cache integrity", () => {
  async function warmed({ now = NOW } = {}) {
    const memoryCache = new MemoryCache({ clock: () => now, clone: structuredClone });
    const snapshotStore = new InMemorySnapshotStore({ clock: () => now });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { market, yahooClient } = service({ snapshotStore, memoryCache, logger, now });
    expect((await snapshot(market)).status).toBe(200);
    expect(memoryCache.read(QUOTE_KEY)).not.toBeNull();
    yahooClient.quote.mockClear();
    return { market, yahooClient, memoryCache, logger };
  }

  it("serves the warm memory entry without reaching the provider", async () => {
    const { market, yahooClient } = await warmed();

    expect((await snapshot(market)).status).toBe(200);
    expect(yahooClient.quote).not.toHaveBeenCalled();
    await market.close();
  });

  it.each([
    ["a payload for another instrument", (value) => ({ ...value, instrumentId: "XNAS:MSFT" })],
    ["a payload that fails its contract", (value) => ({ ...value, value: "two hundred" })],
    ["a payload that is not an object", () => "not-a-quote"],
    ["a payload that is an array", (value) => [value]],
  ])("refuses %s from memory, recovers the healthy one, and says why", async (_label, corrupt) => {
    const { market, memoryCache, logger } = await warmed();
    const entry = memoryCache.read(QUOTE_KEY);
    memoryCache.set(QUOTE_KEY, corrupt(entry.value), { freshTtlMs: 60_000, staleTtlMs: 120_000 });

    const response = await snapshot(market);
    const served = await response.json();

    expect(response.status).toBe(200);
    expect(served.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", value: 200 });
    expect(memoryCache.read(QUOTE_KEY)?.value).toMatchObject({ instrumentId: "XNAS:AAPL" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOutcome: "memory-invalid" }),
    );
    const health = await (await market.handleRequest(new Request(`${BASE}/health`))).json();
    expect(Object.keys(health.data.telemetry.counters))
      .toContain("cache_invalid{layer=memory,resource=quote-market}");
    await market.close();
  });

  it.each([
    ["a series for another instrument", (value) => ({ ...value, instrumentId: "XNAS:MSFT" })],
    ["a series covering a range the caller did not ask for", (value) => ({ ...value, range: "5d" })],
    ["a series at an interval the caller did not ask for", (value) => ({ ...value, interval: "1d" })],
  ])("refuses %s from memory and recovers the healthy series", async (_label, corrupt) => {
    const memoryCache = new MemoryCache({ clock: () => NOW, clone: structuredClone });
    const keys = [];
    const write = memoryCache.set.bind(memoryCache);
    memoryCache.set = (key, value, options) => { keys.push(key); return write(key, value, options); };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { market } = service({ memoryCache, logger });
    const path = `${BASE}/history?ids=XNAS:AAPL&range=1d&interval=15m`;
    expect((await market.handleRequest(new Request(path))).status).toBe(200);

    const key = keys.find((candidate) => candidate.startsWith("v2:history"));
    expect(key).toBeTruthy();
    memoryCache.set(key, corrupt(memoryCache.read(key).value), { freshTtlMs: 60_000, staleTtlMs: 120_000 });

    const response = await market.handleRequest(new Request(path));
    const served = await response.json();

    expect(response.status).toBe(200);
    expect(served.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", range: "1d", interval: "15m" });
    expect(memoryCache.read(key)?.value).toMatchObject({ instrumentId: "XNAS:AAPL", range: "1d", interval: "15m" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ cacheOutcome: "memory-invalid" }));
    await market.close();
  });

  it("stops serving a memory entry once it is past its stale deadline", async () => {
    const { market, yahooClient, memoryCache } = await warmed();
    const entry = memoryCache.read(QUOTE_KEY);
    memoryCache.set(QUOTE_KEY, entry.value, { now: NOW - 120_000, freshTtlMs: 1, staleTtlMs: 2 });

    expect(memoryCache.read(QUOTE_KEY)).toBeNull();
    expect((await snapshot(market)).status).toBe(200);
    expect(memoryCache.read(QUOTE_KEY)).not.toBeNull();
    expect(yahooClient.quote).not.toHaveBeenCalled();
    await market.close();
  });
});

describe("v2 stale presentation", () => {
  it("labels a stale v2 quote and keeps its original source", async () => {
    const snapshotStore = await populatedStore();
    const yahooClient = fakeYahooClient();
    yahooClient.quote.mockRejectedValue(new Error("upstream down"));

    const { market } = service({
      snapshotStore,
      yahooClient,
      now: NOW + 10 * 60_000,
    });
    const response = await snapshot(market);
    const body = await response.json();

    expect(response.status).toBe(200);
    const quote = body.data[0];
    expect(quote.quality).toBe("stale");
    expect(quote.provenance.originalSource).toBe("yahoo");
    expect(quote.dataQuality.issues.map(({ code }) => code))
      .toContain("stale_last_known_good");
    await market.close();
  });

  it("marks the available fields of a stale quote stale exactly once", async () => {
    const snapshotStore = await populatedStore();
    const yahooClient = fakeYahooClient();
    yahooClient.quote.mockRejectedValue(new Error("upstream down"));

    const { market } = service({ snapshotStore, yahooClient, now: NOW + 10 * 60_000 });
    const body = await (await snapshot(market)).json();
    const quote = body.data[0];

    expect(Object.values(quote.fieldAvailability).some(({ status }) => status === "stale")).toBe(true);
    expect(Object.values(quote.fieldAvailability).every(({ status }) => status !== "available")).toBe(true);
    expect(quote.dataQuality.issues.filter(({ code }) => code === "stale_last_known_good"))
      .toHaveLength(1);
    await market.close();
  });
});
