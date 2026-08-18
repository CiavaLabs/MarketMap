import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import {
  CURATED_INSTRUMENTS,
  CURATED_ETF_CLASSIFICATIONS,
  DEFAULT_BOARD_IDS,
  DEFAULT_EQUITY_BOARD_IDS,
  InstrumentCatalog,
  decodeCanonicalId,
  dedupeInstrumentCandidates,
  encodeCanonicalId,
  isCanonicalInstrumentId,
  providerSymbolFor,
} from "../../../server/instruments/InstrumentCatalog.js";

function stock(mic, symbol, name) {
  return {
    id: `${mic}:${symbol}`,
    symbol,
    name,
    assetClass: "equity",
    mic,
    exchange: mic,
    currency: "USD",
    status: "active",
    providerSymbols: { yahoo: symbol, finnhub: symbol },
  };
}

const SECTOR_ETFS = Object.freeze([
  Object.freeze({
    symbol: "XLK",
    name: "State Street Technology Select Sector SPDR ETF",
    category: "Technology",
  }),
  Object.freeze({
    symbol: "XLC",
    name: "State Street Communication Services Select Sector SPDR ETF",
    category: "Communication Services",
  }),
  Object.freeze({
    symbol: "XLY",
    name: "State Street Consumer Discretionary Select Sector SPDR ETF",
    category: "Consumer Discretionary",
  }),
  Object.freeze({
    symbol: "XLP",
    name: "State Street Consumer Staples Select Sector SPDR ETF",
    category: "Consumer Staples",
  }),
  Object.freeze({
    symbol: "XLF",
    name: "State Street Financial Select Sector SPDR ETF",
    category: "Financials",
  }),
  Object.freeze({
    symbol: "XLV",
    name: "State Street Health Care Select Sector SPDR ETF",
    category: "Health Care",
  }),
  Object.freeze({
    symbol: "XLE",
    name: "State Street Energy Select Sector SPDR ETF",
    category: "Energy",
  }),
  Object.freeze({
    symbol: "XLI",
    name: "State Street Industrial Select Sector SPDR ETF",
    category: "Industrials",
  }),
  Object.freeze({
    symbol: "XLU",
    name: "State Street Utilities Select Sector SPDR ETF",
    category: "Utilities",
  }),
  Object.freeze({
    symbol: "XLB",
    name: "State Street Materials Select Sector SPDR ETF",
    category: "Materials",
  }),
]);

describe("canonical instrument ID codec", () => {
  it("encodes the URL-safe namespaces agreed by the v1 API", () => {
    expect(encodeCanonicalId({ assetClass: "equity", mic: "xnas", symbol: "aapl" })).toBe("XNAS:AAPL");
    expect(encodeCanonicalId({ assetClass: "index", symbol: "^gspc" })).toBe("INDEX:^GSPC");
    expect(encodeCanonicalId({ assetClass: "fx", symbol: "EUR/USD" })).toBe("FX:EURUSD");
    expect(encodeCanonicalId({ assetClass: "crypto", symbol: "btc/usd" })).toBe("CRYPTO:BTC-USD");
    expect(encodeCanonicalId({ assetClass: "commodity_future", symbol: "gc=f" }))
      .toBe("FUTURE:CMX.GC.CONTINUOUS.1");
    expect(encodeCanonicalId({ assetClass: "rate_index", symbol: "^tnx" })).toBe("RATE:^TNX");
  });

  it("decodes fixed namespaces while leaving MIC asset class resolution to the catalog", () => {
    expect(decodeCanonicalId("fx:eurusd")).toEqual({
      id: "FX:EURUSD",
      namespace: "FX",
      symbol: "EURUSD",
      assetClass: "fx",
      mic: null,
    });
    expect(decodeCanonicalId("XNAS:AAPL")).toMatchObject({
      namespace: "XNAS",
      symbol: "AAPL",
      assetClass: null,
      mic: "XNAS",
    });
    expect(decodeCanonicalId("FUTURE:CMX.GC.CONTINUOUS.1")).toMatchObject({
      assetClass: "commodity_future",
      symbol: "CMX.GC.CONTINUOUS.1",
    });
  });

  it("rejects IDs with slashes, multiple separators, or unknown namespaces", () => {
    for (const value of ["FX:EUR/USD", "XNAS:AAPL:USD", "UNKNOWN:AAPL", "AAPL"]) {
      expect(isCanonicalInstrumentId(value)).toBe(false);
      expect(() => decodeCanonicalId(value)).toThrowError(expect.objectContaining({
        code: ERROR_CODES.INVALID_REQUEST,
      }));
    }
  });

  it("maps provider symbols without exposing provider syntax in canonical IDs", () => {
    const catalog = new InstrumentCatalog();
    const fx = catalog.resolve("FX:EURUSD");
    expect(providerSymbolFor(fx, "yahoo")).toBe("EURUSD=X");
    expect(providerSymbolFor(fx, "finnhub")).toBe("OANDA:EUR_USD");
  });

  it("rejects uncurated futures instead of minting provider-shaped IDs", () => {
    expect(() => encodeCanonicalId({ assetClass: "commodity_future", symbol: "CL=F" }))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.MAPPING_AMBIGUOUS }));
    expect(new InstrumentCatalog().resolve("GC=F").id).toBe("FUTURE:CMX.GC.CONTINUOUS.1");
  });

  it("keeps reviewed bond funds in the ETF namespace", () => {
    const catalog = new InstrumentCatalog();
    expect(catalog.resolve("BND")).toMatchObject({
      id: "XNAS:BND",
      assetClass: "etf",
      assetSubtype: "bond_etf",
      category: "Fixed Income",
      venueCode: "NGM",
      providerSymbols: { yahoo: "BND" },
    });
    expect(catalog.resolve("AGG")).toMatchObject({
      id: "ARCX:AGG",
      assetClass: "etf",
      assetSubtype: "bond_etf",
      category: "Fixed Income",
      venueCode: "PCX",
      providerSymbols: { yahoo: "AGG" },
    });
    expect(CURATED_ETF_CLASSIFICATIONS.BND.assetSubtype).toBe("bond_etf");
    expect(CURATED_ETF_CLASSIFICATIONS.AGG.assetSubtype).toBe("bond_etf");
  });
});

describe("InstrumentCatalog", () => {
  it("ships the initial equity board and current client symbols", () => {
    const catalog = new InstrumentCatalog();
    expect(DEFAULT_BOARD_IDS).toHaveLength(40);
    expect(DEFAULT_EQUITY_BOARD_IDS).toHaveLength(28);
    expect(CURATED_INSTRUMENTS.length).toBeGreaterThan(DEFAULT_BOARD_IDS.length);
    expect(DEFAULT_BOARD_IDS.every((id) => catalog.resolve(id).id === id)).toBe(true);
    expect(catalog.resolve("AAPL").id).toBe("XNAS:AAPL");
    expect(catalog.resolve("AVGO").id).toBe("XNAS:AVGO");
    expect(catalog.resolve("COST").id).toBe("XNAS:COST");
    expect(catalog.resolve("WMT").id).toBe("XNAS:WMT");
    expect(catalog.resolve("LIN").id).toBe("XNAS:LIN");
  });

  it("registers the reviewed NYSE Arca sector ETFs without inferring identity or category", () => {
    const catalog = new InstrumentCatalog();

    for (const { symbol, name, category } of SECTOR_ETFS) {
      expect(catalog.resolve(symbol)).toMatchObject({
        id: `ARCX:${symbol}`,
        symbol,
        name,
        assetClass: "etf",
        assetSubtype: "equity_etf",
        exchange: "NYSE Arca",
        venueCode: "PCX",
        mic: "ARCX",
        currency: "USD",
        country: "US",
        category,
        status: "active",
        providerSymbols: { yahoo: symbol },
      });
      expect(catalog.resolve(`ARCX:${symbol}`).id).toBe(`ARCX:${symbol}`);
      expect(CURATED_ETF_CLASSIFICATIONS[symbol]).toEqual({
        assetSubtype: "equity_etf",
        category,
      });
    }
  });

  it("ranks exact ticker matches ahead of prefix and name matches", () => {
    const catalog = new InstrumentCatalog();
    const results = catalog.search("AAPL");
    expect(results[0]).toMatchObject({ id: "XNAS:AAPL" });
    expect(results[0].score).toBeGreaterThanOrEqual(200);
    expect(catalog.search("Microsoft")[0].id).toBe("XNAS:MSFT");
  });

  it("filters by asset class, exchange, and currency", () => {
    const catalog = new InstrumentCatalog();
    expect(catalog.search("SPY", { assetClasses: ["etf"] }).map((item) => item.id)).toEqual(["ARCX:SPY"]);
    expect(catalog.search("Apple", { exchange: "XNYS" })).toEqual([]);
    expect(catalog.search("Apple", { exchange: "XNAS", currency: "USD" })[0].id).toBe("XNAS:AAPL");
  });

  it("detects ambiguous raw tickers instead of choosing a venue", () => {
    const catalog = new InstrumentCatalog({
      instruments: [
        stock("XNAS", "DUPE", "Duplicate Nasdaq"),
        stock("XNYS", "DUPE", "Duplicate NYSE"),
      ],
    });
    expect(() => catalog.resolve("DUPE")).toThrowError(expect.objectContaining({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
      details: { query: "DUPE", candidates: ["XNAS:DUPE", "XNYS:DUPE"] },
    }));
    expect(catalog.resolve("DUPE", { mic: "XNYS" }).id).toBe("XNYS:DUPE");
  });

  it("registers provider discoveries for subsequent profile and history resolution", () => {
    const catalog = new InstrumentCatalog({ instruments: [] });
    catalog.register({
      ...stock("XNAS", "PLTR", "Palantir Technologies Inc."),
      providerSymbols: { yahoo: "PLTR" },
    });
    expect(catalog.resolve("XNAS:PLTR")).toMatchObject({
      symbol: "PLTR",
      providerSymbols: { yahoo: "PLTR" },
    });
    expect(catalog.resolve("PLTR").id).toBe("XNAS:PLTR");
  });

  it("deduplicates by canonical ID and merges provider mappings", () => {
    const results = dedupeInstrumentCandidates([
      {
        ...stock("XNAS", "AAPL", "Apple"),
        score: 200,
        providerSymbols: { yahoo: "AAPL" },
      },
      {
        ...stock("XNAS", "AAPL", "Apple Inc."),
        score: 199,
        providerSymbols: { finnhub: "AAPL" },
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "XNAS:AAPL",
      name: "Apple",
      providerSymbols: { yahoo: "AAPL", finnhub: "AAPL" },
    });
  });

  it("keeps unknown canonical IDs strict after a cold catalog restart", () => {
    const catalog = new InstrumentCatalog({ instruments: [] });
    expect(() => catalog.resolve("XNAS:PLTR")).toThrowError(expect.objectContaining({
      code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
      instrumentId: "XNAS:PLTR",
    }));
  });
});
