import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import { normalizeFinnhubNews } from "../../../server/providers/finnhub/normalizers.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { normalizeYahooNews } from "../../../server/providers/yahoo/normalizers.js";
import { FINNHUB_AAPL_NEWS } from "./fixtures/finnhub.js";
import { FIXED_NOW, YAHOO_AAPL_NEWS } from "./fixtures/yahoo.js";
import { descriptorFromLegacyInstrument } from "../../../server/instruments/descriptorFactory.js";
import { curatedDescriptor as descriptorFor, CURATED_VERIFIED_AT as NEWS_VERIFIED_AT } from "../fixtures/market/curatedDescriptors.js";


function response(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: vi.fn(async () => payload),
  };
}

describe("Yahoo news provider", () => {
  it("requests provider news exactly, forwards abort, and emits only the normalized contract", async () => {
    const search = vi.fn(async () => YAHOO_AAPL_NEWS);
    const catalog = new InstrumentCatalog();
    const provider = new YahooProvider({
      client: { search },
      catalog,
      clock: () => FIXED_NOW,
    });
    const signal = new AbortController().signal;
    const result = await provider.news(descriptorFor("XNAS:AAPL"), {
      signal,
      resolveProviderSymbol: (symbol) => (symbol === "MSFT" ? "XNAS:MSFT" : null),
    });

    expect(provider.supports("news", "equity")).toBe(true);
    expect(search).toHaveBeenCalledWith("AAPL", {
      quotesCount: 0,
      newsCount: 8,
      region: "US",
      lang: "en-US",
    }, { fetchOptions: { signal } });
    expect(result).toMatchObject({
      instrumentId: "XNAS:AAPL",
      source: "yahoo",
      quality: "fresh",
      asOf: "2026-07-13T19:30:00.000Z",
      fetchedAt: "2026-07-13T20:00:00.000Z",
    });
    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]).toEqual({
      id: "yahoo:aapl-launch",
      title: "Apple & partners launch new platform",
      publisher: "Reuters",
      url: "https://news.example.test/apple-launch?edition=us",
      publishedAt: "2026-07-13T19:30:00.000Z",
      instrumentIds: ["XNAS:AAPL", "XNAS:MSFT"],
      provider: "yahoo",
    });
    expect(result.articles.every((article) => !("thumbnail" in article) && !("summary" in article))).toBe(true);
  });

  it("accepts an empty result but rejects a malformed provider envelope", async () => {
    const catalog = new InstrumentCatalog();
    const instrument = catalog.resolve("XNAS:AAPL");
    expect(normalizeYahooNews({ news: [] }, { instrument, catalog, clock: () => FIXED_NOW }))
      .toMatchObject({ articles: [], asOf: "2026-07-13T20:00:00.000Z" });
    expect(() => normalizeYahooNews({ quotes: [] }, { instrument, catalog, clock: () => FIXED_NOW }))
      .toThrowError(expect.objectContaining({
        code: ERROR_CODES.SCHEMA_INVALID,
        provider: "yahoo",
        capability: "news",
      }));
  });

  it("normalizes aborts as provider timeouts", async () => {
    const provider = new YahooProvider({
      client: { search: vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }) },
      clock: () => FIXED_NOW,
    });
    await expect(provider.news(descriptorFor("XNAS:AAPL"))).rejects.toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      provider: "yahoo",
      capability: "news",
    });
  });
});

describe("Finnhub news provider", () => {
  it("disables news without a key and performs no request", async () => {
    const fetch = vi.fn();
    const provider = new FinnhubProvider({ apiKey: "", fetch });
    expect(provider.supports("news", "equity")).toBe(false);
    await expect(provider.news(descriptorFor("XNAS:AAPL"))).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
      provider: "finnhub",
      capability: "news",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the inclusive UTC company-news window and strips provider-only fields", async () => {
    const fetch = vi.fn(async () => response(FINNHUB_AAPL_NEWS));
    const provider = new FinnhubProvider({
      apiKey: "server-only-secret",
      fetch,
      clock: () => FIXED_NOW,
    });
    const signal = new AbortController().signal;
    const result = await provider.news(descriptorFor("XNAS:AAPL"), { signal });
    const [url, requestOptions] = fetch.mock.calls[0];

    expect(url.pathname).toBe("/api/v1/company-news");
    expect(url.searchParams.get("symbol")).toBe("AAPL");
    expect(url.searchParams.get("from")).toBe("2026-07-06");
    expect(url.searchParams.get("to")).toBe("2026-07-13");
    expect(url.searchParams.get("token")).toBe("server-only-secret");
    expect(requestOptions.signal).toBe(signal);
    expect(result).toMatchObject({
      instrumentId: "XNAS:AAPL",
      source: "finnhub",
      quality: "fresh",
      asOf: "2026-07-13T19:45:00.000Z",
    });
    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]).toEqual({
      id: "finnhub:9001",
      title: "Apple & suppliers report growth",
      publisher: "Reuters",
      url: "https://news.example.test/apple-growth",
      publishedAt: "2026-07-13T19:45:00.000Z",
      instrumentIds: ["XNAS:AAPL"],
      provider: "finnhub",
    });
    expect(result.articles.every((article) => !("image" in article) && !("summary" in article))).toBe(true);
  });

  it("rejects unsupported listings locally without consuming the API", async () => {
    const catalog = new InstrumentCatalog({ instruments: [{
      id: "XLON:VOD",
      symbol: "VOD",
      name: "Vodafone Group Plc",
      assetClass: "equity",
      exchange: "London Stock Exchange",
      mic: "XLON",
      currency: "GBP",
      country: "GB",
      status: "active",
      providerSymbols: { finnhub: "VOD.L" },
    }] });
    const fetch = vi.fn();
    const provider = new FinnhubProvider({ apiKey: "secret", fetch, catalog, clock: () => FIXED_NOW });

    const vodafone = descriptorFromLegacyInstrument(catalog.resolve("XLON:VOD"), {
      verifiedAt: NEWS_VERIFIED_AT,
    });

    await expect(provider.news(vodafone)).rejects.toMatchObject({
      code: ERROR_CODES.UNSUPPORTED_ASSET,
      provider: "finnhub",
      capability: "news",
      instrumentId: "XLON:VOD",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an empty array and classifies malformed payloads as schema drift", () => {
    const instrument = new InstrumentCatalog().resolve("XNAS:AAPL");
    expect(normalizeFinnhubNews([], { instrument, clock: () => FIXED_NOW }))
      .toMatchObject({ articles: [], asOf: "2026-07-13T20:00:00.000Z" });
    expect(() => normalizeFinnhubNews({ news: [] }, { instrument, clock: () => FIXED_NOW }))
      .toThrowError(expect.objectContaining({
        code: ERROR_CODES.SCHEMA_INVALID,
        provider: "finnhub",
        capability: "news",
      }));
  });

  it.each([
    [401, ERROR_CODES.AUTH_FAILED],
    [403, ERROR_CODES.ENTITLEMENT_MISSING],
    [429, ERROR_CODES.RATE_LIMITED],
  ])("maps company-news HTTP %i into %s", async (status, code) => {
    const provider = new FinnhubProvider({
      apiKey: "secret",
      fetch: vi.fn(async () => response({ error: "provider failure" }, { status })),
      clock: () => FIXED_NOW,
    });
    await expect(provider.news(descriptorFor("XNAS:AAPL"))).rejects.toMatchObject({
      code,
      provider: "finnhub",
      capability: "news",
      instrumentId: "XNAS:AAPL",
    });
  });

  it("normalizes company-news transport aborts as timeouts", async () => {
    const provider = new FinnhubProvider({
      apiKey: "secret",
      fetch: vi.fn(async () => { throw new DOMException("timed out", "AbortError"); }),
      clock: () => FIXED_NOW,
    });
    await expect(provider.news(descriptorFor("XNAS:AAPL"))).rejects.toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      provider: "finnhub",
      capability: "news",
    });
  });

  it("never exposes tokenized transport URLs in public Finnhub errors", async () => {
    const secret = "server-only-secret";
    const provider = new FinnhubProvider({
      apiKey: secret,
      fetch: vi.fn(async () => {
        throw new Error(`fetch failed https://finnhub.io/api/v1/company-news?token=${secret}`);
      }),
      clock: () => FIXED_NOW,
    });

    const error = await provider.news(descriptorFor("XNAS:AAPL")).catch((reason) => reason);
    const problem = JSON.stringify(error.toProblem());
    const consoleRepresentation = inspect(error, { depth: null });
    expect(error).toMatchObject({
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      message: "Finnhub upstream request failed",
      provider: "finnhub",
      capability: "news",
    });
    expect(error.cause).toBeUndefined();
    for (const publicValue of [
      error.message,
      String(error.cause),
      problem,
      consoleRepresentation,
    ]) {
      expect(publicValue).not.toContain(secret);
      expect(publicValue).not.toContain("token=");
      expect(publicValue).not.toContain("https://finnhub.io");
    }
  });
});
