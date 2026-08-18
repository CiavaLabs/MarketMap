import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_CODE_VALUES,
} from "../../../server/contracts/core/constants.js";
import {
  FALLBACK_DECISION_REASONS,
  FallbackPolicy,
  US_EQUITY_FALLBACK_MICS,
  defaultFallbackPolicy,
} from "../../../server/orchestration/FallbackPolicy.js";
import {
  EQUITY_DESCRIPTOR,
  NON_US_EQUITY_DESCRIPTOR,
} from "../fixtures/market/descriptors.js";

const policy = new FallbackPolicy();

function context(overrides = {}) {
  return {
    fromProvider: "yahoo",
    toProvider: "finnhub",
    operation: "quote",
    assetClass: "equity",
    semanticVariant: "raw_quote",
    instrument: structuredClone(EQUITY_DESCRIPTOR),
    ...overrides,
  };
}

function withFinnhubMapping(instrument, mapping) {
  const copy = structuredClone(instrument);
  copy.providerSymbols.finnhub = mapping;
  return copy;
}

describe("FallbackPolicy provider eligibility", () => {
  it("allows only the initial Yahoo to Finnhub US equity raw-quote cell", () => {
    expect(policy.providerEligibility(context())).toEqual({
      eligible: true,
      reason: FALLBACK_DECISION_REASONS.ELIGIBLE,
      semanticMatch: "raw_quote",
      fallbackSemanticVariant: "raw_quote",
    });
    expect(policy.isProviderEligible(context())).toBe(true);
    expect(policy.semanticMatch(context())).toBe("raw_quote");
  });

  it.each(US_EQUITY_FALLBACK_MICS)("accepts the allowlisted US MIC %s", (mic) => {
    const instrument = structuredClone(EQUITY_DESCRIPTOR);
    instrument.venue.mic = mic;
    expect(policy.isProviderEligible(context({ instrument }))).toBe(true);
  });

  it("denies non-US, missing and non-allowlisted venues", () => {
    const verified = EQUITY_DESCRIPTOR.providerSymbols.finnhub;
    const nonUs = withFinnhubMapping(NON_US_EQUITY_DESCRIPTOR, verified);
    const missingMic = structuredClone(EQUITY_DESCRIPTOR);
    missingMic.venue.mic = null;
    const unknownMic = structuredClone(EQUITY_DESCRIPTOR);
    unknownMic.venue.mic = "IEXG";

    for (const instrument of [nonUs, missingMic, unknownMic]) {
      expect(policy.providerEligibility(context({ instrument }))).toMatchObject({
        eligible: false,
        reason: FALLBACK_DECISION_REASONS.VENUE_NOT_ALLOWLISTED,
        semanticMatch: "raw_quote",
      });
    }
  });

  it("requires an explicit verified Finnhub mapping with a symbol", () => {
    const mappings = [
      undefined,
      "AAPL",
      { symbol: "AAPL", verified: false },
      { symbol: "", verified: true },
    ];

    for (const mapping of mappings) {
      const instrument = structuredClone(EQUITY_DESCRIPTOR);
      if (mapping === undefined) delete instrument.providerSymbols.finnhub;
      else instrument.providerSymbols.finnhub = mapping;
      expect(policy.providerEligibility(context({ instrument }))).toMatchObject({
        eligible: false,
        reason: FALLBACK_DECISION_REASONS.FALLBACK_MAPPING_NOT_VERIFIED,
        semanticMatch: "raw_quote",
      });
    }
  });

  it.each([
    ["reverse provider order", { fromProvider: "finnhub", toProvider: "yahoo" }],
    ["another fallback provider", { toProvider: "polygon" }],
    ["another operation", { operation: "details" }],
    ["another semantic variant", { semanticVariant: "provider_adjusted" }],
  ])("denies by default for %s", (_, overrides) => {
    expect(policy.providerEligibility(context(overrides))).toEqual({
      eligible: false,
      reason: FALLBACK_DECISION_REASONS.POLICY_CELL_NOT_ALLOWED,
      semanticMatch: null,
    });
  });

  it("denies asset-class spoofing and non-equity cells", () => {
    expect(policy.providerEligibility(context({ assetClass: "etf" }))).toEqual({
      eligible: false,
      reason: FALLBACK_DECISION_REASONS.ASSET_CLASS_MISMATCH,
      semanticMatch: null,
    });

    const instrument = structuredClone(EQUITY_DESCRIPTOR);
    instrument.assetClass = "etf";
    expect(policy.providerEligibility(context({ assetClass: "etf", instrument }))).toEqual({
      eligible: false,
      reason: FALLBACK_DECISION_REASONS.POLICY_CELL_NOT_ALLOWED,
      semanticMatch: null,
    });
  });

  it("derives asset class from the instrument when the caller omits it", () => {
    const request = context();
    delete request.assetClass;
    expect(policy.isProviderEligible(request)).toBe(true);
  });

  it("rejects a fallback semantic variant that differs from the approved match", () => {
    const request = context({ fallbackSemanticVariant: "provider_adjusted" });
    expect(policy.providerEligibility(request)).toEqual({
      eligible: false,
      reason: FALLBACK_DECISION_REASONS.SEMANTIC_MISMATCH,
      semanticMatch: null,
    });
    expect(policy.semanticMatch(request)).toBeNull();
  });
});

describe("FallbackPolicy error decisions", () => {
  it.each([
    ERROR_CODES.TIMEOUT,
    ERROR_CODES.RATE_LIMITED,
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    ERROR_CODES.SCHEMA_INVALID,
  ])("allows fallback after %s", (errorCode) => {
    expect(policy.errorDecision(context({ errorCode }))).toEqual({
      allowed: true,
      reason: FALLBACK_DECISION_REASONS.ERROR_ALLOWS_FALLBACK,
      errorCode,
    });
  });

  it("accepts a structured provider error", () => {
    expect(policy.errorDecision(context({
      error: { code: ERROR_CODES.TIMEOUT },
    }))).toMatchObject({ allowed: true, errorCode: ERROR_CODES.TIMEOUT });
  });

  it("allows instrument_not_found only with a verified fallback mapping", () => {
    expect(policy.errorDecision(context({
      errorCode: ERROR_CODES.INSTRUMENT_NOT_FOUND,
    }))).toMatchObject({
      allowed: true,
      reason: FALLBACK_DECISION_REASONS.ERROR_ALLOWS_FALLBACK,
    });

    const instrument = structuredClone(EQUITY_DESCRIPTOR);
    instrument.providerSymbols.finnhub.verified = false;
    expect(policy.errorDecision(context({
      errorCode: ERROR_CODES.INSTRUMENT_NOT_FOUND,
      instrument,
    }))).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.FALLBACK_MAPPING_NOT_VERIFIED,
      errorCode: ERROR_CODES.INSTRUMENT_NOT_FOUND,
    });
  });

  it("denies every other known error code by default", () => {
    const permitted = new Set([
      ERROR_CODES.TIMEOUT,
      ERROR_CODES.RATE_LIMITED,
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      ERROR_CODES.SCHEMA_INVALID,
      ERROR_CODES.INSTRUMENT_NOT_FOUND,
    ]);
    for (const errorCode of ERROR_CODE_VALUES.filter((code) => !permitted.has(code))) {
      expect(policy.errorDecision(context({ errorCode }))).toEqual({
        allowed: false,
        reason: FALLBACK_DECISION_REASONS.ERROR_CODE_NOT_ALLOWED,
        errorCode,
      });
    }
  });

  it("denies missing and unknown error codes", () => {
    expect(policy.errorDecision(context())).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.ERROR_CODE_MISSING,
      errorCode: null,
    });
    expect(policy.errorDecision(context({ errorCode: "new_provider_error" }))).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.ERROR_CODE_NOT_ALLOWED,
      errorCode: "new_provider_error",
    });
  });
});

describe("FallbackPolicy final decision", () => {
  it("combines provider, mapping, semantics and error eligibility", () => {
    const request = context({ errorCode: ERROR_CODES.TIMEOUT });
    expect(policy.fallbackDecision(request)).toEqual({
      allowed: true,
      reason: FALLBACK_DECISION_REASONS.FALLBACK_ALLOWED,
      semanticMatch: "raw_quote",
      fallbackSemanticVariant: "raw_quote",
      errorCode: ERROR_CODES.TIMEOUT,
    });
    expect(policy.shouldFallback(request)).toBe(true);
    expect(defaultFallbackPolicy.shouldFallback(request)).toBe(true);
  });

  it("does not fallback for an otherwise eligible cell after a denied error", () => {
    expect(policy.fallbackDecision(context({
      errorCode: ERROR_CODES.INVALID_REQUEST,
    }))).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.ERROR_CODE_NOT_ALLOWED,
      errorCode: ERROR_CODES.INVALID_REQUEST,
      semanticMatch: "raw_quote",
    });
  });

  it("does not fallback after a transient error when provider eligibility fails", () => {
    const instrument = structuredClone(EQUITY_DESCRIPTOR);
    instrument.providerSymbols.finnhub.verified = false;
    expect(policy.fallbackDecision(context({
      instrument,
      errorCode: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    }))).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.FALLBACK_MAPPING_NOT_VERIFIED,
      semanticMatch: "raw_quote",
      errorCode: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("never substitutes Finnhub raw history for Yahoo provider-adjusted history", () => {
    const request = context({
      operation: "history",
      semanticVariant: "provider_adjusted",
      fallbackSemanticVariant: "raw",
      errorCode: ERROR_CODES.TIMEOUT,
    });
    expect(policy.semanticMatch(request)).toBeNull();
    expect(policy.fallbackDecision(request)).toEqual({
      allowed: false,
      reason: FALLBACK_DECISION_REASONS.POLICY_CELL_NOT_ALLOWED,
      semanticMatch: null,
      errorCode: ERROR_CODES.TIMEOUT,
    });
  });

  it("refuses to fall back for an instrument the provider has delisted", () => {
    const policy = new FallbackPolicy();
    const context = {
      fromProvider: "yahoo",
      toProvider: "finnhub",
      operation: "quote",
      assetClass: "equity",
      semanticVariant: "raw_quote",
      instrument: structuredClone(EQUITY_DESCRIPTOR),
    };

    const ordinary = policy.errorDecision({ ...context, errorCode: ERROR_CODES.INSTRUMENT_NOT_FOUND });
    const delisted = policy.errorDecision({
      ...context,
      error: {
        code: ERROR_CODES.INSTRUMENT_NOT_FOUND,
        details: { reason: "provider_delisted" },
      },
    });

    expect(ordinary.allowed).toBe(true);
    expect(delisted.allowed).toBe(false);
  });
});
