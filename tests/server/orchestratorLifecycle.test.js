import { describe, expect, it, vi } from "vitest";

import { InMemorySnapshotStore } from "../../server/cache/InMemorySnapshotStore.js";
import { MemoryCache } from "../../server/cache/MemoryCache.js";
import { InstrumentCatalog } from "../../server/instruments/InstrumentCatalog.js";
import { catalogDescriptorResolver } from "./fixtures/market/curatedDescriptors.js";
import { MarketDataOrchestrator } from "../../server/orchestration/MarketDataOrchestrator.js";
import { DEFAULT_TTL_POLICY } from "../../server/orchestration/ttlPolicy.js";

const START = Date.parse("2026-07-13T20:00:00.000Z");
const iso = (value) => new Date(value).toISOString();

function quote(instrumentId, source = "yahoo", timestamp = START) {
  return {
    instrumentId,
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
    asOf: iso(timestamp),
    fetchedAt: iso(timestamp),
    currency: "USD",
    quality: "fresh",
    source,
  };
}

function metric(id, value, source = "yahoo") {
  return { id, value, unit: "currency", period: "instant", asOf: iso(START), source, quality: "fresh" };
}

function profile(instrument, source = "yahoo") {
  return {
    instrument,
    metrics: [metric("market_cap", 4_740_000_000_000), metric("derived_ratio", 1.2, "derived")],
    source,
    asOf: iso(START),
    fetchedAt: iso(START),
  };
}

function bar(timestamp = START, source = "yahoo") {
  return {
    timestamp: iso(timestamp),
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    adjustedClose: 101,
    volume: 1_000,
    source,
    quality: "fresh",
  };
}

function history(instrumentId, source = "yahoo") {
  return {
    instrumentId,
    bars: [bar(START - 86_400_000, source), bar(START, source)],
    range: "1m",
    interval: "1d",
    source,
    asOf: iso(START),
    fetchedAt: iso(START),
  };
}

function provider(id = "yahoo", overrides = {}) {
  return {
    id,
    capabilities: () => ({ quote: true, profile: true, history: true, search: true }),
    supports: () => true,
    quoteMany: vi.fn(async (instruments) => ({
      data: instruments.map((instrument) => quote(instrument.id, id)),
      errors: [],
    })),
    profile: vi.fn(async (instrument) => profile(instrument, id)),
    history: vi.fn(async (instrument) => history(instrument.id, id)),
    search: vi.fn(async () => []),
    ...overrides,
  };
}

function setup({ providers, store, now = START, ttlPolicy, logger } = {}) {
  let current = now;
  const clock = () => current;
  const snapshotStore = store || new InMemorySnapshotStore({ clock });
  const memoryCache = new MemoryCache({ clock, clone: structuredClone });
  return {
    snapshotStore,
    memoryCache,
    setNow(value) { current = value; },
    orchestrator: new MarketDataOrchestrator({
      providers: providers || [provider()],
      instrumentResolver: catalogDescriptorResolver(),
      catalog: new InstrumentCatalog(),
      snapshotStore,
      memoryCache,
      clock,
      providerTimeoutMs: 500,
      persistenceTimeoutMs: 100,
      ttlPolicy,
      logger,
    }),
  };
}

describe("orchestrator construction", () => {
  it.each([
    ["no options at all", undefined],
    ["an empty provider list", { providers: [] }],
    ["a non-array provider list", { providers: {} }],
  ])("refuses to start with %s", (_label, options) => {
    expect(() => new MarketDataOrchestrator(options))
      .toThrowError(/requires at least one provider/u);
  });

  it.each([
    ["no resolver", null],
    ["a resolver that cannot describe an instrument", { capabilitiesFor: () => ({}) }],
    ["a resolver that cannot report capabilities", { getDescriptor: async () => ({}) }],
    ["a resolver that cannot map a provider symbol", {
      getDescriptor: async () => ({}),
      capabilitiesFor: () => ({}),
    }],
  ])("refuses to start with %s", (_label, instrumentResolver) => {
    expect(() => new MarketDataOrchestrator({ providers: [provider()], instrumentResolver }))
      .toThrowError(/compatible instrument resolver/u);
  });

  it("merges a partial TTL policy over the defaults and keeps the default identity", () => {
    const merged = new MarketDataOrchestrator({
      providers: [provider()],
      instrumentResolver: catalogDescriptorResolver(),
      ttlPolicy: { quote: { freshMs: 1, staleMs: 2 } },
    });
    expect(merged.ttlPolicy.quote).toEqual({ freshMs: 1, staleMs: 2 });
    expect(merged.ttlPolicy.profile).toBe(DEFAULT_TTL_POLICY.profile);

    const untouched = new MarketDataOrchestrator({ providers: [provider()], instrumentResolver: catalogDescriptorResolver() });
    expect(untouched.ttlPolicy).toBe(DEFAULT_TTL_POLICY);
  });

  it.each([
    ["a zero batch concurrency", { historyBatchConcurrency: 0 }, 8],
    ["a negative batch concurrency", { historyBatchConcurrency: -4 }, 1],
    ["an over-large batch concurrency", { historyBatchConcurrency: 100 }, 16],
    ["an unreadable batch concurrency", { historyBatchConcurrency: "many" }, 8],
  ])("clamps %s", (_label, options, expected) => {
    const orchestrator = new MarketDataOrchestrator({ providers: [provider()], instrumentResolver: catalogDescriptorResolver(), ...options });
    expect(orchestrator.historyBatchConcurrency).toBe(expected);
  });

  it.each([
    ["an unreadable persistence timeout", { persistenceTimeoutMs: "soon" }, 750],
    ["a zero persistence timeout", { persistenceTimeoutMs: 0 }, 750],
    ["a negative persistence timeout", { persistenceTimeoutMs: -5 }, 1],
  ])("clamps %s", (_label, options, expected) => {
    const orchestrator = new MarketDataOrchestrator({ providers: [provider()], instrumentResolver: catalogDescriptorResolver(), ...options });
    expect(orchestrator.persistenceTimeoutMs).toBe(expected);
  });
});

describe("persistence degradation", () => {
  it("reports no persistence at all when none is configured", () => {
    const orchestrator = new MarketDataOrchestrator({
      providers: [provider()],
      instrumentResolver: catalogDescriptorResolver(),
      snapshotStore: null,
    });
    expect(orchestrator.getHealth().persistence).toEqual({
      enabled: false,
      healthy: true,
      adapter: "none",
      entries: null,
    });
  });

  it("closes a store that supports it and tolerates one that does not", async () => {
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async (record) => record),
      delete: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    const { orchestrator } = setup({ store });
    await orchestrator.close();
    expect(store.close).toHaveBeenCalledOnce();

    const bare = new MarketDataOrchestrator({ providers: [provider()], instrumentResolver: catalogDescriptorResolver(), snapshotStore: {} });
    await expect(bare.close()).resolves.toBeUndefined();
  });
});

describe("orchestrator health", () => {
  it("reports degraded when every provider capability is off", () => {
    const dark = provider("yahoo", { capabilities: () => ({ quote: false }) });
    const { orchestrator } = setup({ providers: [dark] });
    expect(orchestrator.getHealth()).toMatchObject({ status: "degraded" });
  });

  it("counts a provider with no capabilities() at all as disabled", () => {
    const bare = provider();
    delete bare.capabilities;
    const { orchestrator } = setup({ providers: [bare] });
    expect(orchestrator.getHealth().providers.yahoo).toMatchObject({
      enabled: false,
      capabilities: {},
    });
  });
});

describe("caller cancellation", () => {
  const aborted = () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    return controller.signal;
  };

  it.each([
    ["a snapshot", (orchestrator, signal) => orchestrator.getSnapshot(["XNAS:AAPL"], { signal })],
    ["a history request", (orchestrator, signal) => orchestrator.getHistory("XNAS:AAPL", { signal })],
    ["a history batch", (orchestrator, signal) => orchestrator.getHistoryBatch(["XNAS:AAPL"], { signal })],
    ["a details request", (orchestrator, signal) => orchestrator.getDetails("XNAS:AAPL", { signal })],
    ["a news request", (orchestrator, signal) => orchestrator.getNews("XNAS:AAPL", { signal })],
    ["a news batch", (orchestrator, signal) => orchestrator.getNewsBatch(["XNAS:AAPL"], { signal })],
  ])("refuses %s that was already cancelled", async (_label, call) => {
    const { orchestrator } = setup();
    await expect(call(orchestrator, aborted())).rejects.toMatchObject({
      details: { reason: "request_aborted" },
    });
  });

});
