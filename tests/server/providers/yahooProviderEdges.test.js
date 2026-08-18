import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { EQUITY_DESCRIPTOR, ETF_DESCRIPTOR } from "../fixtures/market/descriptors.js";
import {
  FIXED_NOW,
  YAHOO_AAPL_HISTORY,
  YAHOO_AAPL_PROFILE,
  YAHOO_AAPL_QUOTE,
  YAHOO_SEARCH_RESULTS,
} from "./fixtures/yahoo.js";
import { curatedDescriptor as descriptorFor } from "../fixtures/market/curatedDescriptors.js";

function client(overrides = {}) {
  return {
    quote: vi.fn(async () => [YAHOO_AAPL_QUOTE]),
    search: vi.fn(async () => YAHOO_SEARCH_RESULTS),
    chart: vi.fn(async () => YAHOO_AAPL_HISTORY),
    quoteSummary: vi.fn(async () => YAHOO_AAPL_PROFILE),
    ...overrides,
  };
}

function setup(overrides = {}) {
  const catalog = overrides.catalog || new InstrumentCatalog();
  const yahooClient = overrides.client || client();
  return {
    catalog,
    client: yahooClient,
    provider: new YahooProvider({
      client: yahooClient,
      clock: () => FIXED_NOW,
    }),
  };
}

const thrown = (run) => run().then(() => null, (error) => error);

const verifiedDescriptor = (patch = {}) => ({ ...EQUITY_DESCRIPTOR, ...patch });

const unverified = (patch = {}) => verifiedDescriptor({
  providerSymbols: {
    yahoo: { symbol: "AAPL", verified: false, verifiedAt: null },
    ...patch,
  },
});

describe("YahooProvider construction", () => {
  it.each([
    ["no client at all", null],
    ["a non-object client", "yahoo"],
  ])("refuses %s", (_label, value) => {
    expect(() => new YahooProvider({ client: value }))
      .toThrowError(/requires a client object/u);
  });
});

describe("Yahoo discovery", () => {
  it.each([
    ["too short", "a"],
    ["too long", "x".repeat(81)],
    ["blank", "   "],
    ["absent", null],
  ])("rejects a query that is %s", async (_label, query) => {
    const { provider } = setup();
    await expect(provider.discoverInstruments(query)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
      capability: "search",
    });
  });

  it("normalizes the upstream failure", async () => {
    const yahooClient = client({ search: vi.fn(async () => { throw new Error("upstream down"); }) });
    const { provider } = setup({ client: yahooClient });
    await expect(provider.discoverInstruments("apple")).rejects.toMatchObject({
      provider: "yahoo",
      capability: "search",
    });
  });

  it("clamps the requested result count", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.discoverInstruments("apple", { limit: 500 });
    expect(yahooClient.search.mock.calls[0][1].quotesCount).toBe(20);

    await provider.discoverInstruments("apple", { limit: 0 });
    expect(yahooClient.search.mock.calls[1][1].quotesCount).toBe(20);
  });

  it("drops rows that cannot become an instrument and deduplicates the rest", async () => {
    const yahooClient = client({
      search: vi.fn(async () => ({
        quotes: [
          null,
          { symbol: "AAPL", quoteType: "EQUITY", isYahooFinance: false },
          { symbol: "", quoteType: "EQUITY" },
          { symbol: "AAPL", quoteType: "OPTION" },
          { symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS", exchDisp: "NASDAQ", longname: "Apple Inc." },
          { symbol: "AAPL", quoteType: "EQUITY" },
        ],
      })),
    });
    const { provider } = setup({ client: yahooClient });

    const discoveries = await provider.discoverInstruments("apple");

    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatchObject({
      provider: "yahoo",
      providerSymbol: "AAPL",
      quoteType: "EQUITY",
      exchangeCode: "NMS",
      exchangeName: "NASDAQ",
      name: "Apple Inc.",
      mappingStatus: "provisional",
    });
  });

  it("names a discovery after its symbol when the row carries none", async () => {
    const yahooClient = client({
      search: vi.fn(async () => ({ quotes: [{ symbol: "ZZZZ", quoteType: "EQUITY" }] })),
    });
    const { provider } = setup({ client: yahooClient });

    const [discovery] = await provider.discoverInstruments("zzzz");
    expect(discovery).toMatchObject({ name: "ZZZZ", exchangeCode: null, exchangeName: null, score: 0 });
  });

  it("survives a payload with no quotes at all", async () => {
    const { provider } = setup({ client: client({ search: vi.fn(async () => ({})) }) });
    expect(await provider.discoverInstruments("apple")).toEqual([]);
  });
});

describe("Yahoo quote hydration", () => {
  it("returns nothing for an empty or unusable symbol list", async () => {
    const { provider, client: yahooClient } = setup();
    expect(await provider.hydrateQuotes([])).toEqual(new Map());
    expect(await provider.hydrateQuotes([null, "  "])).toEqual(new Map());
    expect(await provider.hydrateQuotes()).toEqual(new Map());
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("upper-cases and deduplicates the symbols it asks for", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.hydrateQuotes(["aapl", "AAPL", " aapl "]);
    expect(yahooClient.quote.mock.calls[0][0]).toEqual(["AAPL"]);
  });

  it("normalizes an upstream failure", async () => {
    const yahooClient = client({ quote: vi.fn(async () => { throw new Error("upstream down"); }) });
    const { provider } = setup({ client: yahooClient });
    await expect(provider.hydrateQuotes(["AAPL"])).rejects.toMatchObject({
      provider: "yahoo",
      capability: "quote",
    });
  });

  it("drops entries that are not objects", async () => {
    const yahooClient = client({ quote: vi.fn(async () => [null, YAHOO_AAPL_QUOTE]) });
    const { provider } = setup({ client: yahooClient });
    expect([...(await provider.hydrateQuotes(["AAPL"])).keys()]).toEqual(["AAPL"]);
  });
});

describe("Yahoo v2 quotes", () => {
  it.each([
    ["a bare string", "XNAS:AAPL"],
    ["nothing at all", undefined],
  ])("rejects %s rather than reading it as a descriptor list", async (_label, request) => {
    const { provider, client: yahooClient } = setup();
    await expect(provider.quoteMany(request)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
      capability: "quote",
    });
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("collapses a descriptor requested twice into one provider symbol", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.quoteMany([EQUITY_DESCRIPTOR, EQUITY_DESCRIPTOR]);
    expect(yahooClient.quote.mock.calls[0][0]).toEqual(["AAPL"]);
  });

  it.each([
    ["a single quote object", () => YAHOO_AAPL_QUOTE],
    ["a symbol-keyed map", () => ({ AAPL: YAHOO_AAPL_QUOTE })],
  ])("reads a payload shaped as %s", async (_label, quote) => {
    const { provider } = setup({ client: client({ quote: vi.fn(async () => quote()) }) });
    const result = await provider.quoteMany([EQUITY_DESCRIPTOR]);
    expect(result.data).toHaveLength(1);
  });

  it("returns nothing when the payload cannot be read as quotes at all", async () => {
    const { provider } = setup({ client: client({ quote: vi.fn(async () => 42) }) });
    const result = await provider.quoteMany([EQUITY_DESCRIPTOR]);
    expect(result.data).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it.each([
    ["a descriptor with no id", { providerSymbols: { yahoo: { symbol: "AAPL", verified: true } } }],
    ["an unverified mapping", unverified()],
    ["a blank provider symbol", verifiedDescriptor({
      providerSymbols: { yahoo: { symbol: "   ", verified: true } },
    })],
    ["no mapping at all", verifiedDescriptor({ providerSymbols: {} })],
  ])("refuses to quote %s", async (_label, descriptor) => {
    const { provider, client: yahooClient } = setup();
    const result = await provider.quoteMany([descriptor]);

    expect(result.data).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
      retryable: false,
    });
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("answers an empty descriptor list without calling the provider", async () => {
    const { provider, client: yahooClient } = setup();
    expect(await provider.quoteMany([])).toEqual({ data: [], errors: [] });
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("reports every descriptor when hydration fails", async () => {
    const yahooClient = client({ quote: vi.fn(async () => { throw new Error("upstream down"); }) });
    const { provider } = setup({ client: yahooClient });

    const result = await provider.quoteMany([EQUITY_DESCRIPTOR, ETF_DESCRIPTOR]);
    expect(result.data).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });

  it("reports a descriptor the provider omitted", async () => {
    const yahooClient = client({ quote: vi.fn(async () => []) });
    const { provider } = setup({ client: yahooClient });

    const result = await provider.quoteMany([EQUITY_DESCRIPTOR]);
    expect(result.errors[0]).toMatchObject({
      code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
      instrumentId: "XNAS:AAPL",
      retryable: false,
    });
  });

  it("keeps a v2 quote that fails normalization item-local", async () => {
    const yahooClient = client({
      quote: vi.fn(async () => [{ ...YAHOO_AAPL_QUOTE, regularMarketPrice: -1 }]),
    });
    const { provider } = setup({ client: yahooClient });

    const result = await provider.quoteMany([EQUITY_DESCRIPTOR]);
    expect(result.data).toEqual([]);
    expect(result.errors[0].instrumentId).toBe("XNAS:AAPL");
  });
});

describe("Yahoo v2 history", () => {
  it("refuses an interval outside the allowlist before calling the provider", async () => {
    const { provider, client: yahooClient } = setup();
    await expect(provider.history(EQUITY_DESCRIPTOR, { range: "1d", interval: "7m" }))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    expect(yahooClient.chart).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreadable period", { period1: "never" }],
    ["an unreadable end", { period2: "never" }],
  ])("refuses %s", async (_label, options) => {
    const { provider } = setup();
    await expect(provider.history(EQUITY_DESCRIPTOR, { range: "1d", interval: "5m", ...options }))
      .rejects.toThrowError(/valid ascending dates/u);
  });

  it("defaults the interval from the requested range", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.history(EQUITY_DESCRIPTOR, { range: "5y" });
    expect(yahooClient.chart.mock.calls[0][1].interval).toBe("1wk");
  });

  it.each([
    ["a descriptor with no id", {}],
    ["an unverified mapping", unverified()],
  ])("refuses %s", async (_label, descriptor) => {
    const { provider } = setup();
    await expect(provider.history(descriptor)).rejects.toMatchObject({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
      retryable: false,
    });
  });

  it("refuses a range and interval that do not pair", async () => {
    const { provider, client: yahooClient } = setup();
    await expect(provider.history(EQUITY_DESCRIPTOR, { range: "5y", interval: "1m" }))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, retryable: false });
    expect(yahooClient.chart).not.toHaveBeenCalled();
  });

  it("refuses a period that runs backwards", async () => {
    const { provider } = setup();
    await expect(provider.history(EQUITY_DESCRIPTOR, {
      range: "1d",
      interval: "5m",
      period1: "2026-07-13",
      period2: "2026-07-01",
    })).rejects.toThrowError(/valid ascending dates/u);
  });

  it("does not fetch a companion quote for a non-future", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.history(EQUITY_DESCRIPTOR, { range: "1d", interval: "5m" }).catch(() => {});
    expect(yahooClient.quote).not.toHaveBeenCalled();
  });

  it("normalizes an upstream failure", async () => {
    const yahooClient = client({ chart: vi.fn(async () => { throw new Error("upstream down"); }) });
    const { provider } = setup({ client: yahooClient });
    await expect(provider.history(EQUITY_DESCRIPTOR, { range: "1d", interval: "5m" }))
      .rejects.toMatchObject({ provider: "yahoo", capability: "history" });
  });
});

describe("Yahoo v2 details", () => {
  it.each([
    ["a descriptor with no id", {}],
    ["an unverified mapping", unverified()],
  ])("refuses %s", async (_label, descriptor) => {
    const { provider } = setup();
    await expect(provider.details(descriptor)).rejects.toMatchObject({
      code: ERROR_CODES.MAPPING_AMBIGUOUS,
      retryable: false,
    });
  });

  it("refuses an asset class Yahoo publishes no detail modules for", async () => {
    const { provider, client: yahooClient } = setup();
    const exotic = verifiedDescriptor({ id: "XNAS:BND", assetClass: "bond" });

    const error = await thrown(() => provider.details(exotic));
    expect(error.code).toBe(ERROR_CODES.UNSUPPORTED_ASSET);
    expect(yahooClient.quoteSummary).not.toHaveBeenCalled();
  });

  it("normalizes an upstream failure", async () => {
    const yahooClient = client({
      quoteSummary: vi.fn(async () => { throw new Error("upstream down"); }),
    });
    const { provider } = setup({ client: yahooClient });
    await expect(provider.details(EQUITY_DESCRIPTOR)).rejects.toMatchObject({
      provider: "yahoo",
      capability: "details",
      instrumentId: "XNAS:AAPL",
    });
  });
});

describe("Yahoo news", () => {
  it("asks for news only, in the region the contract fixes", async () => {
    const { provider, client: yahooClient } = setup();
    await provider.news(descriptorFor("XNAS:AAPL")).catch(() => {});
    expect(yahooClient.search.mock.calls[0][1]).toMatchObject({
      quotesCount: 0,
      region: "US",
      lang: "en-US",
    });
  });

  it("normalizes an upstream failure", async () => {
    const yahooClient = client({ search: vi.fn(async () => { throw new Error("upstream down"); }) });
    const { provider } = setup({ client: yahooClient });
    await expect(provider.news(descriptorFor("XNAS:AAPL"))).rejects.toMatchObject({
      provider: "yahoo",
      capability: "news",
      instrumentId: "XNAS:AAPL",
    });
  });
});
