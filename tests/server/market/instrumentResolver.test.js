import { describe, expect, it, vi } from "vitest";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { curatedDescriptor } from "../fixtures/market/curatedDescriptors.js";
import { InstrumentResolver } from "../../../server/instruments/InstrumentResolver.js";
import { InMemoryInstrumentCatalogStore } from "../../../server/instruments/InstrumentCatalogStore.js";
import {
  providerSymbolCandidatesForVenue,
  resolveVenue,
  venueForMic,
} from "../../../server/instruments/VenueRegistry.js";
import { YAHOO_CAPABILITY_MANIFEST } from "../../../server/providers/yahoo/capabilityManifest.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "../../../server/providers/finnhub/capabilityManifest.js";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { Telemetry } from "../../../server/observability/Telemetry.js";
import {
  RAW_QUOTE_EURUSD,
  RAW_QUOTE_GC,
  RAW_QUOTE_GSPC,
  RAW_QUOTE_SPYM,
  RAW_QUOTE_TNX,
  RAW_SEARCH_SPYM,
  RAW_SEARCH_UNKNOWN_VENUE,
} from "../fixtures/market/rawYahoo.js";

const MANIFESTS = [YAHOO_CAPABILITY_MANIFEST, FINNHUB_CAPABILITY_MANIFEST];
const CLOCK = () => Date.parse("2026-07-16T20:00:00.000Z");

const SECTOR_ETF_CATEGORIES = Object.freeze({
  XLK: "Technology",
  XLC: "Communication Services",
  XLY: "Consumer Discretionary",
  XLP: "Consumer Staples",
  XLF: "Financials",
  XLV: "Health Care",
  XLE: "Energy",
  XLI: "Industrials",
  XLU: "Utilities",
  XLB: "Materials",
});

const PLTR_QUOTE = Object.freeze({
  symbol: "PLTR",
  quoteType: "EQUITY",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  currency: "USD",
  longName: "Palantir Technologies Inc.",
  regularMarketPrice: 161.2,
});

const ASML_AS_QUOTE = Object.freeze({
  symbol: "ASML.AS",
  quoteType: "EQUITY",
  exchange: "AMS",
  fullExchangeName: "Euronext Amsterdam",
  currency: "EUR",
  longName: "ASML Holding N.V.",
  regularMarketPrice: 690.1,
});

const ASML_US_QUOTE = Object.freeze({
  symbol: "ASML",
  quoteType: "EQUITY",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  currency: "USD",
  longName: "ASML Holding N.V.",
  regularMarketPrice: 745.3,
});

const OMV_QUOTE = Object.freeze({
  symbol: "OMV.VI",
  quoteType: "EQUITY",
  exchange: "VIE",
  fullExchangeName: "Vienna",
  currency: "EUR",
  longName: "OMV AG",
  regularMarketPrice: 44.1,
});

const BND_QUOTE = Object.freeze({
  symbol: "BND",
  quoteType: "ETF",
  exchange: "NGM",
  fullExchangeName: "NasdaqGM",
  currency: "USD",
  longName: "Vanguard Total Bond Market ETF",
  regularMarketPrice: 73.02,
});

const AGG_QUOTE = Object.freeze({
  symbol: "AGG",
  quoteType: "ETF",
  exchange: "PCX",
  fullExchangeName: "NYSEArca",
  currency: "USD",
  longName: "iShares Core U.S. Aggregate Bond ETF",
  regularMarketPrice: 98.0,
});

const SINGLE_BOND_QUOTE = Object.freeze({
  symbol: "US912810UD80",
  quoteType: "BOND",
  currency: "USD",
  longName: "United States Treasury Bond",
  regularMarketPrice: 96.25,
});

const DATED_FUTURE_QUOTE = Object.freeze({
  symbol: "GCQ26.CMX",
  quoteType: "FUTURE",
  exchange: "CMX",
  fullExchangeName: "COMEX",
  currency: "USD",
  longName: "Gold Aug 2026 Futures",
  regularMarketPrice: 3_352.4,
});

function fakeYahooProvider(quotesBySymbol, discoveries = []) {
  return {
    id: "yahoo",
    discoverInstruments: vi.fn(async () => structuredClone(discoveries)),
    hydrateQuotes: vi.fn(async (symbols) => new Map(symbols
      .map((symbol) => [symbol, quotesBySymbol[symbol]])
      .filter(([, quote]) => quote)
      .map(([symbol, quote]) => [symbol, structuredClone(quote)]))),
  };
}

function buildResolver(overrides = {}) {
  return new InstrumentResolver({
    catalog: overrides.forceCatalog ? overrides.catalog : (overrides.catalog || new InstrumentCatalog()),
    yahooProvider: overrides.provider || fakeYahooProvider({}),
    store: overrides.store ?? null,
    manifests: MANIFESTS,
    enabledAssetClasses: overrides.enabledAssetClasses || ["equity"],
    clock: CLOCK,
    telemetry: overrides.telemetry || null,
    logger: overrides.logger || null,
  });
}

describe("venue registry", () => {
  it("resolves allowlisted provider codes to MIC venues", () => {
    expect(resolveVenue({ provider: "yahoo", code: "PCX", fullName: "NYSEArca" })).toEqual({
      code: "PCX",
      name: "NYSE Arca",
      mic: "ARCX",
      kind: "exchange",
      confidence: "exact",
    });
    expect(venueForMic("XNAS").mic).toBe("XNAS");
    expect(providerSymbolCandidatesForVenue({
      provider: "yahoo",
      symbol: "ASML",
      mic: "XAMS",
    })).toEqual(["ASML.AS", "ASML"]);
  });

  it("never invents a MIC for an unknown venue", () => {
    const venue = resolveVenue({ provider: "yahoo", code: "VIE", fullName: "Vienna" });
    expect(venue.mic).toBeNull();
    expect(venue.kind).toBe("unknown");
    expect(venue.confidence).toBe("unknown");
  });
});

describe("InstrumentResolver identity", () => {
  it("serves curated seeds from memory with verified mappings", async () => {
    const resolver = buildResolver();
    const descriptor = await resolver.getDescriptor("XNAS:AAPL");
    expect(descriptor.displaySymbol).toBe("AAPL");
    expect(descriptor.assetClass).toBe("equity");
    expect(descriptor.providerSymbols.yahoo.verified).toBe(true);
    expect(descriptor.mappingStatus).toBe("resolved");
    expect(resolver.isAddable(descriptor)).toEqual({ addable: true, reasonCode: null });
  });

  it("keeps disabled classes fetch-visible but not addable", async () => {
    const resolver = buildResolver();
    const descriptor = await resolver.getDescriptor("FX:EURUSD");
    expect(descriptor.assetClass).toBe("fx");
    expect(descriptor.displaySymbol).toBe("EUR/USD");
    expect(resolver.isAddable(descriptor)).toEqual({
      addable: false,
      reasonCode: "asset_class_disabled",
    });
    const capabilities = resolver.capabilitiesFor(descriptor);
    expect(capabilities.quote.status).toBe("unsupported");
    expect(capabilities.quote.reason).toBe("asset_class_disabled");
  });

  it("resolves BND and AGG as reviewed fixed-income ETFs", async () => {
    const resolver = buildResolver({ enabledAssetClasses: ["equity", "etf"] });
    const bnd = await resolver.getDescriptor("XNAS:BND");
    const agg = await resolver.getDescriptor("ARCX:AGG");

    expect(bnd).toMatchObject({
      assetClass: "etf",
      assetSubtype: "bond_etf",
      category: "Fixed Income",
      venue: { code: "NGM", mic: "XNAS", kind: "exchange" },
      providerSymbols: { yahoo: { symbol: "BND", verified: true } },
    });
    expect(agg).toMatchObject({
      assetClass: "etf",
      assetSubtype: "bond_etf",
      category: "Fixed Income",
      venue: { code: "PCX", mic: "ARCX", kind: "exchange" },
      providerSymbols: { yahoo: { symbol: "AGG", verified: true } },
    });
    expect(resolver.isAddable(bnd)).toEqual({ addable: true, reasonCode: null });
    expect(resolver.isAddable(agg)).toEqual({ addable: true, reasonCode: null });

    const discoveries = [BND_QUOTE, AGG_QUOTE].map((quote, index) => ({
      provider: "yahoo",
      providerSymbol: quote.symbol,
      quoteType: quote.quoteType,
      exchangeCode: quote.exchange,
      exchangeName: quote.fullExchangeName,
      name: quote.longName,
      score: 90 - index,
      mappingStatus: "provisional",
    }));
    const cold = buildResolver({
      catalog: new InstrumentCatalog({ instruments: [] }),
      provider: fakeYahooProvider({ BND: BND_QUOTE, AGG: AGG_QUOTE }, discoveries),
      enabledAssetClasses: ["etf"],
    });
    const hydrated = await cold.searchInstruments("bond");
    expect(hydrated.map((row) => row.instrument)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "XNAS:BND", assetClass: "etf", assetSubtype: "bond_etf" }),
      expect.objectContaining({ id: "ARCX:AGG", assetClass: "etf", assetSubtype: "bond_etf" }),
    ]));
  });

  it("exposes reviewed sector ETFs only through verified Yahoo mappings and ETF capabilities", async () => {
    const resolver = buildResolver({ enabledAssetClasses: ["equity", "etf"] });

    for (const [symbol, category] of Object.entries(SECTOR_ETF_CATEGORIES)) {
      const descriptor = await resolver.getDescriptor(`ARCX:${symbol}`);

      expect(descriptor).toMatchObject({
        id: `ARCX:${symbol}`,
        symbol,
        displaySymbol: symbol,
        assetClass: "etf",
        assetSubtype: "equity_etf",
        category,
        venue: {
          code: "PCX",
          name: "NYSE Arca",
          mic: "ARCX",
          kind: "exchange",
        },
        providerSymbols: {
          yahoo: {
            symbol,
            verified: true,
            verifiedAt: "2026-07-16T00:00:00.000Z",
          },
        },
        mappingStatus: "resolved",
      });
      expect(resolver.isAddable(descriptor)).toEqual({
        addable: true,
        reasonCode: null,
      });

      const capabilities = resolver.capabilitiesFor(descriptor);
      expect(capabilities.quote.status).toBe("supported");
      expect(capabilities.history).toMatchObject({
        status: "supported",
        priceBases: ["raw", "provider_adjusted"],
      });
      expect(capabilities.details).toEqual({
        status: "partial",
        sections: ["fund_profile", "fund_composition", "fund_stats"],
      });
      expect(capabilities.news).toEqual({
        status: "unsupported",
        reason: "asset_class",
      });
    }
  });

  it("preserves Yahoo publisher codes for index and rate-index cold resolution", async () => {
    const provider = fakeYahooProvider({
      "^GSPC": RAW_QUOTE_GSPC,
      "^TNX": RAW_QUOTE_TNX,
    });
    const resolver = buildResolver({
      catalog: new InstrumentCatalog({ instruments: [] }),
      provider,
      enabledAssetClasses: ["index", "rate_index"],
    });

    const index = await resolver.getDescriptor("INDEX:^GSPC");
    const rate = await resolver.getDescriptor("RATE:^TNX");
    expect(index).toMatchObject({
      assetClass: "index",
      priceUnit: "index_points",
      venue: {
        code: "SNP",
        name: "S&P Dow Jones Indices",
        mic: null,
        kind: "index_publisher",
      },
      providerSymbols: { yahoo: { symbol: "^GSPC", providerType: "INDEX" } },
    });
    expect(rate).toMatchObject({
      assetClass: "rate_index",
      assetSubtype: "yield_index",
      priceUnit: "percent_yield",
      venue: {
        code: "CGI",
        name: "Cboe Global Indices",
        mic: null,
        kind: "index_publisher",
      },
      providerSymbols: { yahoo: { symbol: "^TNX", providerType: "INDEX" } },
    });
  });

  it("cold-resolves a dynamic instrument after a restart without any store", async () => {
    const telemetry = new Telemetry({ clock: CLOCK });
    const resolver = buildResolver({
      provider: fakeYahooProvider({ PLTR: PLTR_QUOTE }),
      telemetry,
    });
    const descriptor = await resolver.getDescriptor("XNAS:PLTR");
    expect(descriptor.id).toBe("XNAS:PLTR");
    expect(descriptor.venue.mic).toBe("XNAS");
    expect(descriptor.mappingStatus).toBe("resolved");
    const counters = telemetry.snapshot().counters;
    expect(counters["instrument_resolution{assetClass=equity,outcome=resolved,source=cold}"]).toBe(1);
    await resolver.getDescriptor("XNAS:PLTR");
    expect(resolver.provider.hydrateQuotes).toHaveBeenCalledTimes(1);
  });

  it("survives a restart through the persistent catalog store", async () => {
    const store = new InMemoryInstrumentCatalogStore({ clock: CLOCK });
    const first = buildResolver({
      provider: fakeYahooProvider({ PLTR: PLTR_QUOTE }),
      store,
    });
    await first.getDescriptor("XNAS:PLTR");
    expect(store.size).toBe(1);

    const second = buildResolver({ provider: fakeYahooProvider({}), store });
    const descriptor = await second.getDescriptor("XNAS:PLTR");
    expect(descriptor.id).toBe("XNAS:PLTR");
    expect(descriptor.name).toBe("Palantir Technologies Inc.");
    expect(second.provider.hydrateQuotes).not.toHaveBeenCalled();
  });

  it("verifies untrusted provider-symbol hints instead of trusting them", async () => {
    const provider = fakeYahooProvider({ "ASML.AS": ASML_AS_QUOTE, ASML: ASML_US_QUOTE });
    const resolver = buildResolver({ provider });
    const descriptor = await resolver.getDescriptor("XAMS:ASML", {
      hints: { yahoo: { symbol: "ASML.AS" } },
    });
    expect(descriptor.id).toBe("XAMS:ASML");
    expect(descriptor.currency).toBe("EUR");
    expect(descriptor.providerSymbols.yahoo.symbol).toBe("ASML.AS");
  });

  it("cold-resolves a non-US MIC deterministically without a browser hint", async () => {
    const provider = fakeYahooProvider({ "ASML.AS": ASML_AS_QUOTE });
    const resolver = buildResolver({ provider });
    const descriptor = await resolver.getDescriptor("XAMS:ASML");
    expect(descriptor).toMatchObject({
      id: "XAMS:ASML",
      currency: "EUR",
      providerSymbols: { yahoo: { symbol: "ASML.AS", verified: true } },
    });
    expect(provider.hydrateQuotes).toHaveBeenCalledWith(["ASML.AS"], expect.anything());
  });

  it("rejects an identity the provider cannot reproduce", async () => {
    const provider = fakeYahooProvider({ ASML: ASML_US_QUOTE });
    const resolver = buildResolver({ provider });
    await expect(resolver.getDescriptor("XAMS:ASML")).rejects.toMatchObject({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
    });
  });

  it("answers a migrated legacy ID with an explicit pointer, never a silent rewrite", async () => {
    const resolver = buildResolver();
    await expect(resolver.getDescriptor("FUTURE:GC=F")).rejects.toMatchObject({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
      details: { migratedTo: "FUTURE:CMX.GC.CONTINUOUS.1", reason: "legacy_id_migrated" },
    });
    await expect(resolver.getDescriptor("FUTURE:CMX.GC.CONTINUOUS.1")).resolves.toMatchObject({
      assetClass: "commodity_future",
      assetSubtype: "continuous_front",
    });
  });

  it("fails closed when the provider has no quote for the identity", async () => {
    const resolver = buildResolver({ provider: fakeYahooProvider({}) });
    await expect(resolver.getDescriptor("XNAS:NOPE")).rejects.toMatchObject({
      code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
    });
  });
});

describe("InstrumentResolver two-stage search", () => {
  it("serves a discovery of an already-curated symbol from the catalog, not from a fresh quote", async () => {
    const provider = fakeYahooProvider({
      AAPL: { ...PLTR_QUOTE, symbol: "AAPL", longName: "Apple Inc." },
    }, [{
      provider: "yahoo",
      providerSymbol: "AAPL",
      quoteType: "EQUITY",
      exchangeCode: "NMS",
      exchangeName: "NASDAQ",
      name: "Apple Inc.",
      score: 100,
      mappingStatus: "provisional",
    }]);
    const resolver = buildResolver({ provider });

    const results = await resolver.searchInstruments("cupertino");

    const row = results.find((entry) => entry.instrument?.id === "XNAS:AAPL");
    expect(row).toBeDefined();
    expect(row.provenance).toEqual({ discovery: "yahoo", hydrated: false, typeConflict: false });
    expect(row.instrument.providerSymbols).toMatchObject({
      yahoo: { symbol: "AAPL", verified: true, verifiedAt: "2026-07-16T00:00:00.000Z" },
      finnhub: { symbol: "AAPL", verified: true },
    });
    expect(provider.hydrateQuotes).not.toHaveBeenCalled();
  });

  it("corrects a search/quote type conflict through hydration and records it", async () => {
    const telemetry = new Telemetry({ clock: CLOCK });
    const provider = fakeYahooProvider({ SPYM: RAW_QUOTE_SPYM }, [{
      provider: "yahoo",
      providerSymbol: RAW_SEARCH_SPYM.symbol,
      quoteType: RAW_SEARCH_SPYM.quoteType,
      exchangeCode: RAW_SEARCH_SPYM.exchange,
      exchangeName: RAW_SEARCH_SPYM.exchDisp,
      name: RAW_SEARCH_SPYM.shortname,
      score: RAW_SEARCH_SPYM.score,
      mappingStatus: "provisional",
    }]);
    const resolver = buildResolver({
      provider,
      telemetry,
      enabledAssetClasses: ["equity", "etf"],
    });
    const results = await resolver.searchInstruments("spym");
    const row = results.find((entry) => entry.instrument?.id === "XNAS:SPYM");
    expect(row).toBeDefined();
    expect(row.instrument.assetClass).toBe("etf");
    expect(row.mappingStatus).toBe("resolved");
    expect(row.addable).toBe(true);
    expect(row.provenance.typeConflict).toBe(true);
    const counters = telemetry.snapshot().counters;
    expect(counters["provider_type_conflict{assetClass=etf,provider=yahoo}"]).toBe(1);
  });

  it("applies the currency filter after hydration, not on the search payload", async () => {
    const provider = fakeYahooProvider({ SPYM: RAW_QUOTE_SPYM }, [{
      provider: "yahoo",
      providerSymbol: "SPYM",
      quoteType: "EQUITY",
      exchangeCode: "NGM",
      exchangeName: "NASDAQ",
      name: "SPDR Portfolio S&P 500 ETF",
      score: 92,
      mappingStatus: "provisional",
    }]);
    const resolver = buildResolver({ provider, enabledAssetClasses: ["equity", "etf"] });
    const results = await resolver.searchInstruments("spym", { currency: "USD" });
    expect(results.some((entry) => entry.instrument?.id === "XNAS:SPYM")).toBe(true);
  });

  it("shows unknown venues as unsupported without minting an identity", async () => {
    const provider = fakeYahooProvider({ "OMV.VI": OMV_QUOTE }, [{
      provider: "yahoo",
      providerSymbol: RAW_SEARCH_UNKNOWN_VENUE.symbol,
      quoteType: RAW_SEARCH_UNKNOWN_VENUE.quoteType,
      exchangeCode: RAW_SEARCH_UNKNOWN_VENUE.exchange,
      exchangeName: RAW_SEARCH_UNKNOWN_VENUE.exchDisp,
      name: RAW_SEARCH_UNKNOWN_VENUE.shortname,
      score: RAW_SEARCH_UNKNOWN_VENUE.score,
      mappingStatus: "provisional",
    }]);
    const resolver = buildResolver({ provider });

    const defaults = await resolver.searchInstruments("omv");
    expect(defaults.some((entry) => entry.candidate?.providerSymbol === "OMV.VI")).toBe(false);

    const explained = await resolver.searchInstruments("omv", { includeUnsupported: true });
    const row = explained.find((entry) => entry.candidate?.providerSymbol === "OMV.VI");
    expect(row).toBeDefined();
    expect(row.instrument).toBeNull();
    expect(row.addable).toBe(false);
    expect(row.reasonCode).toBe("unsupported_venue");
    expect(row.candidate.venue.mic).toBeNull();
  });

  it("keeps results beyond the hydration budget provisional and disabled", async () => {
    const discoveries = Array.from({ length: 3 }, (_, index) => ({
      provider: "yahoo",
      providerSymbol: `EQ${index}`,
      quoteType: "EQUITY",
      exchangeCode: "NMS",
      exchangeName: "NASDAQ",
      name: `Equity ${index}`,
      score: 50 - index,
      mappingStatus: "provisional",
    }));
    const quotes = Object.fromEntries(discoveries.map(({ providerSymbol }) => [
      providerSymbol,
      { ...PLTR_QUOTE, symbol: providerSymbol, longName: providerSymbol },
    ]));
    const provider = fakeYahooProvider(quotes, discoveries);
    const resolver = buildResolver({ provider });
    const results = await resolver.searchInstruments("eq", {
      hydrationLimit: 2,
      includeUnsupported: true,
    });
    const resolved = results.filter((entry) => entry.mappingStatus === "resolved" && entry.instrument?.id.startsWith("XNAS:EQ"));
    const provisional = results.filter((entry) => entry.mappingStatus === "provisional");
    expect(resolved).toHaveLength(2);
    expect(provisional).toHaveLength(1);
    expect(provisional[0].addable).toBe(false);
    expect(provisional[0].reasonCode).toBe("identity_provisional");

    const hiddenResolver = buildResolver({ provider: fakeYahooProvider(quotes, discoveries) });
    const hidden = await hiddenResolver.searchInstruments("eq", { hydrationLimit: 2 });
    expect(hidden.some((entry) => entry.mappingStatus === "provisional")).toBe(false);
  });

  it("filters search results by asset class after hydration", async () => {
    const resolver = buildResolver({
      provider: fakeYahooProvider({ "EURUSD=X": RAW_QUOTE_EURUSD }, [{
        provider: "yahoo",
        providerSymbol: "EURUSD=X",
        quoteType: "CURRENCY",
        exchangeCode: "CCY",
        exchangeName: "CCY",
        name: "EUR/USD",
        score: 80,
        mappingStatus: "provisional",
      }]),
      enabledAssetClasses: ["equity"],
    });
    const fxOnly = await resolver.searchInstruments("eur", {
      assetClasses: ["fx"],
      includeUnsupported: true,
    });
    expect(fxOnly.every((entry) => (entry.instrument?.assetClass ?? entry.candidate?.assetClass) === "fx")).toBe(true);
    const fxRow = fxOnly.find((entry) => entry.instrument?.id === "FX:EURUSD");
    expect(fxRow).toBeDefined();
    expect(fxRow.addable).toBe(false);
    expect(fxRow.reasonCode).toBe("asset_class_disabled");
  });

  it("does not invent USD when the authoritative quote has no currency", async () => {
    const discovery = {
      provider: "yahoo",
      providerSymbol: "NOCUR",
      quoteType: "EQUITY",
      exchangeCode: "NMS",
      exchangeName: "NASDAQ",
      name: "No Currency Corp.",
      score: 70,
      mappingStatus: "provisional",
    };
    const provider = fakeYahooProvider({
      NOCUR: { ...PLTR_QUOTE, symbol: "NOCUR", currency: undefined },
    }, [discovery]);
    const resolver = buildResolver({ provider });
    const results = await resolver.searchInstruments("nocur", { includeUnsupported: true });
    expect(results).toEqual([expect.objectContaining({
      instrument: null,
      mappingStatus: "ambiguous",
      addable: false,
      reasonCode: "identity_incomplete",
      candidate: expect.objectContaining({ currency: null }),
    })]);
  });

  it("keeps a hydrated single bond visible but explicitly non-addable", async () => {
    const discovery = {
      provider: "yahoo",
      providerSymbol: SINGLE_BOND_QUOTE.symbol,
      quoteType: "BOND",
      exchangeCode: null,
      exchangeName: null,
      name: SINGLE_BOND_QUOTE.longName,
      score: 88,
      mappingStatus: "provisional",
    };
    const resolver = buildResolver({
      provider: fakeYahooProvider({ [SINGLE_BOND_QUOTE.symbol]: SINGLE_BOND_QUOTE }, [discovery]),
      enabledAssetClasses: ["equity", "etf", "rate_index"],
    });

    const hidden = await resolver.searchInstruments("treasury");
    expect(hidden.some((row) => row.candidate?.providerSymbol === SINGLE_BOND_QUOTE.symbol)).toBe(false);

    const visible = await resolver.searchInstruments("treasury", { includeUnsupported: true });
    expect(visible).toContainEqual(expect.objectContaining({
      instrument: null,
      candidate: expect.objectContaining({
        providerSymbol: SINGLE_BOND_QUOTE.symbol,
        assetClass: "bond",
      }),
      mappingStatus: "unsupported",
      addable: false,
      reasonCode: "single_bond_unsupported",
    }));
  });

  it("allows only curated continuous futures and explains rejected aliases", async () => {
    const discoveries = [RAW_QUOTE_GC, DATED_FUTURE_QUOTE].map((quote, index) => ({
      provider: "yahoo",
      providerSymbol: quote.symbol,
      quoteType: quote.quoteType,
      exchangeCode: quote.exchange,
      exchangeName: quote.fullExchangeName,
      name: quote.longName || quote.symbol,
      score: 90 - index,
      mappingStatus: "provisional",
    }));
    const resolver = buildResolver({
      catalog: new InstrumentCatalog({ instruments: [] }),
      provider: fakeYahooProvider({
        "GC=F": RAW_QUOTE_GC,
        "GCQ26.CMX": DATED_FUTURE_QUOTE,
      }, discoveries),
      enabledAssetClasses: ["commodity_future"],
    });

    const rows = await resolver.searchInstruments("futures", { includeUnsupported: true });
    expect(rows).toContainEqual(expect.objectContaining({
      instrument: expect.objectContaining({
        id: "FUTURE:CMX.GC.CONTINUOUS.1",
        assetClass: "commodity_future",
        assetSubtype: "continuous_front",
        providerSymbols: { yahoo: expect.objectContaining({ symbol: "GC=F", verified: true }) },
      }),
      addable: true,
      reasonCode: null,
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      instrument: null,
      candidate: expect.objectContaining({ providerSymbol: "GCQ26.CMX" }),
      mappingStatus: "unsupported",
      addable: false,
      reasonCode: "future_not_allowlisted",
    }));
  });
});

const GOLD_FUTURE_ID = "FUTURE:CMX.GC.CONTINUOUS.1";

const BARRICK_QUOTE = Object.freeze({
  symbol: "GOLD",
  quoteType: "EQUITY",
  exchange: "NYQ",
  fullExchangeName: "NYSE",
  currency: "USD",
  longName: "Barrick Mining Corporation",
  regularMarketPrice: 27.44,
});

function yahooDiscovery(quote, score) {
  return {
    provider: "yahoo",
    providerSymbol: quote.symbol,
    quoteType: quote.quoteType,
    exchangeCode: quote.exchange,
    exchangeName: quote.fullExchangeName,
    name: quote.longName || quote.symbol,
    score,
    mappingStatus: "provisional",
  };
}

describe("InstrumentResolver provider-symbol identity", () => {
  it("gives a search hit its own identity when its symbol is a curated alias", async () => {
    const provider = fakeYahooProvider({ GOLD: BARRICK_QUOTE }, [yahooDiscovery(BARRICK_QUOTE, 96)]);
    const resolver = buildResolver({
      provider,
      enabledAssetClasses: ["equity", "commodity_future"],
    });

    const rows = await resolver.searchInstruments("gold");

    const barrick = rows.find((row) => row.instrument?.id === "XNYS:GOLD");
    expect(barrick).toBeDefined();
    expect(barrick.instrument).toMatchObject({
      assetClass: "equity",
      name: "Barrick Mining Corporation",
      venue: { code: "NYQ", mic: "XNYS" },
      providerSymbols: { yahoo: { symbol: "GOLD", providerType: "EQUITY" } },
    });
    expect(barrick.provenance).toMatchObject({ discovery: "yahoo", hydrated: true });
    expect(resolver.idForProviderSymbol("GOLD")).toBe("XNYS:GOLD");

    const goldFuture = rows.find((row) => row.instrument?.id === GOLD_FUTURE_ID);
    expect(goldFuture.instrument.assetClass).toBe("commodity_future");
    expect(goldFuture.instrument.providerSymbols.yahoo.symbol).toBe("GC=F");
  });

  it("enriches a hit the catalog already maps for that provider instead of minting one", async () => {
    const provider = fakeYahooProvider({}, [yahooDiscovery(RAW_QUOTE_GC, 88)]);
    const resolver = buildResolver({ provider, enabledAssetClasses: ["commodity_future"] });

    const rows = await resolver.searchInstruments("comex");

    expect(rows).toEqual([expect.objectContaining({
      instrument: expect.objectContaining({
        id: GOLD_FUTURE_ID,
        assetClass: "commodity_future",
        assetSubtype: "continuous_front",
        category: "Metals",
        venue: expect.objectContaining({ code: "CMX", mic: "XCEC" }),
        providerSymbols: {
          yahoo: { symbol: "GC=F", verified: true, verifiedAt: "2026-07-16T00:00:00.000Z" },
        },
      }),
      mappingStatus: "resolved",
      addable: true,
      provenance: { discovery: "yahoo", hydrated: false, typeConflict: false },
    })]);
    expect(provider.hydrateQuotes).not.toHaveBeenCalled();
  });

  it("ingests the colliding hit without repointing the curated instrument's mappings", async () => {
    const catalog = new InstrumentCatalog();
    const provider = fakeYahooProvider({ GOLD: BARRICK_QUOTE }, [yahooDiscovery(BARRICK_QUOTE, 96)]);
    const resolver = buildResolver({
      catalog,
      provider,
      enabledAssetClasses: ["equity", "commodity_future"],
    });

    await resolver.searchInstruments("gold");

    expect(resolver.idForProviderSymbol("GC=F")).toBe(GOLD_FUTURE_ID);
    expect(resolver.idForProviderSymbol("GOLD")).toBe("XNYS:GOLD");
    await expect(resolver.getDescriptor(GOLD_FUTURE_ID)).resolves.toMatchObject({
      assetClass: "commodity_future",
      providerSymbols: { yahoo: { symbol: "GC=F", verifiedAt: "2026-07-16T00:00:00.000Z" } },
    });
    expect(provider.hydrateQuotes).toHaveBeenCalledTimes(1);
    expect(provider.hydrateQuotes).toHaveBeenCalledWith(["GOLD"], expect.anything());

    expect(catalog.get(GOLD_FUTURE_ID).aliases).toContain("GOLD");
    expect(catalog.resolveByProviderSymbol("GC=F").id).toBe(GOLD_FUTURE_ID);
    expect(catalog.resolve("GOLD").id).toBe(GOLD_FUTURE_ID);
    expect(catalog.has("XNYS:GOLD")).toBe(false);
  });
});

describe("InstrumentResolver construction", () => {
  it.each([
    ["no catalog", null],
    ["a catalog that cannot be listed", { resolve: () => null, search: () => [] }],
  ])("refuses to start with %s", (_label, catalog) => {
    expect(() => buildResolver({ catalog: catalog ?? undefined, forceCatalog: true }))
      .toThrowError(/curated instrument catalog/u);
  });
});

describe("InstrumentResolver identity drift", () => {
  it("warns when a stored descriptor's id disagrees with the venue it carries", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sound = curatedDescriptor("XNAS:AAPL");
    const drifted = { ...sound, venue: { ...sound.venue, mic: "XNYS", code: "NYQ" } };
    const resolver = buildResolver({
      logger,
      store: { get: async () => ({ descriptor: drifted }), set: async () => {} },
    });
    resolver.descriptors.delete("XNAS:AAPL");
    resolver.pinnedIds.delete("XNAS:AAPL");

    await resolver.getDescriptor("XNAS:AAPL");

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      instrumentId: "XNAS:AAPL",
      message: expect.stringMatching(/venue/u),
    }));
  });
});

describe("InstrumentResolver curated alias search", () => {
  it.each([
    ["DXY", "INDEX:DX-Y.NYB"],
    ["10Y", "RATE:^TNX"],
    ["BTCUSD", "CRYPTO:BTC-USD"],
    ["ETHUSD", "CRYPTO:ETH-USD"],
    ["FUTURE:GC=F", "FUTURE:CMX.GC.CONTINUOUS.1"],
  ])("answers %s from the curated seed", async (query, instrumentId) => {
    const resolver = buildResolver({
      enabledAssetClasses: ["equity", "index", "crypto", "rate_index", "commodity_future"],
    });

    const [top] = await resolver.searchInstruments(query);

    expect(top.instrument.id).toBe(instrumentId);
    expect(top.provenance.discovery).toBe("catalog");
    expect(top.score).toBeGreaterThan(1);
  });

  it("keeps the best matches when the seed has to be truncated", async () => {
    const resolver = buildResolver({
      enabledAssetClasses: ["equity", "index", "crypto", "rate_index", "fx"],
    });

    const rows = await resolver.searchInstruments("US", { limit: 2 });

    expect(rows.map(({ instrument }) => instrument.id)).toEqual(["FX:USDJPY", "INDEX:DX-Y.NYB"]);
  });

  it("does not let a filtered-out match spend one of the seed's places", async () => {
    const resolver = buildResolver({
      enabledAssetClasses: ["equity", "index", "crypto", "rate_index", "fx"],
    });

    const rows = await resolver.searchInstruments("US", { limit: 1, assetClasses: ["index"] });

    expect(rows.map(({ instrument }) => instrument.id)).toEqual(["INDEX:DX-Y.NYB"]);
  });

  it("keeps a discovered instrument findable by name once the provider stops offering it", async () => {
    const provider = fakeYahooProvider({ GOLD: BARRICK_QUOTE }, [yahooDiscovery(BARRICK_QUOTE, 96)]);
    const resolver = buildResolver({ provider, enabledAssetClasses: ["equity", "commodity_future"] });
    await resolver.searchInstruments("gold");

    provider.discoverInstruments.mockResolvedValue([]);
    const [top] = await resolver.searchInstruments("Barrick");

    expect(top.instrument.id).toBe("XNYS:GOLD");
    expect(top.provenance.discovery).toBe("catalog");
  });
});
