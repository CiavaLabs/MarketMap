import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import {
  FINNHUB_AAPL_FUNDAMENTALS,
  FINNHUB_AAPL_HISTORY,
  FINNHUB_AAPL_NEWS,
  FINNHUB_AAPL_PROFILE,
  FINNHUB_AAPL_QUOTE,
  FINNHUB_SEARCH_RESULTS,
} from "./fixtures/finnhub.js";
import { FIXED_NOW } from "./fixtures/yahoo.js";
import { curatedDescriptor as descriptorFor } from "../fixtures/market/curatedDescriptors.js";


function response(payload, { status = 200, headers = {}, json } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), `${value}`]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders[name.toLowerCase()] ?? null },
    json: json || (async () => payload),
  };
}

const ROUTES = Object.freeze({
  "/quote": FINNHUB_AAPL_QUOTE,
  "/search": FINNHUB_SEARCH_RESULTS,
  "/stock/candle": FINNHUB_AAPL_HISTORY,
  "/forex/candle": FINNHUB_AAPL_HISTORY,
  "/crypto/candle": FINNHUB_AAPL_HISTORY,
  "/stock/profile2": FINNHUB_AAPL_PROFILE,
  "/stock/metric": FINNHUB_AAPL_FUNDAMENTALS,
  "/company-news": FINNHUB_AAPL_NEWS,
});

function routeFetch(overrides = {}) {
  return vi.fn(async (url) => {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const handler = overrides[path];
    if (handler) {
      const value = await handler(url);
      return value?.ok !== undefined ? value : response(value);
    }
    if (!(path in ROUTES)) return response({ error: "not found" }, { status: 404 });
    return response(ROUTES[path]);
  });
}

function provider({ fetch = routeFetch(), apiKey = "test-secret", ...rest } = {}) {
  return new FinnhubProvider({
    apiKey,
    fetch,
    clock: () => FIXED_NOW,
    ...rest,
  });
}

const thrown = (run) => run().then(() => null, (error) => error);

describe("FinnhubProvider construction", () => {
  it("requires a fetch implementation", () => {
    expect(() => new FinnhubProvider({ apiKey: "k", fetch: null }))
      .toThrowError(/requires a fetch implementation/u);
  });

  it.each([
    ["a zero concurrency", 0, 5],
    ["a negative concurrency", -3, 1],
    ["an over-large concurrency", 99, 10],
    ["an unreadable concurrency", "many", 5],
  ])("clamps %s", (_label, maxConcurrency, expected) => {
    expect(provider({ maxConcurrency }).maxConcurrency).toBe(expected);
  });

  it("trims the API key and the base URL", () => {
    const built = provider({ apiKey: "  secret  ", baseUrl: "https://finnhub.test/api/v1///" });
    expect(built.apiKey).toBe("secret");
    expect(built.baseUrl).toBe("https://finnhub.test/api/v1");
  });

  it.each([
    ["quote", (p) => p.quoteMany([descriptorFor("XNAS:AAPL")])],
    ["news", (p) => p.news(descriptorFor("XNAS:AAPL"))],
  ])("refuses %s without a configured key", async (_label, call) => {
    const fetch = routeFetch();
    const error = await thrown(() => call(provider({ apiKey: "", fetch })));
    expect(error.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(error.retryable).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Finnhub company-news eligibility", () => {
  const catalog = new InstrumentCatalog();

  it("covers a North American equity", () => {
    const built = provider();
    expect(built.supportsInstrument("news", descriptorFor("XNAS:AAPL"))).toBe(true);
  });

  it.each([
    ["an ETF", { ...catalog.resolve("SPY") }],
    ["an equity on an unlisted venue", {
      ...catalog.resolve("AAPL"),
      mic: "XLON",
      country: "GB",
    }],
  ])("does not cover %s", (_label, instrument) => {
    expect(provider().supportsInstrument("news", instrument)).toBe(false);
  });

  it("declines an equity whose venue is not a North American news venue", () => {
    const built = provider();
    const descriptor = descriptorFor("XNAS:AAPL");
    const elsewhere = { ...descriptor, venue: { ...descriptor.venue, mic: "XXXX" } };
    expect(built.supportsInstrument("news", elsewhere)).toBe(false);
  });

  it("still answers other capabilities normally", () => {
    expect(provider().supportsInstrument("quote", descriptorFor("XNAS:AAPL"))).toBe(true);
  });
});

describe("Finnhub news", () => {
  it("returns a normalized news feed", async () => {
    const result = await provider().news(descriptorFor("XNAS:AAPL"));
    expect(result.instrumentId).toBe("XNAS:AAPL");
    expect(result.source).toBe("finnhub");
  });

  it("refuses news for an instrument the provider does not cover", async () => {
    const fetch = routeFetch();
    const catalog = new InstrumentCatalog();
    const error = await thrown(() => provider({ fetch, catalog }).news(catalog.resolve("SPY")));
    expect(error).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Finnhub transport failures", () => {
  const quoteFails = (handler) => provider({ fetch: routeFetch({ "/quote": handler }) });

  it("sanitizes a transport error rather than leaking it", async () => {
    const built = quoteFails(() => { throw new Error("ECONNREFUSED 10.0.0.1:443"); });
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);

    expect(result.data).toEqual([]);
    expect(result.errors[0].message).toBe("Finnhub upstream request failed");
    expect(result.errors[0].message).not.toContain("10.0.0.1");
  });

  it("reports a caller abort as an abort, not an upstream failure", async () => {
    const controller = new AbortController();
    const built = provider({
      fetch: vi.fn(async (_url, { signal }) => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw Object.assign(error, { signal });
      }),
    });

    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")], { signal: controller.signal });
    expect(result.errors[0].details?.reason || result.errors[0].code).toBeDefined();
  });

  it("rejects a fetch that does not return a response object", async () => {
    const built = provider({ fetch: vi.fn(async () => ({ notAResponse: true })) });
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(result.errors[0].code).toBe(ERROR_CODES.SCHEMA_INVALID);
  });

  it.each([
    ["401", 401, ERROR_CODES.AUTH_FAILED],
    ["403", 403, ERROR_CODES.ENTITLEMENT_MISSING],
    ["404", 404, ERROR_CODES.INSTRUMENT_NOT_FOUND],
    ["429", 429, ERROR_CODES.RATE_LIMITED],
    ["500", 500, ERROR_CODES.UPSTREAM_UNAVAILABLE],
  ])("classifies HTTP %s", async (_label, status, code) => {
    const built = quoteFails(() => response({}, { status }));
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(result.errors[0].code).toBe(code);
  });

  it.each([
    ["a numeric retry-after", "30", { retryAfterSeconds: 30 }],
    ["an unreadable retry-after", "soon", null],
    ["no retry-after", null, null],
  ])("carries %s", async (_label, header, expected) => {
    const built = quoteFails(() => response({}, {
      status: 429,
      ...(header === null ? {} : { headers: { "retry-after": header } }),
    }));
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(result.errors[0].details).toEqual(expected);
  });

  it("rejects a body that is not JSON", async () => {
    const built = quoteFails(() => response(null, {
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    }));
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(result.errors[0].code).toBe(ERROR_CODES.SCHEMA_INVALID);
  });

  it.each([
    ["an API key complaint", "Invalid API key", ERROR_CODES.AUTH_FAILED, false],
    ["an authentication complaint", "authentication required", ERROR_CODES.AUTH_FAILED, false],
    ["a premium endpoint", "Premium endpoint", ERROR_CODES.ENTITLEMENT_MISSING, false],
    ["an entitlement complaint", "missing entitlement", ERROR_CODES.ENTITLEMENT_MISSING, false],
    ["an access complaint", "no access", ERROR_CODES.ENTITLEMENT_MISSING, false],
    ["a not-found complaint", "symbol not found", ERROR_CODES.INSTRUMENT_NOT_FOUND, false],
    ["a no-data complaint", "no data", ERROR_CODES.INSTRUMENT_NOT_FOUND, false],
    ["a rate limit", "API limit reached", ERROR_CODES.RATE_LIMITED, true],
    ["an unrecognised complaint", "something odd", ERROR_CODES.UPSTREAM_UNAVAILABLE, true],
  ])("classifies %s in a 200 body", async (_label, message, code, retryable) => {
    const built = quoteFails(() => response({ error: message }));
    const result = await built.quoteMany([descriptorFor("XNAS:AAPL")]);
    expect(result.errors[0]).toMatchObject({ code, retryable });
  });
});

describe("Finnhub quote batches", () => {
  it("rejects a non-array request", async () => {
    await expect(provider().quoteMany("XNAS:AAPL")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
    });
  });

  it("answers an empty request without touching the network", async () => {
    const fetch = routeFetch();
    expect(await provider({ fetch }).quoteMany([])).toEqual({ data: [], errors: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an unresolvable instrument item-local", async () => {
    const result = await provider().quoteMany([descriptorFor("XNAS:AAPL"), descriptorFor("INDEX:^GSPC")]);
    expect(result.data).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it("reports an asset class outside its quote coverage", async () => {
    const fetch = routeFetch();
    const catalog = new InstrumentCatalog();
    const built = provider({ fetch, catalog });

    const result = await built.quoteMany([descriptorFor("FUTURE:CMX.GC.CONTINUOUS.1")]);

    expect(result.data).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
