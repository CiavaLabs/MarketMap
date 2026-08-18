import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import { curatedDescriptor as descriptorFor } from "../fixtures/market/curatedDescriptors.js";
import {
  FINNHUB_AAPL_FUNDAMENTALS,
  FINNHUB_AAPL_HISTORY,
  FINNHUB_AAPL_PROFILE,
  FINNHUB_AAPL_QUOTE,
  FINNHUB_SEARCH_RESULTS,
} from "./fixtures/finnhub.js";
import { FIXED_NOW } from "./fixtures/yahoo.js";

function response(payload, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), `${value}`]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders[name.toLowerCase()] || null },
    json: vi.fn(async () => payload),
  };
}

function routeFetch(overrides = {}) {
  return vi.fn(async (url) => {
    const handlers = {
      "/quote": () => FINNHUB_AAPL_QUOTE,
      "/search": () => FINNHUB_SEARCH_RESULTS,
      "/stock/candle": () => FINNHUB_AAPL_HISTORY,
      "/stock/profile2": () => FINNHUB_AAPL_PROFILE,
      "/stock/metric": () => FINNHUB_AAPL_FUNDAMENTALS,
      ...overrides,
    };
    const handler = handlers[url.pathname.replace(/^\/api\/v1/, "")];
    if (!handler) return response({ error: "not found" }, { status: 404 });
    const value = await handler(url);
    return value?.ok !== undefined ? value : response(value);
  });
}

function setup({ fetch = routeFetch(), maxConcurrency } = {}) {
  return {
    fetch,
    provider: new FinnhubProvider({
      apiKey: "test-secret",
      fetch,
      clock: () => FIXED_NOW,
      maxConcurrency,
    }),
  };
}

describe("FinnhubProvider", () => {
  it("disables optional capabilities and fails safely when no key is configured", async () => {
    const provider = new FinnhubProvider({ fetch: routeFetch() });
    expect(provider.supports("quote", "equity")).toBe(false);
    await expect(provider.quoteMany([descriptorFor("XNAS:AAPL")])).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
      provider: "finnhub",
      capability: "quote",
      retryable: false,
    });
  });

  it("normalizes quote requests and retains per-item no-data errors", async () => {
    const fetch = routeFetch({
      "/quote": (url) => url.searchParams.get("symbol") === "MSFT"
        ? { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }
        : FINNHUB_AAPL_QUOTE,
    });
    const { provider } = setup({ fetch });
    const result = await provider.quoteMany([descriptorFor("XNAS:AAPL"), descriptorFor("XNAS:MSFT")]);

    expect(result.data).toEqual([expect.objectContaining({
      instrumentId: "XNAS:AAPL",
      price: 317.31,
      changePercent: 0.6311,
      fetchedAt: "2026-07-13T20:00:00.000Z",
      provenance: expect.objectContaining({ source: "finnhub" }),
    })]);
    expect(result.errors).toEqual([expect.objectContaining({
      code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
      instrumentId: "XNAS:MSFT",
      provider: "finnhub",
    })]);
    const firstUrl = fetch.mock.calls[0][0];
    expect(firstUrl.pathname).toBe("/api/v1/quote");
    expect(firstUrl.searchParams.get("token")).toBe("test-secret");
  });

  it("bounds quote fan-out with an ordered worker pool", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return response(FINNHUB_AAPL_QUOTE);
    });
    const { provider } = setup({ fetch, maxConcurrency: 2 });
    const ids = ["XNAS:AAPL", "XNAS:MSFT", "XNAS:GOOGL", "XNAS:AMZN", "XNAS:TSLA"];
    const result = await provider.quoteMany(ids.map(descriptorFor));

    expect(fetch).toHaveBeenCalledTimes(ids.length);
    expect(peak).toBe(2);
    expect(result.data.map((item) => item.instrumentId)).toEqual(ids);
  });

  it("classifies HTTP rate limits without leaking the token in the error", async () => {
    const fetch = routeFetch({
      "/quote": () => response({ error: "limit" }, {
        status: 429,
        headers: { "retry-after": "12" },
      }),
    });
    const { provider } = setup({ fetch });
    const limited = await provider.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(limited.errors[0]).toMatchObject({
      code: ERROR_CODES.RATE_LIMITED,
      provider: "finnhub",
      capability: "quote",
      details: { retryAfterSeconds: 12 },
    });
    expect(limited.errors[0].message).not.toContain("test-secret");
  });

  it("treats successful non-JSON responses as schema drift", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      json: async () => { throw new SyntaxError("Unexpected token '<'"); },
    }));
    const { provider } = setup({ fetch });
    const drifted = await provider.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(drifted.errors[0]).toMatchObject({
      code: ERROR_CODES.SCHEMA_INVALID,
      provider: "finnhub",
      capability: "quote",
    });
  });

  it("does not synthesize Retry-After zero when Finnhub omits the header", async () => {
    const fetch = routeFetch({
      "/quote": () => response({ error: "limit" }, { status: 429 }),
    });
    const { provider } = setup({ fetch });
    const limited = await provider.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(limited.errors[0]).toMatchObject({ code: ERROR_CODES.RATE_LIMITED, details: null });
  });

});
