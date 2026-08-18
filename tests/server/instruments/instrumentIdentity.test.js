import { describe, expect, it } from "vitest";

import { HISTORY_ALLOWLIST } from "../../../server/contracts/core/history.js";
import {
  InMemoryInstrumentCatalogStore,
  normalizeCatalogRecord,
  toIsoTimestamp,
} from "../../../server/instruments/InstrumentCatalogStore.js";
import {
  VENUE_REGISTRY_VERSION,
  isResolvedExchangeVenue,
  providerSymbolCandidatesForVenue,
  resolveVenue,
  venueForMic,
} from "../../../server/instruments/VenueRegistry.js";
import {
  assetClassFromQuoteType,
  descriptorFromLegacyInstrument,
  descriptorFromYahooQuote,
} from "../../../server/instruments/descriptorFactory.js";
import { buildEffectiveCapabilities } from "../../../server/instruments/effectiveCapabilities.js";

const CLOCK = () => Date.parse("2026-07-16T12:00:00.000Z");

const quote = (patch = {}) => ({
  symbol: "AAPL",
  quoteType: "EQUITY",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  longName: "Apple Inc.",
  currency: "USD",
  ...patch,
});

const build = (patch = {}, options = {}) => descriptorFromYahooQuote({
  providerSymbol: patch.symbol ?? "AAPL",
  quote: quote(patch),
  clock: CLOCK,
  ...options,
});

describe("venue resolution", () => {
  it("publishes a registry version", () => {
    expect(VENUE_REGISTRY_VERSION).toBe(1);
  });

  it.each([
    ["NMS", "XNAS", "exchange"],
    ["nyq", "XNYS", "exchange"],
    ["  PCX  ", "ARCX", "exchange"],
    ["CCY", null, "fx_network"],
    ["SNP", null, "index_publisher"],
    ["CME", "XCME", "futures_exchange"],
  ])("resolves %s to %s", (code, mic, kind) => {
    const venue = resolveVenue({ code });
    expect(venue).toMatchObject({ mic, kind, confidence: "exact" });
  });

  it("never guesses a MIC for an unknown code", () => {
    expect(resolveVenue({ code: "ZZZ", fullName: "Somewhere" })).toEqual({
      code: "ZZZ",
      name: "Somewhere",
      mic: null,
      kind: "unknown",
      confidence: "unknown",
    });
  });

  it("falls back through code and a placeholder name", () => {
    expect(resolveVenue({ code: "ZZZ" }).name).toBe("ZZZ");
    expect(resolveVenue({}).name).toBe("Unknown venue");
    expect(resolveVenue().code).toBe("UNKNOWN");
  });

  it("ignores registries for other providers", () => {
    expect(resolveVenue({ provider: "finnhub", code: "NMS" }).kind).toBe("unknown");
  });

  it("reverses a MIC back to its venue", () => {
    expect(venueForMic("XNAS")).toMatchObject({ code: "NMS", name: "NasdaqGS" });
    expect(venueForMic(" xlon ")).toMatchObject({ mic: "XLON" });
    expect(venueForMic("XXXX")).toBeNull();
    expect(venueForMic(null)).toBeNull();
  });

  it("recognises only resolved exchange venues", () => {
    expect(isResolvedExchangeVenue(resolveVenue({ code: "NMS" }))).toBe(true);
    expect(isResolvedExchangeVenue(resolveVenue({ code: "ZZZ" }))).toBe(false);
    expect(isResolvedExchangeVenue(resolveVenue({ code: "CCY" }))).toBe(false);
    expect(isResolvedExchangeVenue(null)).toBe(false);
  });

  it("suffixes provider symbols only for venues that declare one", () => {
    expect(providerSymbolCandidatesForVenue({ symbol: "ASML", mic: "XAMS" }))
      .toEqual(["ASML.AS", "ASML"]);
    expect(providerSymbolCandidatesForVenue({ symbol: "ASML.AS", mic: "XAMS" }))
      .toEqual(["ASML.AS"]);
    expect(providerSymbolCandidatesForVenue({ symbol: "AAPL", mic: "XNAS" }))
      .toEqual(["AAPL"]);
    expect(providerSymbolCandidatesForVenue({ symbol: "AAPL", mic: "XXXX" }))
      .toEqual(["AAPL"]);
  });

  it("returns no candidates without a symbol or for another provider", () => {
    expect(providerSymbolCandidatesForVenue({ symbol: "", mic: "XNAS" })).toEqual([]);
    expect(providerSymbolCandidatesForVenue({ provider: "finnhub", symbol: "AAPL" })).toEqual([]);
    expect(providerSymbolCandidatesForVenue()).toEqual([]);
  });
});

describe("asset class from quote type", () => {
  it.each([
    ["EQUITY", "AAPL", "equity"],
    ["etf", "SPY", "etf"],
    ["INDEX", "^GSPC", "index"],
    ["INDEX", "^TNX", "rate_index"],
    ["CURRENCY", "EURUSD=X", "fx"],
    ["CRYPTOCURRENCY", "BTC-USD", "crypto"],
    ["FUTURE", "GC=F", "commodity_future"],
    ["BOND", "DE0001102309", "bond"],
    ["OPTION", "AAPL260116C", null],
    [null, "AAPL", null],
  ])("maps %s to %s", (quoteType, symbol, expected) => {
    expect(assetClassFromQuoteType(quoteType, symbol)).toBe(expected);
  });
});

describe("descriptors from a Yahoo quote", () => {
  it("builds a resolved equity descriptor", () => {
    const { descriptor, typeConflict, reasonCode } = build();
    expect(reasonCode).toBeNull();
    expect(typeConflict).toBe(false);
    expect(descriptor).toMatchObject({
      id: "XNAS:AAPL",
      symbol: "AAPL",
      displaySymbol: "AAPL",
      assetClass: "equity",
      currency: "USD",
      exchange: "NasdaqGS",
      mappingStatus: "resolved",
    });
    expect(descriptor.providerSymbols.yahoo).toMatchObject({
      symbol: "AAPL",
      verified: true,
      verifiedAt: "2026-07-16T12:00:00.000Z",
      providerType: "EQUITY",
    });
  });

  it("drops a Yahoo venue suffix from the identity but keeps the provider symbol", () => {
    const { descriptor } = build({ symbol: "ASML.AS", exchange: "AMS", currency: "EUR" });
    expect(descriptor.id).toBe("XAMS:ASML");
    expect(descriptor.symbol).toBe("ASML");
    expect(descriptor.providerSymbols.yahoo.symbol).toBe("ASML.AS");
  });

  it("builds an FX pair from the symbol and keeps the =X suffix on the provider side only", () => {
    const { descriptor } = build({
      symbol: "EURUSD=X",
      quoteType: "CURRENCY",
      exchange: "CCY",
      currency: "USD",
    });
    expect(descriptor).toMatchObject({
      id: "FX:EURUSD",
      symbol: "EURUSD",
      displaySymbol: "EUR/USD",
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      assetSubtype: "spot_pair",
    });
    expect(descriptor.providerSymbols.yahoo.symbol).toBe("EURUSD=X");
    expect(descriptor.venue.kind).toBe("fx_network");
    expect(descriptor.venue.mic).toBeNull();
  });

  it("builds a crypto pair and prefers the quote's base currency", () => {
    const { descriptor } = build({
      symbol: "BTC-USD",
      quoteType: "CRYPTOCURRENCY",
      exchange: "CCC",
      currency: "USD",
      fromCurrency: "BTC",
    });
    expect(descriptor).toMatchObject({
      displaySymbol: "BTC/USD",
      baseCurrency: "BTC",
      quoteCurrency: "USD",
    });
  });

  it("strips the caret from an index but keeps it in the identity", () => {
    const { descriptor } = build({ symbol: "^FTSE", quoteType: "INDEX", exchange: "FGI" });
    expect(descriptor.displaySymbol).toBe("FTSE");
    expect(descriptor.symbol).toBe("^FTSE");
    expect(descriptor.assetSubtype).toBe("market_index");
  });

  it("prefers a curated market ticker where the provider code is not one", () => {
    const { descriptor } = build({ symbol: "^GSPC", quoteType: "INDEX", exchange: "SNP" });
    expect(descriptor.displaySymbol).toBe("SPX");
    expect(descriptor.symbol).toBe("^GSPC");
    expect(descriptor.id).toBe("INDEX:^GSPC");
  });

  it("classifies a curated rate index as a yield index", () => {
    const { descriptor } = build({ symbol: "^TNX", quoteType: "INDEX", exchange: "NIM" });
    expect(descriptor).toMatchObject({ assetClass: "rate_index", assetSubtype: "yield_index" });
  });

  it("invents an index publisher when the venue is unknown", () => {
    const { descriptor } = build({
      symbol: "^FTSE",
      quoteType: "INDEX",
      exchange: "FTS",
      fullExchangeName: "FTSE Russell",
    });
    expect(descriptor.venue).toMatchObject({ code: "FTS", name: "FTSE Russell", mic: null, kind: "index_publisher" });
  });

  it("falls back to a placeholder publisher with no exchange at all", () => {
    const { descriptor } = build({
      symbol: "^X",
      quoteType: "INDEX",
      exchange: null,
      fullExchangeName: null,
    });
    expect(descriptor.venue).toMatchObject({ code: "PUB", name: "Index publisher" });
  });

  it("builds an allowlisted continuous future", () => {
    const { descriptor } = build({
      symbol: "GC=F",
      quoteType: "FUTURE",
      exchange: "CMX",
      fullExchangeName: "COMEX",
      currency: "USD",
    });
    expect(descriptor).toMatchObject({
      assetClass: "commodity_future",
      assetSubtype: "continuous_front",
    });
    expect(descriptor.venue.kind).toBe("futures_exchange");
  });

  it("reports a type conflict between discovery and the quote", () => {
    const { typeConflict } = build({}, { discovery: { quoteType: "ETF" } });
    expect(typeConflict).toBe(true);
  });

  it("does not report a conflict when discovery agrees", () => {
    expect(build({}, { discovery: { quoteType: "EQUITY" } }).typeConflict).toBe(false);
  });

  it.each([
    ["a single bond", { quoteType: "BOND", symbol: "DE0001102309" }, "single_bond_unsupported"],
    ["an unmapped quote type", { quoteType: "OPTION" }, "unsupported_asset"],
    ["a future outside the allowlist", {
      symbol: "ZZ=F",
      quoteType: "FUTURE",
      exchange: "CMX",
    }, "future_not_allowlisted"],
    ["a listed instrument on an unknown venue", { exchange: "ZZZ" }, "unsupported_venue"],
    ["a quote with no usable currency", { currency: null }, "identity_incomplete"],
  ])("refuses to invent an identity for %s", (_label, patch, reasonCode) => {
    const result = build(patch);
    expect(result.descriptor).toBeNull();
    expect(result.reasonCode).toBe(reasonCode);
    expect(result.candidate.providerSymbol).toBe(patch.symbol ?? "AAPL");
  });

  it("names an unsupported candidate after its symbol when the quote has no name", () => {
    const { candidate } = build({ quoteType: "OPTION", longName: null, shortName: null });
    expect(candidate.name).toBe("AAPL");
  });

  it("prefers the discovery name when the quote has none", () => {
    const { candidate } = build(
      { quoteType: "OPTION", longName: null, shortName: null },
      { discovery: { name: "Apple call" } },
    );
    expect(candidate.name).toBe("Apple call");
  });

  it("reports an identity the catalog cannot encode as ambiguous", () => {
    const result = build({ symbol: "BTC-USD", quoteType: "CRYPTOCURRENCY", exchange: "CCC", currency: "US" });
    expect(result.reasonCode).toBe("identity_incomplete");
  });

  it.each([
    ["no quote at all", { providerSymbol: "AAPL", quote: null }],
    ["a non-object quote", { providerSymbol: "AAPL", quote: "AAPL" }],
    ["no symbol anywhere", { providerSymbol: "", quote: {} }],
  ])("rejects %s", (_label, input) => {
    expect(() => descriptorFromYahooQuote({ ...input, clock: CLOCK }))
      .toThrowError(/A Yahoo quote is required/u);
  });

  it("takes the symbol from the quote when none is supplied", () => {
    const { descriptor } = descriptorFromYahooQuote({ quote: quote(), clock: CLOCK });
    expect(descriptor.id).toBe("XNAS:AAPL");
  });

  it("falls back to the wall clock when none is supplied", () => {
    const { descriptor } = descriptorFromYahooQuote({ quote: quote(), clock: null });
    expect(Number.isFinite(Date.parse(descriptor.providerSymbols.yahoo.verifiedAt))).toBe(true);
  });
});

describe("descriptors from curated legacy instruments", () => {
  const legacy = (patch = {}) => ({
    id: "XNAS:AAPL",
    symbol: "AAPL",
    name: "Apple Inc.",
    assetClass: "equity",
    exchange: "Nasdaq",
    mic: "XNAS",
    currency: "USD",
    status: "active",
    providerSymbols: { yahoo: "AAPL", finnhub: "AAPL" },
    ...patch,
  });

  it("converts a curated equity and marks its mappings verified", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy(), {
      verifiedAt: "2026-07-16T12:00:00.000Z",
    });
    expect(descriptor).toMatchObject({
      id: "XNAS:AAPL",
      assetClass: "equity",
      mappingStatus: "resolved",
      currency: "USD",
    });
    expect(descriptor.providerSymbols.finnhub).toEqual({
      symbol: "AAPL",
      verified: true,
      verifiedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("stamps the epoch when no verification date is supplied", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy());
    expect(descriptor.providerSymbols.yahoo.verifiedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects an instrument that carries no provider mappings", () => {
    expect(() => descriptorFromLegacyInstrument(legacy({ providerSymbols: {} })))
      .toThrowError(/InstrumentDescriptor failed runtime validation/u);
    expect(() => descriptorFromLegacyInstrument(legacy({ providerSymbols: undefined })))
      .toThrowError(/InstrumentDescriptor failed runtime validation/u);
  });

  it("resolves an explicit venue code", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy({ venueCode: "PCX", mic: "ARCX", id: "ARCX:SPY", symbol: "SPY", assetClass: "etf" }));
    expect(descriptor.venue).toMatchObject({ code: "PCX", mic: "ARCX" });
  });

  it("derives a venue from the MIC alone", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy());
    expect(descriptor.venue).toMatchObject({ code: "NMS", mic: "XNAS" });
  });

  it("keeps an unregistered MIC as its own venue", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy({
      id: "XTKS:7203",
      symbol: "7203",
      mic: "XTKS",
      exchange: "Tokyo Stock Exchange",
      currency: "JPY",
    }));
    expect(descriptor.venue).toMatchObject({
      code: "XTKS",
      name: "Tokyo Stock Exchange",
      mic: "XTKS",
      kind: "exchange",
    });
  });

  it("promotes a curated rate index", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy({
      id: "INDEX:^TNX",
      symbol: "^TNX",
      assetClass: "index",
      mic: null,
      exchange: "Nasdaq Indices",
      venueCode: "NIM",
    }));
    expect(descriptor).toMatchObject({ assetClass: "rate_index", displaySymbol: "TNX" });
  });

  it("carries a curated category and subtype through", () => {
    const descriptor = descriptorFromLegacyInstrument(legacy({
      id: "ARCX:SPY",
      symbol: "SPY",
      assetClass: "etf",
      assetSubtype: "equity_etf",
      category: "Large Blend",
      mic: "ARCX",
      exchange: "NYSE Arca",
    }));
    expect(descriptor).toMatchObject({ assetSubtype: "equity_etf", category: "Large Blend" });
  });

  it("rejects a venue code that disagrees with the MIC", () => {
    expect(() => descriptorFromLegacyInstrument(legacy({ venueCode: "PCX" })))
      .toThrowError(/Venue code and MIC disagree/u);
  });

  it("rejects an instrument with no derivable venue", () => {
    expect(() => descriptorFromLegacyInstrument(legacy({ mic: null, exchange: null })))
      .toThrowError(/No venue can be derived/u);
  });

  it("rejects an unsupported asset class", () => {
    expect(() => descriptorFromLegacyInstrument(legacy({ assetClass: "warrant" })))
      .toThrowError();
  });
});

describe("effective capabilities", () => {
  const manifest = (patch = {}) => ({
    assets: {
      equity: {
        quote: { support: "supported", fields: { price: "supported" } },
        history: {
          support: "supported",
          priceBases: ["provider_adjusted", "raw"],
          intervals: Object.values(HISTORY_ALLOWLIST).flat(),
        },
        details: { support: "supported", sections: ["profile", "fundamentals", "valuation", "analysts"] },
        news: { support: "supported" },
        ...patch,
      },
    },
  });

  it("intersects the manifest with the asset policy", () => {
    const capabilities = buildEffectiveCapabilities({
      assetClass: "equity",
      manifests: [manifest()],
    });
    expect(capabilities.quote.status).toBe("supported");
    expect(capabilities.history.priceBases.length).toBeGreaterThan(0);
    expect(capabilities.analytics).toEqual({
      status: "unsupported",
      reason: "not_available_in_current_release",
    });
  });

  it("reports every capability as disabled when the asset class is off", () => {
    const capabilities = buildEffectiveCapabilities({
      assetClass: "equity",
      manifests: [manifest()],
      enabledAssetClasses: [],
    });
    expect(capabilities.quote).toEqual({ status: "unsupported", reason: "asset_class_disabled" });
    expect(capabilities.analytics).toEqual({ status: "unsupported", reason: "asset_class" });
  });

  it("reports no provider coverage when no manifest supports the class", () => {
    const capabilities = buildEffectiveCapabilities({ assetClass: "equity", manifests: [] });
    for (const key of ["quote", "history", "details", "news"]) {
      expect(capabilities[key]).toEqual({ status: "unsupported", reason: "no_provider_coverage" });
    }
  });

  it("skips a manifest entry that declares itself unsupported", () => {
    const unsupported = manifest({ quote: { support: "unsupported" } });
    const capabilities = buildEffectiveCapabilities({
      assetClass: "equity",
      manifests: [unsupported, manifest()],
    });
    expect(capabilities.quote.status).toBe("supported");
  });

  it("reports unsupported semantics when the provider shares no price basis", () => {
    const narrow = manifest({
      history: { support: "supported", priceBases: ["gross"], intervals: ["1d"] },
    });
    const capabilities = buildEffectiveCapabilities({ assetClass: "equity", manifests: [narrow] });
    expect(capabilities.history).toEqual({
      status: "unsupported",
      reason: "no_supported_semantics",
    });
  });

  it("reports no applicable sections when the provider shares none", () => {
    const narrow = manifest({ details: { support: "supported", sections: ["nothing"] } });
    const capabilities = buildEffectiveCapabilities({ assetClass: "equity", manifests: [narrow] });
    expect(capabilities.details).toEqual({
      status: "unsupported",
      reason: "no_applicable_sections",
    });
  });
});

describe("catalog record normalization", () => {
  const descriptor = () => descriptorFromYahooQuote({
    providerSymbol: "AAPL",
    quote: quote(),
    clock: CLOCK,
  }).descriptor;

  it("normalizes a record and defaults its revision", () => {
    const record = normalizeCatalogRecord({
      descriptor: descriptor(),
      lastSeenAt: "2026-07-16T12:00:00.000Z",
    });
    expect(record).toMatchObject({
      instrumentId: "XNAS:AAPL",
      mappingRevision: 1,
      verifiedAt: null,
      status: "active",
    });
  });

  it.each([
    ["a non-object", null],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeCatalogRecord(value)).toThrowError(/must be an object/u);
  });

  it("rejects an instrumentId that contradicts its descriptor", () => {
    expect(() => normalizeCatalogRecord({
      instrumentId: "XNAS:MSFT",
      descriptor: descriptor(),
    })).toThrowError(/must match its descriptor/u);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s mapping revision", (_label, mappingRevision) => {
    expect(() => normalizeCatalogRecord({ descriptor: descriptor(), mappingRevision }))
      .toThrowError(/mappingRevision must be a positive integer/u);
  });

  it("normalizes timestamps and rejects unreadable ones", () => {
    expect(toIsoTimestamp(new Date(0), "lastSeenAt")).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoTimestamp(0, "lastSeenAt")).toBe("1970-01-01T00:00:00.000Z");
    expect(() => toIsoTimestamp("never", "lastSeenAt"))
      .toThrowError(/lastSeenAt must be a valid timestamp/u);
  });
});

describe("in-memory catalog store", () => {
  it("stores, reads back and deletes a descriptor", async () => {
    const store = new InMemoryInstrumentCatalogStore({ clock: CLOCK });
    const record = await store.set({
      descriptor: descriptorFromYahooQuote({
        providerSymbol: "AAPL",
        quote: quote(),
        clock: CLOCK,
      }).descriptor,
    });

    expect(record.lastSeenAt).toBe("2026-07-16T12:00:00.000Z");
    expect(store.size).toBe(1);
    expect(await store.get("xnas:aapl")).toEqual(record);
    expect(await store.get("XNAS:MSFT")).toBeNull();
    expect(await store.delete("XNAS:AAPL")).toBe(true);
    expect(await store.delete("XNAS:AAPL")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("hands out copies rather than its own records", async () => {
    const store = new InMemoryInstrumentCatalogStore({ clock: CLOCK });
    const { descriptor } = descriptorFromYahooQuote({
      providerSymbol: "AAPL",
      quote: quote(),
      clock: CLOCK,
    });
    await store.set({ descriptor });
    const read = await store.get("XNAS:AAPL");
    read.descriptor.name = "Mutated";
    expect((await store.get("XNAS:AAPL")).descriptor.name).toBe("Apple Inc.");
  });

  it("closes once and stays closed", async () => {
    const store = new InMemoryInstrumentCatalogStore();
    const first = store.close();
    expect(store.close()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
