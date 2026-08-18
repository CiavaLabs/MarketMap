import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import {
  ProviderAdapter,
  normalizeProviderError,
} from "../../../server/providers/ProviderAdapter.js";

describe("ProviderAdapter", () => {
  it("exposes immutable-by-copy capability metadata and asset coverage", () => {
    const provider = new ProviderAdapter({
      id: "fixture",
      capabilities: {
        quote: { assetClasses: ["equity"] },
        search: true,
        news: { assetClasses: ["equity", "etf"] },
      },
    });
    const first = provider.capabilities();
    first.quote.assetClasses.push("crypto");

    expect(provider.supports("quote", "equity")).toBe(true);
    expect(provider.supports("quote", "crypto")).toBe(false);
    expect(provider.supports("search", "crypto")).toBe(true);
    expect(provider.supports("news", "equity")).toBe(true);
    expect(provider.supports("news", "bond")).toBe(false);
    expect(provider.capabilities().quote.assetClasses).toEqual(["equity"]);
  });

  it("throws a typed non-retryable unsupported-asset error", () => {
    const provider = new ProviderAdapter({
      id: "fixture",
      capabilities: { quote: ["equity"] },
    });
    expect(() => provider.assertCapability("quote", "bond", "BOND:US123")).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.UNSUPPORTED_ASSET,
        provider: "fixture",
        capability: "quote",
        instrumentId: "BOND:US123",
        retryable: false,
      }),
    );
  });

  it("normalizes upstream status and abort errors into the shared taxonomy", () => {
    const rateLimit = normalizeProviderError(Object.assign(new Error("Too many requests"), { status: 429 }), {
      provider: "fixture",
      capability: "quote",
      instrumentId: "XNAS:AAPL",
    });
    const abort = normalizeProviderError(new DOMException("aborted", "AbortError"), {
      provider: "fixture",
      capability: "history",
    });

    expect(rateLimit).toMatchObject({
      code: ERROR_CODES.RATE_LIMITED,
      provider: "fixture",
      instrumentId: "XNAS:AAPL",
      retryable: true,
    });
    expect(abort).toMatchObject({ code: ERROR_CODES.TIMEOUT, capability: "history" });
  });

  it("keeps untrusted upstream messages in the internal cause only", () => {
    const secret = "provider-secret";
    const cause = new Error(`request failed https://provider.test/quote?token=${secret}`);
    const error = normalizeProviderError(cause, {
      provider: "fixture",
      capability: "quote",
      instrumentId: "XNAS:AAPL",
    });

    expect(error.message).toBe("fixture request failed");
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toProblem())).not.toContain(secret);
    expect(JSON.stringify(error.toProblem())).not.toContain("https://provider.test");
  });
});
