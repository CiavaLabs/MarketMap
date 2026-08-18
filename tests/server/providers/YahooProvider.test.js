import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { curatedDescriptor as descriptorFor } from "../fixtures/market/curatedDescriptors.js";
import {
  FIXED_NOW,
  YAHOO_AAPL_HISTORY,
  YAHOO_AAPL_PROFILE,
  YAHOO_AAPL_QUOTE,
  YAHOO_SEARCH_RESULTS,
} from "./fixtures/yahoo.js";

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

describe("YahooProvider", () => {
  it("declares capability coverage without claiming a separate fundamentals endpoint", () => {
    const { provider } = setup();
    expect(provider.supports("quote", "equity")).toBe(true);
    expect(provider.supports("history", "crypto")).toBe(true);
    expect(provider.supports("fundamentals", "equity")).toBe(false);
  });

  it("exposes provisional v2 discovery without catalog side effects", async () => {
    const searchPayload = {
      quotes: [
        ...YAHOO_SEARCH_RESULTS.quotes,
        { symbol: "US91282CJL63", quoteType: "BOND", isYahooFinance: true },
        { symbol: "AAPL240119C00100000", quoteType: "OPTION", isYahooFinance: true },
        { symbol: "CASH", quoteType: "MONEY_MARKET", isYahooFinance: true },
      ],
    };
    const { provider, catalog, client: yahooClient } = setup({
      client: client({ search: vi.fn(async () => searchPayload) }),
    });
    const signal = new AbortController().signal;
    const discoveries = await provider.discoverInstruments("pltr", { limit: 20, signal });

    expect(discoveries.map(({ providerSymbol }) => providerSymbol)).toEqual([
      "AAPL",
      "PLTR",
      "US91282CJL63",
    ]);
    expect(discoveries.every(({ mappingStatus }) => mappingStatus === "provisional")).toBe(true);
    expect(catalog.has("XNAS:PLTR")).toBe(false);
    expect(yahooClient.search).toHaveBeenCalledWith(
      "pltr",
      { quotesCount: 20, newsCount: 0 },
      { fetchOptions: { signal } },
    );
  });

  it("hydrates v2 search candidates in one quote batch", async () => {
    const { provider, client: yahooClient } = setup();
    const signal = new AbortController().signal;
    const hydrated = await provider.hydrateQuotes(["AAPL", "AAPL"], { signal });
    expect(hydrated.get("AAPL")).toBe(YAHOO_AAPL_QUOTE);
    expect(yahooClient.quote).toHaveBeenCalledWith(
      ["AAPL"],
      {},
      { fetchOptions: { signal } },
    );
  });

  it("normalizes real OHLCV history and forwards AbortSignal to the provider client", async () => {
    const { provider, client: yahooClient } = setup();
    const signal = new AbortController().signal;
    const history = await provider.history(descriptorFor("XNAS:AAPL"), {
      range: "1d",
      interval: "5m",
      signal,
    });

    expect(history).toMatchObject({
      instrumentId: "XNAS:AAPL",
      range: "1d",
      interval: "5m",
      asOf: "2026-07-13T14:35:00.000Z",
      provenance: expect.objectContaining({ source: "yahoo" }),
    });
    expect(history.bars).toHaveLength(2);
    expect(history.bars[0]).toMatchObject({
      timestamp: "2026-07-13T14:30:00.000Z",
      open: 315.8,
      high: 317.2,
      low: 315.5,
      close: 316.9,
      volume: 1_100_000,
    });
    expect(yahooClient.chart.mock.calls[0][2]).toEqual({ fetchOptions: { signal } });
    expect(yahooClient.chart.mock.calls[0][1]).toMatchObject({ interval: "5m" });
  });

  it("classifies batch rate limits for each requested instrument", async () => {
    const rateLimit = Object.assign(new Error("Too many requests"), { status: 429 });
    const { provider } = setup({
      client: client({ quote: vi.fn(async () => { throw rateLimit; }) }),
    });
    const result = await provider.quoteMany([descriptorFor("XNAS:AAPL"), descriptorFor("XNAS:MSFT")]);

    expect(result.data).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((error) => error.code === ERROR_CODES.RATE_LIMITED)).toBe(true);
    expect(result.errors.map((error) => error.instrumentId)).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });
});
