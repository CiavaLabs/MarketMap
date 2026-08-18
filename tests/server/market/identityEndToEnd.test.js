import { describe, expect, it } from "vitest";
import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { InMemoryInstrumentCatalogStore } from "../../../server/instruments/InstrumentCatalogStore.js";

const BASE = "https://marketmap.test";

const PLTR_QUOTE = {
  symbol: "PLTR",
  quoteType: "EQUITY",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  currency: "USD",
  longName: "Palantir Technologies Inc.",
  regularMarketPrice: 161.2,
  regularMarketPreviousClose: 158.4,
  regularMarketOpen: 159.0,
  regularMarketDayHigh: 162.4,
  regularMarketDayLow: 158.1,
  regularMarketVolume: 44_120_000,
  averageDailyVolume3Month: 61_400_000,
  marketState: "REGULAR",
  regularMarketTime: new Date("2026-07-16T19:59:00.000Z"),
};

const ASML_QUOTE = {
  ...PLTR_QUOTE,
  symbol: "ASML.AS",
  exchange: "AMS",
  fullExchangeName: "Euronext Amsterdam",
  currency: "EUR",
  longName: "ASML Holding N.V.",
  regularMarketPrice: 690.1,
};

function fakeYahooClient() {
  return {
    search: async () => ({
      quotes: [{
        symbol: "PLTR",
        isYahooFinance: true,
        quoteType: "EQUITY",
        exchange: "NMS",
        exchDisp: "NASDAQ",
        shortname: "Palantir Technologies Inc.",
        score: 95,
        index: "quotes",
      }],
      news: [],
    }),
    quote: async (symbols) => symbols
      .map((symbol) => ({ PLTR: PLTR_QUOTE, "ASML.AS": ASML_QUOTE }[symbol]))
      .filter(Boolean)
      .map((quote) => ({ ...quote })),
    chart: async () => ({ quotes: [], meta: {} }),
    quoteSummary: async () => ({}),
  };
}

function buildService(store) {
  return createMarketDataService({
    yahooClient: fakeYahooClient(),
    finnhubApiKey: "",
    instrumentCatalogStore: store,
    logLevel: "silent",
  });
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

describe("search → add → restart → reload", () => {
  it("keeps a dynamically discovered instrument working across restarts with a store", async () => {
    const store = new InMemoryInstrumentCatalogStore();
    const first = buildService(store);

    const search = await json(await first.handleRequest(
      new Request(`${BASE}/api/market/v1/instruments/search?q=palantir`),
    ));
    expect(search.status).toBe(200);
    const row = search.body.data.find((entry) => entry.instrument?.id === "XNAS:PLTR");
    expect(row).toBeDefined();
    expect(row.addable).toBe(true);
    expect(row.instrument.providerSymbols.yahoo.verified).toBe(true);

    const add = await json(await first.handleRequest(
      new Request(`${BASE}/api/market/v1/instruments/XNAS:PLTR`),
    ));
    expect(add.status).toBe(200);
    expect(add.body.data.addable).toBe(true);
    expect(add.body.data.capabilities.quote.status).toBe("supported");
    await first.close();

    const second = buildService(store);
    const snapshot = await json(await second.handleRequest(
      new Request(`${BASE}/api/market/v1/snapshot?ids=XNAS:PLTR`),
    ));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.errors).toBeUndefined();
    expect(snapshot.body.data).toHaveLength(1);
    expect(snapshot.body.data[0]).toMatchObject({
      instrumentId: "XNAS:PLTR",
      price: 161.2,
      provenance: { source: "yahoo" },
    });
    await second.close();
  });

  it("cold-resolves the same board without any persistent store", async () => {
    const service = buildService(null);
    const snapshot = await json(await service.handleRequest(
      new Request(`${BASE}/api/market/v1/snapshot?ids=XNAS:PLTR`),
    ));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data[0]?.instrumentId).toBe("XNAS:PLTR");

    const descriptor = await json(await service.handleRequest(
      new Request(`${BASE}/api/market/v1/instruments/XNAS:PLTR`),
    ));
    expect(descriptor.status).toBe(200);
    expect(descriptor.body.data.instrument.mappingStatus).toBe("resolved");
    await service.close();
  });

  it("cold-resolves a non-US board after restart without a persisted hint", async () => {
    const service = buildService(null);
    const snapshot = await json(await service.handleRequest(
      new Request(`${BASE}/api/market/v1/snapshot?ids=XAMS:ASML`),
    ));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.errors).toBeUndefined();
    expect(snapshot.body.data[0]).toMatchObject({
      instrumentId: "XAMS:ASML",
      price: 690.1,
      currency: "EUR",
      provenance: { source: "yahoo" },
    });
    const descriptor = await json(await service.handleRequest(
      new Request(`${BASE}/api/market/v1/instruments/XAMS:ASML`),
    ));
    expect(descriptor.body.data.instrument.providerSymbols.yahoo.symbol).toBe("ASML.AS");
    await service.close();
  });

  it("returns a 404 problem for an identity no provider can reproduce", async () => {
    const service = buildService(null);
    const missing = await json(await service.handleRequest(
      new Request(`${BASE}/api/market/v1/instruments/XNAS:NOPE`),
    ));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("instrument_not_found");
    await service.close();
  });
});
