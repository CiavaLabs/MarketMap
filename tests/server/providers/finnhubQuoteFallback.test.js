import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "../../../server/providers/finnhub/capabilityManifest.js";
import {
  EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  NON_US_EQUITY_DESCRIPTOR,
} from "../fixtures/market/descriptors.js";
import {
  FINNHUB_AAPL_QUOTE,
  FINNHUB_AUTH_ERROR,
  FINNHUB_ENTITLEMENT_ERROR,
  FINNHUB_NO_DATA_QUOTE,
  FINNHUB_UPSTREAM_ERROR,
} from "./fixtures/finnhub.js";
import { FIXED_NOW } from "./fixtures/yahoo.js";

function response(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: vi.fn(async () => payload),
  };
}

function equityDescriptor(symbol, mapping = {}) {
  return {
    ...EQUITY_DESCRIPTOR,
    id: `XNAS:${symbol}`,
    displaySymbol: symbol,
    symbol,
    name: `${symbol} Inc.`,
    providerSymbols: {
      yahoo: { ...EQUITY_DESCRIPTOR.providerSymbols.yahoo, symbol },
      finnhub: {
        ...EQUITY_DESCRIPTOR.providerSymbols.finnhub,
        symbol,
        ...mapping,
      },
    },
  };
}

function provider(fetch, { apiKey = "test-secret", maxConcurrency = 2 } = {}) {
  return new FinnhubProvider({
    apiKey,
    fetch,
    clock: () => FIXED_NOW,
    maxConcurrency,
  });
}

describe("FinnhubProvider quoteMany", () => {
  it("keeps success, no-data and upstream failures item-local with fallback provenance", async () => {
    const fetch = vi.fn(async (url) => {
      const symbol = url.searchParams.get("symbol");
      if (symbol === "AAPL") return response(FINNHUB_AAPL_QUOTE);
      if (symbol === "MSFT") return response(FINNHUB_NO_DATA_QUOTE);
      return response(FINNHUB_UPSTREAM_ERROR);
    });
    const descriptors = [
      equityDescriptor("AAPL"),
      equityDescriptor("MSFT"),
      equityDescriptor("GOOGL"),
    ];
    const result = await provider(fetch).quoteMany(descriptors, {
      fallbackContextById: new Map([["XNAS:AAPL", {
        fromProvider: "yahoo",
        errorCode: ERROR_CODES.TIMEOUT,
        semanticMatch: "raw_quote",
      }]]),
    });

    expect(result.data).toEqual([expect.objectContaining({
      instrumentId: "XNAS:AAPL",
      assetClass: "equity",
      value: 317.31,
      price: 317.31,
      priceUnit: "currency",
      quality: "fresh",
      provenance: {
        source: "finnhub",
        providerSymbol: "AAPL",
        fallback: true,
        fallbackFrom: "yahoo",
        fallbackReason: ERROR_CODES.TIMEOUT,
        semanticMatch: "raw_quote",
      },
    })]);
    expect(result.data[0].dataQuality).toEqual({
      status: "usable_with_warnings",
      issues: [{ code: "fallback_provider_used", severity: "info", field: null }],
    });
    expect(result.data[0]).not.toHaveProperty("raw");
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
        instrumentId: "XNAS:MSFT",
        provider: "finnhub",
      }),
      expect.objectContaining({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        instrumentId: "XNAS:GOOGL",
        provider: "finnhub",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sanitizes untrusted fallback context before it reaches public provenance", async () => {
    const fetch = vi.fn(async () => response(FINNHUB_AAPL_QUOTE));
    const result = await provider(fetch).quoteMany([equityDescriptor("AAPL")], {
      fallbackContextById: {
        "XNAS:AAPL": {
          fromProvider: "https://primary.invalid/?token=source-secret",
          errorCode: "https://finnhub.io/quote?token=reason-secret",
          semanticMatch: "raw quote token=semantic-secret",
        },
      },
    });

    expect(result.data[0].provenance).toMatchObject({
      fallbackFrom: "yahoo",
      fallbackReason: "upstream_unavailable",
      semanticMatch: "raw_quote",
    });
    expect(JSON.stringify(result)).not.toMatch(/source-secret|reason-secret|semantic-secret|finnhub\.io/);
  });

  it("uses only verified mappings for allowlisted US equity venues", async () => {
    const fetch = vi.fn(async () => response(FINNHUB_AAPL_QUOTE));
    const unverified = equityDescriptor("MSFT", { verified: false });
    const unsafeMapping = equityDescriptor("GOOGL", { symbol: "GOOGL?token=do-not-use" });
    const nonUs = {
      ...NON_US_EQUITY_DESCRIPTOR,
      providerSymbols: {
        ...NON_US_EQUITY_DESCRIPTOR.providerSymbols,
        finnhub: {
          symbol: "ASML",
          verified: true,
          verifiedAt: "2026-07-16T12:00:00.000Z",
          providerType: "Common Stock",
        },
      },
    };
    const etf = {
      ...ETF_DESCRIPTOR,
      providerSymbols: {
        ...ETF_DESCRIPTOR.providerSymbols,
        finnhub: {
          symbol: "SPY",
          verified: true,
          verifiedAt: "2026-07-16T12:00:00.000Z",
          providerType: "ETP",
        },
      },
    };

    const result = await provider(fetch).quoteMany([
      equityDescriptor("AAPL"),
      unverified,
      unsafeMapping,
      nonUs,
      etf,
    ]);

    expect(result.data.map((quote) => quote.instrumentId)).toEqual(["XNAS:AAPL"]);
    expect(result.errors.map(({ code, instrumentId }) => ({ code, instrumentId }))).toEqual([
      { code: ERROR_CODES.MAPPING_AMBIGUOUS, instrumentId: "XNAS:MSFT" },
      { code: ERROR_CODES.MAPPING_AMBIGUOUS, instrumentId: "XNAS:GOOGL" },
      { code: ERROR_CODES.UNSUPPORTED_ASSET, instrumentId: "XAMS:ASML" },
      { code: ERROR_CODES.UNSUPPORTED_ASSET, instrumentId: "ARCX:SPY" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].searchParams.get("symbol")).toBe("AAPL");
    expect(JSON.stringify(result)).not.toContain("do-not-use");
  });

  it("classifies upstream auth and entitlement responses without exposing their payloads", async () => {
    const fetch = vi.fn(async (url) => response(
      url.searchParams.get("symbol") === "AAPL"
        ? FINNHUB_AUTH_ERROR
        : FINNHUB_ENTITLEMENT_ERROR,
    ));
    const result = await provider(fetch).quoteMany([
      equityDescriptor("AAPL"),
      equityDescriptor("MSFT"),
    ]);

    expect(result.data).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: ERROR_CODES.AUTH_FAILED,
        instrumentId: "XNAS:AAPL",
        retryable: false,
      }),
      expect.objectContaining({
        code: ERROR_CODES.ENTITLEMENT_MISSING,
        instrumentId: "XNAS:MSFT",
        retryable: false,
      }),
    ]);
    const publicErrors = result.errors.map((error) => error.toProblem());
    expect(JSON.stringify(publicErrors)).not.toContain(FINNHUB_AUTH_ERROR.error);
    expect(JSON.stringify(publicErrors)).not.toContain(FINNHUB_ENTITLEMENT_ERROR.error);
  });

  it("fails globally before transport when the server-side API key is absent", async () => {
    const fetch = vi.fn(async () => response(FINNHUB_AAPL_QUOTE));
    await expect(provider(fetch, { apiKey: "" }).quoteMany([
      equityDescriptor("AAPL"),
    ])).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
      provider: "finnhub",
      capability: "quote",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds v2 quote fan-out and preserves descriptor order", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return response(FINNHUB_AAPL_QUOTE);
    });
    const descriptors = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"]
      .map((symbol) => equityDescriptor(symbol));
    const result = await provider(fetch, { maxConcurrency: 2 }).quoteMany(descriptors);

    expect(peak).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.data.map((quote) => quote.instrumentId)).toEqual(
      descriptors.map((descriptor) => descriptor.id),
    );
  });

  it("fans AbortSignal into transport, stops new calls and sanitizes abort reasons", async () => {
    const fetch = vi.fn(async (_url, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = provider(fetch, { maxConcurrency: 1 }).quoteMany([
      equityDescriptor("AAPL"),
      equityDescriptor("MSFT"),
    ], { signal: controller.signal });
    expect(fetch).toHaveBeenCalledOnce();

    controller.abort(new Error("https://finnhub.io/api/v1/quote?token=abort-secret"));
    const result = await pending;

    expect(fetch).toHaveBeenCalledOnce();
    expect(result.data).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: ERROR_CODES.TIMEOUT, instrumentId: "XNAS:AAPL" }),
      expect.objectContaining({ code: ERROR_CODES.TIMEOUT, instrumentId: "XNAS:MSFT" }),
    ]);
    const serialized = JSON.stringify(result.errors.map((error) => error.toProblem()));
    expect(serialized).not.toContain("abort-secret");
    expect(serialized).not.toContain("finnhub.io");
  });

  it("does not advertise the unimplemented details-market cell", () => {
    expect(FINNHUB_CAPABILITY_MANIFEST.assets.equity.details).toEqual({
      support: "unsupported",
    });
    expect(Object.getOwnPropertyDescriptor(FinnhubProvider.prototype, "details")).toBeUndefined();
  });
});
