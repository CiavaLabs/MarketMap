import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { createMarketDataService } from "../../../server/createMarketDataService.js";
import { RAW_QUOTE_SPY } from "../fixtures/market/rawYahoo.js";
import { FINNHUB_AAPL_QUOTE } from "../providers/fixtures/finnhub.js";
import { YAHOO_AAPL_HISTORY, YAHOO_AAPL_QUOTE } from "../providers/fixtures/yahoo.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");

function upstream(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function yahooClient({ quotes = {}, chart } = {}) {
  return {
    quote: vi.fn(async (symbols) => (symbols || [])
      .map((symbol) => quotes[symbol])
      .filter(Boolean)
      .map((quote) => structuredClone(quote))),
    chart: vi.fn(chart || (async () => { throw new Error("chart unavailable"); })),
    search: vi.fn(async () => ({ quotes: [], news: [] })),
    quoteSummary: vi.fn(async () => ({})),
  };
}

function service({
  client,
  fetch,
  enabledAssetClasses = ["equity"],
  breakerOptions,
  clock = () => NOW,
  ttlPolicy,
} = {}) {
  return createMarketDataService({
    yahooClient: client || yahooClient(),
    finnhubApiKey: "server-only-test-key",
    fetch: fetch || vi.fn(async () => upstream(FINNHUB_AAPL_QUOTE)),
    enabledAssetClasses,
    breakerOptions,
    clock,
    ttlPolicy,
    logLevel: "silent",
  });
}

describe("v2 selective fallback integration", () => {
  it("does not call Finnhub when Yahoo succeeds", async () => {
    const fetch = vi.fn(async () => upstream(FINNHUB_AAPL_QUOTE));
    const client = yahooClient({ quotes: { AAPL: YAHOO_AAPL_QUOTE } });
    const market = service({ client, fetch });

    const result = await market.getSnapshot(["XNAS:AAPL"]);

    expect(result.data[0].provenance).toMatchObject({ source: "yahoo", fallback: false });
    expect(fetch).not.toHaveBeenCalled();
    await market.close();
  });

  it("falls back only for an eligible US equity and caches fallback provenance", async () => {
    const fetch = vi.fn(async () => upstream(FINNHUB_AAPL_QUOTE));
    const client = yahooClient();
    const market = service({ client, fetch });

    const first = await market.getSnapshot(["XNAS:AAPL"]);
    const second = await market.getSnapshot(["XNAS:AAPL"]);

    expect(first.errors).toEqual([]);
    expect(first.data[0]).toMatchObject({
      instrumentId: "XNAS:AAPL",
      provenance: {
        source: "finnhub",
        fallback: true,
        fallbackFrom: "yahoo",
        fallbackReason: ERROR_CODES.INSTRUMENT_NOT_FOUND,
        semanticMatch: "raw_quote",
      },
    });
    expect(second.data[0].provenance).toEqual(first.data[0].provenance);
    expect(client.quote).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await market.close();
  });

  it("replays a cached fallback as stale without erasing its provenance chain", async () => {
    let now = NOW;
    let finnhubAvailable = true;
    const fetch = vi.fn(async () => finnhubAvailable
      ? upstream(FINNHUB_AAPL_QUOTE)
      : upstream({ error: "temporarily unavailable" }, 503));
    const market = service({
      fetch,
      clock: () => now,
      ttlPolicy: { quote: { freshMs: 1, staleMs: 60_000 } },
    });

    const fresh = await market.getSnapshot(["XNAS:AAPL"]);
    finnhubAvailable = false;
    now += 2;
    const stale = await market.getSnapshot(["XNAS:AAPL"]);

    expect(fresh.data[0].provenance.source).toBe("finnhub");
    expect(stale.errors).toEqual([]);
    expect(stale.data[0]).toMatchObject({
      quality: "stale",
      provenance: {
        source: "finnhub",
        originalSource: "finnhub",
        fallback: true,
        fallbackFrom: "yahoo",
        semanticMatch: "raw_quote",
      },
      dataQuality: {
        status: "usable_with_warnings",
        issues: expect.arrayContaining([
          { code: "stale_last_known_good", severity: "warning", field: null },
        ]),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await market.close();
  });

  it("does not use the equity fallback cell for an ETF", async () => {
    const fetch = vi.fn(async () => upstream(FINNHUB_AAPL_QUOTE));
    const market = service({ fetch, enabledAssetClasses: ["etf"] });

    const result = await market.getSnapshot(["ARCX:SPY"]);

    expect(result.data).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
      provider: "yahoo",
    });
    expect(fetch).not.toHaveBeenCalled();
    await market.close();
  });

  it("never replaces failed Yahoo provider-adjusted history with a raw Finnhub quote", async () => {
    const fetch = vi.fn(async () => upstream(FINNHUB_AAPL_QUOTE));
    const client = yahooClient({
      quotes: { SPY: RAW_QUOTE_SPY },
      chart: async () => { throw new Error("adjusted chart unavailable"); },
    });
    const market = service({ client, fetch, enabledAssetClasses: ["etf"] });

    await expect(market.getHistory("ARCX:SPY", {
      range: "1y",
      interval: "1d",
      priceBasis: "provider_adjusted",
    })).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    expect(fetch).not.toHaveBeenCalled();
    await market.close();
  });

  it("does not let an empty 1D session open the raw-history circuit and block 5D", async () => {
    const chart = vi.fn()
      .mockResolvedValueOnce({
        meta: {
          symbol: "AAPL",
          instrumentType: "EQUITY",
          currency: "USD",
          exchangeTimezoneName: "America/New_York",
        },
        quotes: [],
      })
      .mockResolvedValueOnce(structuredClone(YAHOO_AAPL_HISTORY));
    const market = service({
      client: yahooClient({ chart }),
      breakerOptions: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    await expect(market.getHistory("XNAS:AAPL", {
      range: "1d",
      interval: "5m",
      priceBasis: "raw",
    })).rejects.toMatchObject({
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      details: { reason: "empty_history" },
    });
    expect(market.getHealth().circuits["yahoo:history:equity:raw"]).toMatchObject({
      state: "closed",
      failureCount: 0,
    });

    const fiveDays = await market.getHistory("XNAS:AAPL", {
      range: "5d",
      interval: "15m",
      priceBasis: "raw",
    });
    expect(fiveDays.data.bars).toHaveLength(YAHOO_AAPL_HISTORY.quotes.length);
    expect(chart).toHaveBeenCalledTimes(2);
    await market.close();
  });

  it.each([
    [401, ERROR_CODES.AUTH_FAILED, "*:*:*"],
    [403, ERROR_CODES.ENTITLEMENT_MISSING, "quote:equity:*"],
  ])("exposes scoped quarantine for Finnhub HTTP %s", async (status, code, scope) => {
    const fetch = vi.fn(async () => upstream({ error: "provider denied request" }, status));
    const market = service({ fetch });

    const result = await market.getSnapshot(["XNAS:AAPL"]);
    const health = market.getHealth();

    expect(result.errors[0]).toMatchObject({ code: ERROR_CODES.INSTRUMENT_NOT_FOUND, provider: "yahoo" });
    expect(health.providers.finnhub.quarantinedCapabilities[scope]).toMatchObject({
      code,
      scope: `finnhub:${scope}`,
    });
    await market.close();
  });

  it("opens an ETF quote breaker without disabling equity quotes", async () => {
    const malformedSpy = { ...RAW_QUOTE_SPY, quoteType: "EQUITY" };
    const client = yahooClient({
      quotes: { SPY: malformedSpy, AAPL: YAHOO_AAPL_QUOTE },
    });
    const market = service({
      client,
      enabledAssetClasses: ["equity", "etf"],
      breakerOptions: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    const etf = await market.getSnapshot(["ARCX:SPY"]);
    const equity = await market.getSnapshot(["XNAS:AAPL"]);
    const health = market.getHealth();

    expect(etf.errors[0].code).toBe(ERROR_CODES.SCHEMA_INVALID);
    expect(equity.data[0]).toMatchObject({ instrumentId: "XNAS:AAPL", value: 317.31 });
    expect(health.circuits["yahoo:quote:etf:raw_quote"].state).toBe("open");
    expect(health.circuits["yahoo:quote:equity:raw_quote"].state).toBe("closed");
    await market.close();
  });
});
