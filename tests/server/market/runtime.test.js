import { describe, expect, it, vi } from "vitest";
import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { InMemorySnapshotStore } from "../../../server/cache/InMemorySnapshotStore.js";
import { marketCacheKey } from "../../../server/contracts/market/constants.js";

const BASE = "https://marketmap.test/api/market/v1";
const NOW = Date.parse("2026-07-16T20:00:00.000Z");

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
    {
      date: new Date("2026-07-15T20:00:00.000Z"),
      open: 196,
      high: 199,
      low: 195,
      close: 198,
      adjclose: 197.5,
      volume: 800,
    },
    {
      date: new Date("2026-07-16T20:00:00.000Z"),
      open: 199,
      high: 201,
      low: 197,
      close: 200,
      adjclose: 199.5,
      volume: 1_000,
    },
  ],
  events: {
    dividends: [{
      date: new Date("2026-07-16T13:30:00.000Z"),
      amount: 0.25,
      currency: "USD",
    }],
  },
});

function fakeYahooClient() {
  return {
    quote: vi.fn(async (symbols) => symbols.includes("AAPL") ? [{ ...AAPL }] : []),
    chart: vi.fn(async () => structuredClone(CHART)),
    search: vi.fn(async () => ({ quotes: [], news: [] })),
    quoteSummary: vi.fn(async () => ({})),
  };
}

function service(options = {}) {
  const yahooClient = options.yahooClient || fakeYahooClient();
  return {
    yahooClient,
    market: createMarketDataService({
      yahooClient,
      finnhubApiKey: "",
      enabledAssetClasses: ["equity"],
      clock: () => NOW,
      logLevel: "silent",
      ...options,
    }),
  };
}

async function json(response) {
  return { response, body: await response.json() };
}

describe("runtime market API v1", () => {
  it("serves validated quotes with item-local errors and semantic metadata", async () => {
    const { market, yahooClient } = service();
    const first = await json(await market.handleRequest(new Request(
      `${BASE}/snapshot?ids=XNAS:AAPL,XNAS:MSFT`,
    )));
    expect(first.response.status).toBe(200);
    expect(first.body.data).toEqual([expect.objectContaining({
      instrumentId: "XNAS:AAPL",
      value: 200,
      price: 200,
      priceUnit: "currency",
      session: expect.objectContaining({ model: "exchange_hours", phase: "regular" }),
      provenance: expect.objectContaining({ source: "yahoo", fallback: false }),
    })]);
    expect(first.body.errors).toEqual([expect.objectContaining({
      instrumentId: "XNAS:MSFT",
      operation: "quote",
      code: "instrument_not_found",
    })]);
    expect(first.body.meta).toMatchObject({
      apiVersion: "v1",
      schemaVersion: 2,
      semanticRevision: "market-data@1",
      descriptorRevision: 1,
    });

    const second = await market.handleRequest(new Request(`${BASE}/snapshot?ids=XNAS:AAPL`));
    expect(second.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    await market.close();
  });

  it("keeps raw and provider-adjusted history in distinct cache variants and preserves events", async () => {
    const { market, yahooClient } = service();
    const raw = await json(await market.handleRequest(new Request(
      `${BASE}/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=raw`,
    )));
    const adjusted = await json(await market.handleRequest(new Request(
      `${BASE}/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=provider_adjusted`,
    )));
    expect(raw.body.data.priceBasis).toBe("raw");
    expect(raw.body.data.bars[0]).toMatchObject({ displayClose: 198 });
    expect(adjusted.body.data.priceBasis).toBe("provider_adjusted");
    expect(adjusted.body.data.bars[0]).toMatchObject({ displayClose: 197.5 });
    expect(adjusted.body.data.events).toEqual([
      expect.objectContaining({ type: "dividend", amount: 0.25 }),
    ]);
    expect(yahooClient.chart).toHaveBeenCalledTimes(2);

    await market.handleRequest(new Request(
      `${BASE}/instruments/XNAS:AAPL/history?range=1y&interval=1d&priceBasis=provider_adjusted`,
    ));
    expect(yahooClient.chart).toHaveBeenCalledTimes(2);
    await market.close();
  });

  it("rejects a schema-v1 record in the v2 cache namespace", async () => {
    const snapshotStore = new InMemorySnapshotStore({ clock: () => NOW });
    const key = marketCacheKey("quote", "XNAS:AAPL", "observation");
    await snapshotStore.set({
      cacheKey: key,
      instrumentId: "XNAS:AAPL",
      resourceType: "v2_quote",
      provider: "yahoo",
      payload: { instrumentId: "XNAS:AAPL", price: 1 },
      sourceAsOf: new Date(NOW),
      fetchedAt: new Date(NOW),
      freshUntil: new Date(NOW + 30_000),
      staleUntil: new Date(NOW + 60_000),
      schemaVersion: 1,
      payloadHash: "invalid",
      lastSuccessAt: new Date(NOW),
    });
    const { market, yahooClient } = service({ snapshotStore });
    const response = await market.handleRequest(new Request(`${BASE}/snapshot?ids=XNAS:AAPL`));
    expect(response.status).toBe(200);
    expect(yahooClient.quote).toHaveBeenCalledTimes(1);
    expect((await snapshotStore.get(key)).schemaVersion).toBe(2);
    await market.close();
  });
});
