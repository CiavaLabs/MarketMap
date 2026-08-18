import { describe, expect, it, vi } from "vitest";
import { InstrumentCatalog, CURATED_INSTRUMENTS } from "../../../server/instruments/InstrumentCatalog.js";
import { InstrumentResolver } from "../../../server/instruments/InstrumentResolver.js";
import { YAHOO_CAPABILITY_MANIFEST } from "../../../server/providers/yahoo/capabilityManifest.js";
import { RAW_QUOTE_EURUSD } from "../fixtures/market/rawYahoo.js";

const MANIFESTS = [YAHOO_CAPABILITY_MANIFEST];
const CLOCK = () => Date.parse("2026-08-08T12:00:00.000Z");

function equityQuote(symbol) {
  return {
    symbol,
    quoteType: "EQUITY",
    exchange: "NMS",
    fullExchangeName: "NasdaqGS",
    currency: "USD",
    longName: `${symbol} Holdings`,
    regularMarketPrice: 10,
    exchangeTimezoneName: "America/New_York",
    marketState: "REGULAR",
  };
}

function build({ maxResolvedDescriptors = 3, store = null } = {}) {
  const hydrateQuotes = vi.fn(async (symbols) => new Map(
    symbols.map((symbol) => [symbol.toUpperCase(), equityQuote(symbol.toUpperCase())]),
  ));
  const catalog = new InstrumentCatalog();
  const resolver = new InstrumentResolver({
    catalog,
    yahooProvider: { hydrateQuotes, discoverInstruments: async () => [] },
    store,
    manifests: MANIFESTS,
    clock: CLOCK,
    maxResolvedDescriptors,
  });
  return { catalog, resolver, hydrateQuotes };
}

const CURATED_COUNT = CURATED_INSTRUMENTS.length;

describe("InstrumentResolver provider-symbol index", () => {
  it("retires a provider symbol that has moved off its instrument", async () => {
    let providerSymbol = "GBPUSD=X";
    const discovery = () => ({
      provider: "yahoo",
      providerSymbol,
      quoteType: "CURRENCY",
      exchangeCode: "CCY",
      exchangeName: "CCY",
      name: "GBP/USD",
      score: 90,
      mappingStatus: "provisional",
    });
    const resolver = new InstrumentResolver({
      catalog: new InstrumentCatalog(),
      yahooProvider: {
        discoverInstruments: vi.fn(async () => [discovery()]),
        hydrateQuotes: vi.fn(async () => new Map([
          [providerSymbol, { ...RAW_QUOTE_EURUSD, symbol: providerSymbol }],
        ])),
      },
      store: null,
      manifests: MANIFESTS,
      clock: CLOCK,
      enabledAssetClasses: ["fx"],
    });

    await resolver.searchInstruments("gbp");
    expect(resolver.idForProviderSymbol("GBPUSD=X")).toBe("FX:GBPUSD");

    providerSymbol = "GBPUSD";
    await resolver.searchInstruments("gbp");

    expect(resolver.idForProviderSymbol("GBPUSD")).toBe("FX:GBPUSD");
    expect(resolver.idForProviderSymbol("GBPUSD=X")).toBeNull();
  });
});

describe("InstrumentResolver provider-symbol ambiguity", () => {
  it("answers nothing when two instruments claim the same provider symbol", () => {
    const catalog = new InstrumentCatalog();
    const resolver = new InstrumentResolver({
      catalog,
      yahooProvider: { hydrateQuotes: async () => new Map(), discoverInstruments: async () => [] },
      store: null,
      manifests: MANIFESTS,
      clock: CLOCK,
    });
    const [first, second] = [...resolver.descriptors.values()]
      .filter((descriptor) => descriptor.providerSymbols.yahoo?.symbol)
      .slice(0, 2);
    expect(resolver.idForProviderSymbol(first.providerSymbols.yahoo.symbol)).toBe(first.id);

    resolver.idsByProviderSymbol.get(upperOf(first.providerSymbols.yahoo.symbol)).add(second.id);

    expect(resolver.idForProviderSymbol(first.providerSymbols.yahoo.symbol)).toBeNull();
  });
});

const upperOf = (value) => `${value}`.toUpperCase();

describe("InstrumentResolver descriptor bound", () => {
  it("rejects a bound that is not a positive integer", () => {
    expect(() => build({ maxResolvedDescriptors: 0 })).toThrow(TypeError);
    expect(() => build({ maxResolvedDescriptors: 1.5 })).toThrow(TypeError);
  });

  it("bounds resolved descriptors without evicting the curated ones", async () => {
    const { resolver } = build({ maxResolvedDescriptors: 3 });
    expect(resolver.pinnedIds.size).toBeGreaterThan(0);
    const curatedId = [...resolver.pinnedIds][0];

    for (const symbol of ["AAA", "BBB", "CCC", "DDD", "EEE"]) {
      await resolver.getDescriptor(`XNAS:${symbol}`);
    }

    expect(resolver.descriptors.size).toBe(resolver.pinnedIds.size + 3);
    expect(resolver.descriptors.has(curatedId)).toBe(true);
    expect(resolver.descriptors.has("XNAS:AAA")).toBe(false);
    expect(resolver.descriptors.has("XNAS:EEE")).toBe(true);
  });

  it("drops the provider-symbol index together with the descriptor", async () => {
    const { catalog, resolver } = build({ maxResolvedDescriptors: 1 });
    await resolver.getDescriptor("XNAS:AAA");
    expect(resolver.idForProviderSymbol("AAA")).toBe("XNAS:AAA");

    await resolver.getDescriptor("XNAS:BBB");

    expect(resolver.idForProviderSymbol("AAA")).toBeNull();
    expect(catalog.has("XNAS:AAA")).toBe(false);
    expect(() => catalog.resolve("AAA")).toThrow();
  });

  it("keeps a descriptor resident while it is still being resolved", async () => {
    const { resolver } = build({ maxResolvedDescriptors: 2 });
    await resolver.getDescriptor("XNAS:AAA");
    await resolver.getDescriptor("XNAS:BBB");
    await resolver.getDescriptor("XNAS:AAA");
    await resolver.getDescriptor("XNAS:CCC");

    expect(resolver.descriptors.has("XNAS:AAA")).toBe(true);
    expect(resolver.descriptors.has("XNAS:BBB")).toBe(false);
  });

  it("re-mints an evicted descriptor on the next resolve", async () => {
    const { resolver, hydrateQuotes } = build({ maxResolvedDescriptors: 1 });
    const first = await resolver.getDescriptor("XNAS:AAA");
    await resolver.getDescriptor("XNAS:BBB");
    hydrateQuotes.mockClear();

    const again = await resolver.getDescriptor("XNAS:AAA");
    expect(again).toEqual(first);
    expect(hydrateQuotes).toHaveBeenCalledOnce();
  });

  it("serves an evicted descriptor from the store without touching the provider", async () => {
    const records = new Map();
    const store = {
      get: async (id) => records.get(id) || null,
      set: async (record) => { records.set(record.instrumentId, record); return record; },
    };
    const { resolver, hydrateQuotes } = build({ maxResolvedDescriptors: 1, store });
    await resolver.getDescriptor("XNAS:AAA");
    await resolver.getDescriptor("XNAS:BBB");
    hydrateQuotes.mockClear();

    const restored = await resolver.getDescriptor("XNAS:AAA");
    expect(restored.id).toBe("XNAS:AAA");
    expect(hydrateQuotes).not.toHaveBeenCalled();
  });

  it("leaves the curated seed untouched no matter how much was resolved", async () => {
    const { catalog, resolver } = build({ maxResolvedDescriptors: 2 });
    for (let index = 0; index < 40; index += 1) {
      await resolver.getDescriptor(`XNAS:S${index}`);
    }
    expect(catalog.list().length).toBe(CURATED_COUNT);
    expect(resolver.descriptors.size).toBe(CURATED_COUNT + 2);
  });
});
