import { describe, expect, it } from "vitest";

import {
  assertSanitizedReport,
  compareWithBaseline,
  sanitizeFailure,
  shapeMetadata,
  summarizeQuote,
} from "../../../scripts/probe-market-providers.mjs";

describe("provider canary sanitization", () => {
  it("fingerprints raw key/type shape without retaining primitive values", () => {
    const metadata = shapeMetadata({
      regularMarketPrice: 987654.321,
      token: "provider-secret",
      nested: { url: "https://provider.invalid/quote?token=provider-secret" },
      rows: [{ timestamp: 1_700_000_000, close: 999999.125 }],
    });
    const serialized = JSON.stringify(metadata);

    expect(metadata.paths).toContain("$.regularMarketPrice:number");
    expect(metadata.paths).toContain("$.<redacted-key>:string");
    expect(metadata.sensitiveKeysRedacted).toBe(1);
    expect(serialized).not.toMatch(/987654|999999|provider-secret|provider\.invalid|token=/u);
  });

  it("summarizes normalized quotes without serializing observations or provider symbols", () => {
    const summary = summarizeQuote({
      instrumentId: "XNAS:AAPL",
      value: 888888.75,
      price: 888888.75,
      regularMarketPrice: 888888.75,
      quality: "fresh",
      fieldAvailability: {
        change: { status: "available" },
        bid: { status: "temporarily_unavailable" },
      },
      dataQuality: { status: "usable", issues: [] },
      provenance: {
        source: "yahoo",
        providerSymbol: "CANARY-SYMBOL-SHOULD-NOT-BE-A-VALUE",
        fallback: false,
      },
      asOf: "2026-07-16T19:59:00.000Z",
      fetchedAt: "2026-07-16T20:00:00.000Z",
    }, Date.parse("2026-07-16T20:00:00.000Z"));
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      contract: "QuoteSnapshot",
      quality: "fresh",
      availability: { available: 1, temporarily_unavailable: 1 },
      timestamps: { asOf: "valid", fetchedAt: "valid" },
    });
    expect(serialized).not.toMatch(/888888|CANARY-SYMBOL-SHOULD-NOT-BE-A-VALUE/u);
  });

  it("does not propagate arbitrary error text, URLs, stacks, or details", () => {
    const error = Object.assign(new Error("https://provider.invalid/?token=leaked-secret"), {
      code: "unexpected_code",
      stack: "token=stack-secret",
      details: { token: "detail-secret" },
    });

    expect(sanitizeFailure(error)).toEqual({
      code: "canary_probe_failed",
      retryable: false,
    });
  });

  it("compares only sanitized shape hashes and rejects secret-bearing reports", () => {
    const baseline = {
      probes: [{
        provider: "yahoo",
        operation: "quote",
        instrumentId: "XNAS:AAPL",
        rawShapes: [{ transport: "quote", keySetHash: "old" }],
      }],
    };
    const report = compareWithBaseline({
      probes: [{
        provider: "yahoo",
        operation: "quote",
        instrumentId: "XNAS:AAPL",
        rawShapes: [{ transport: "quote", keySetHash: "new" }],
      }],
    }, baseline);

    expect(report.probes[0].schemaDiff).toEqual({
      state: "changed",
      changedTransports: ["quote"],
    });
    expect(() => assertSanitizedReport({ token: "token=secret" }, ["secret"]))
      .toThrowError("Canary report contains a URL or token query");
  });
});
