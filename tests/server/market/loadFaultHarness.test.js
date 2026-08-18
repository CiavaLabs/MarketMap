import { describe, expect, it } from "vitest";

import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { MarketDataError } from "../../../server/errors/MarketDataError.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { descriptorFromLegacyInstrument } from "../../../server/instruments/descriptorFactory.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { BatchRequestPlanner } from "../../../src/api/BatchRequestPlanner.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const API_BASE = "https://marketmap.test/api/market/v1";

function syntheticInstrument(index) {
  const symbol = `T${String(index).padStart(3, "0")}`;
  return {
    id: `XNAS:${symbol}`,
    symbol,
    name: `Synthetic ${symbol}`,
    assetClass: "equity",
    exchange: "NasdaqGS",
    mic: "XNAS",
    currency: "USD",
    country: "US",
    status: "active",
    providerSymbols: { yahoo: symbol },
  };
}

function rawEquityQuote(symbol, overrides = {}) {
  return {
    symbol,
    quoteType: "EQUITY",
    exchange: "NMS",
    fullExchangeName: "NasdaqGS",
    currency: "USD",
    regularMarketPrice: 100,
    regularMarketPreviousClose: 99,
    regularMarketOpen: 99.5,
    regularMarketDayHigh: 101,
    regularMarketDayLow: 98.5,
    regularMarketVolume: 1_000,
    averageDailyVolume3Month: 900,
    regularMarketTime: new Date(NOW),
    marketState: "REGULAR",
    exchangeTimezoneName: "America/New_York",
    ...overrides,
  };
}

function syntheticYahooClient() {
  const quoteCalls = [];
  return {
    quoteCalls,
    quote: async (symbols) => {
      quoteCalls.push([...symbols]);
      return symbols.map((symbol) => rawEquityQuote(symbol));
    },
    chart: async () => { throw new Error("history is outside this harness"); },
    quoteSummary: async () => { throw new Error("details are outside this harness"); },
    search: async () => ({ quotes: [], news: [] }),
  };
}

async function requestSnapshot(market, chunk) {
  const ids = encodeURIComponent(chunk.join(","));
  const response = await market.handleRequest(new Request(`${API_BASE}/snapshot?ids=${ids}`));
  if (!response.ok) throw new Error(`Synthetic v2 request failed with ${response.status}`);
  return response.json();
}

describe("v2 deterministic load and fault harness", () => {
  it("serves a 60-instrument board as 40 + 20 and makes the warm pass provider-free", async () => {
    const instruments = Array.from({ length: 60 }, (_, index) => syntheticInstrument(index));
    const ids = instruments.map(({ id }) => id);
    const catalog = new InstrumentCatalog({ instruments });
    const yahooClient = syntheticYahooClient();
    const market = createMarketDataService({
      catalog,
      yahooClient,
      finnhubApiKey: "",
      enabledAssetClasses: ["equity"],
      clock: () => NOW,
      logLevel: "silent",
    });
    const planner = new BatchRequestPlanner({ chunkSize: 40, concurrency: 2 });

    try {
      const cold = await planner.execute(ids, (chunk) => requestSnapshot(market, chunk));
      expect(cold.map(({ items }) => items.length)).toEqual([40, 20]);
      expect(cold.every(({ status }) => status === "fulfilled")).toBe(true);
      expect(cold.flatMap(({ value }) => value.data)).toHaveLength(60);
      expect(yahooClient.quoteCalls).toHaveLength(2);
      expect(Math.max(...yahooClient.quoteCalls.map((symbols) => symbols.length))).toBe(40);

      const warm = await planner.execute(ids, (chunk) => requestSnapshot(market, chunk));
      expect(warm.flatMap(({ value }) => value.data)).toHaveLength(60);
      expect(yahooClient.quoteCalls).toHaveLength(2);
    } finally {
      await market.close();
    }
  });

  it("isolates a timed-out 20-item chunk and preserves the successful 40-item chunk", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `XNAS:T${String(index).padStart(3, "0")}`);
    const planner = new BatchRequestPlanner({ chunkSize: 40, concurrency: 2 });
    const timeout = new MarketDataError(ERROR_CODES.TIMEOUT, "synthetic chunk timeout", {
      capability: "quote",
      retryable: true,
    });

    const outcomes = await planner.execute(ids, async (chunk, { chunkIndex }) => {
      if (chunkIndex === 1) throw timeout;
      return { data: chunk.map((instrumentId) => ({ instrumentId })), errors: [] };
    });

    expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(outcomes[0].value.data).toHaveLength(40);
    expect(outcomes[1]).toMatchObject({
      items: ids.slice(40),
      reason: { code: ERROR_CODES.TIMEOUT, retryable: true },
    });
  });

  it("classifies a synthetic Finnhub 429 and preserves Retry-After without live transport", async () => {
    const catalog = new InstrumentCatalog();
    const descriptor = descriptorFromLegacyInstrument(catalog.resolve("XNAS:AAPL"), {
      verifiedAt: new Date(NOW).toISOString(),
    });
    let calls = 0;
    const provider = new FinnhubProvider({
      apiKey: "synthetic-key",
      catalog,
      clock: () => NOW,
      fetch: async () => {
        calls += 1;
        return new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        });
      },
    });

    const result = await provider.quoteMany([descriptor]);

    expect(calls).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({
      code: ERROR_CODES.RATE_LIMITED,
      retryable: true,
      details: { retryAfterSeconds: 7 },
    })]);
  });

  it("contains Yahoo schema drift to the affected asset class", async () => {
    const catalog = new InstrumentCatalog();
    const verifiedAt = new Date(NOW).toISOString();
    const equity = descriptorFromLegacyInstrument(catalog.resolve("XNAS:AAPL"), { verifiedAt });
    const index = descriptorFromLegacyInstrument(catalog.resolve("INDEX:^GSPC"), { verifiedAt });
    const client = {
      quote: async (symbols) => symbols.map((symbol) => (
        symbol === "AAPL"
          ? rawEquityQuote(symbol)
          : rawEquityQuote(symbol, {
              quoteType: "EQUITY",
              exchange: "SNP",
              fullExchangeName: "S&P Dow Jones Indices",
            })
      )),
      chart: async () => ({}),
      quoteSummary: async () => ({}),
      search: async () => ({ quotes: [], news: [] }),
    };
    const provider = new YahooProvider({ client, catalog, clock: () => NOW });

    const result = await provider.quoteMany([equity, index]);

    expect(result.data.map(({ instrumentId }) => instrumentId)).toEqual(["XNAS:AAPL"]);
    expect(result.errors).toEqual([expect.objectContaining({
      code: ERROR_CODES.SCHEMA_INVALID,
      instrumentId: "INDEX:^GSPC",
      provider: "yahoo",
    })]);
  });
});
