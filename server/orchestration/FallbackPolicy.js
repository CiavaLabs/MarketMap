import { ERROR_CODES } from "../contracts/core/constants.js";

export const US_EQUITY_FALLBACK_MICS = Object.freeze([
  "ARCX",
  "BATS",
  "XASE",
  "XNAS",
  "XNYS",
]);

export const FALLBACK_DECISION_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  FALLBACK_ALLOWED: "fallback_allowed",
  ERROR_ALLOWS_FALLBACK: "error_allows_fallback",
  POLICY_CELL_NOT_ALLOWED: "policy_cell_not_allowed",
  ASSET_CLASS_MISMATCH: "asset_class_mismatch",
  SEMANTIC_MISMATCH: "semantic_mismatch",
  VENUE_NOT_ALLOWLISTED: "venue_not_allowlisted",
  FALLBACK_MAPPING_NOT_VERIFIED: "fallback_mapping_not_verified",
  ERROR_CODE_MISSING: "error_code_missing",
  ERROR_CODE_NOT_ALLOWED: "error_code_not_allowed",
  INSTRUMENT_DELISTED: "instrument_delisted",
});

const INITIAL_POLICY_CELLS = Object.freeze([
  Object.freeze({
    fromProvider: "yahoo",
    toProvider: "finnhub",
    operation: "quote",
    assetClass: "equity",
    semanticVariant: "raw_quote",
    fallbackSemanticVariant: "raw_quote",
    semanticMatch: "raw_quote",
    allowedMics: US_EQUITY_FALLBACK_MICS,
    requiresVerifiedMapping: true,
  }),
]);

const UNCONDITIONAL_FALLBACK_ERROR_CODES = new Set([
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.UPSTREAM_UNAVAILABLE,
  ERROR_CODES.SCHEMA_INVALID,
]);

function normalizedText(value) {
  return `${value ?? ""}`.trim().toLowerCase();
}

function normalizedProvider(value) {
  return normalizedText(value && typeof value === "object" ? value.id : value);
}

function normalizedMic(value) {
  return `${value ?? ""}`.trim().toUpperCase();
}

function policyKey({
  fromProvider,
  toProvider,
  operation,
  assetClass,
  semanticVariant,
}) {
  return [fromProvider, toProvider, operation, assetClass, semanticVariant].join(":");
}

const POLICY_CELLS_BY_KEY = new Map(INITIAL_POLICY_CELLS.map((cell) => [
  policyKey(cell),
  cell,
]));

function normalizedContext(context = {}) {
  const instrumentAssetClass = normalizedText(context.instrument?.assetClass);
  const requestedAssetClass = normalizedText(context.assetClass);
  return {
    fromProvider: normalizedProvider(context.fromProvider),
    toProvider: normalizedProvider(context.toProvider),
    operation: normalizedText(context.operation),
    assetClass: requestedAssetClass || instrumentAssetClass,
    semanticVariant: normalizedText(context.semanticVariant),
    fallbackSemanticVariant: normalizedText(context.fallbackSemanticVariant),
    assetClassMismatch: Boolean(
      requestedAssetClass
      && instrumentAssetClass
      && requestedAssetClass !== instrumentAssetClass
    ),
  };
}

function verifiedMappingFor(instrument, provider) {
  const mapping = instrument?.providerSymbols?.[provider];
  return Boolean(
    mapping
    && typeof mapping === "object"
    && !Array.isArray(mapping)
    && mapping.verified === true
    && `${mapping.symbol ?? ""}`.trim()
  );
}

function fallbackErrorCode(context = {}) {
  return normalizedText(context.errorCode || context.error?.code);
}

function providerDenial(reason, semanticMatch = null) {
  return { eligible: false, reason, semanticMatch };
}

function errorDenial(reason, errorCode) {
  return { allowed: false, reason, errorCode: errorCode || null };
}

export class FallbackPolicy {
  #cellFor(context) {
    const normalized = normalizedContext(context);
    return {
      normalized,
      cell: POLICY_CELLS_BY_KEY.get(policyKey(normalized)) || null,
    };
  }

  semanticMatch(context = {}) {
    const { normalized, cell } = this.#cellFor(context);
    if (!cell || normalized.assetClassMismatch) return null;
    if (normalized.fallbackSemanticVariant
      && normalized.fallbackSemanticVariant !== cell.fallbackSemanticVariant) {
      return null;
    }
    return cell.semanticMatch;
  }

  providerEligibility(context = {}) {
    const { normalized, cell } = this.#cellFor(context);
    if (normalized.assetClassMismatch) {
      return providerDenial(FALLBACK_DECISION_REASONS.ASSET_CLASS_MISMATCH);
    }
    if (!cell) {
      return providerDenial(FALLBACK_DECISION_REASONS.POLICY_CELL_NOT_ALLOWED);
    }
    if (normalized.fallbackSemanticVariant
      && normalized.fallbackSemanticVariant !== cell.fallbackSemanticVariant) {
      return providerDenial(FALLBACK_DECISION_REASONS.SEMANTIC_MISMATCH);
    }

    const semanticMatch = cell.semanticMatch;
    const mic = normalizedMic(context.instrument?.venue?.mic || context.instrument?.mic);
    if (cell.allowedMics && !cell.allowedMics.includes(mic)) {
      return providerDenial(FALLBACK_DECISION_REASONS.VENUE_NOT_ALLOWLISTED, semanticMatch);
    }
    if (cell.requiresVerifiedMapping
      && !verifiedMappingFor(context.instrument, normalized.toProvider)) {
      return providerDenial(
        FALLBACK_DECISION_REASONS.FALLBACK_MAPPING_NOT_VERIFIED,
        semanticMatch,
      );
    }
    return {
      eligible: true,
      reason: FALLBACK_DECISION_REASONS.ELIGIBLE,
      semanticMatch,
      fallbackSemanticVariant: cell.fallbackSemanticVariant,
    };
  }

  isProviderEligible(context = {}) {
    return this.providerEligibility(context).eligible;
  }

  errorDecision(context = {}) {
    const errorCode = fallbackErrorCode(context);
    if (!errorCode) {
      return errorDenial(FALLBACK_DECISION_REASONS.ERROR_CODE_MISSING, errorCode);
    }
    if (UNCONDITIONAL_FALLBACK_ERROR_CODES.has(errorCode)) {
      return {
        allowed: true,
        reason: FALLBACK_DECISION_REASONS.ERROR_ALLOWS_FALLBACK,
        errorCode,
      };
    }
    if (errorCode === ERROR_CODES.INSTRUMENT_NOT_FOUND) {
      if (normalizedText(context.error?.details?.reason) === "provider_delisted") {
        return errorDenial(FALLBACK_DECISION_REASONS.INSTRUMENT_DELISTED, errorCode);
      }
      const provider = normalizedProvider(context.toProvider);
      if (verifiedMappingFor(context.instrument, provider)) {
        return {
          allowed: true,
          reason: FALLBACK_DECISION_REASONS.ERROR_ALLOWS_FALLBACK,
          errorCode,
        };
      }
      return errorDenial(
        FALLBACK_DECISION_REASONS.FALLBACK_MAPPING_NOT_VERIFIED,
        errorCode,
      );
    }
    return errorDenial(FALLBACK_DECISION_REASONS.ERROR_CODE_NOT_ALLOWED, errorCode);
  }

  fallbackDecision(context = {}) {
    const provider = this.providerEligibility(context);
    if (!provider.eligible) {
      return {
        allowed: false,
        reason: provider.reason,
        semanticMatch: provider.semanticMatch,
        errorCode: fallbackErrorCode(context) || null,
      };
    }

    const error = this.errorDecision(context);
    if (!error.allowed) {
      return {
        ...error,
        semanticMatch: provider.semanticMatch,
      };
    }
    return {
      allowed: true,
      reason: FALLBACK_DECISION_REASONS.FALLBACK_ALLOWED,
      semanticMatch: provider.semanticMatch,
      fallbackSemanticVariant: provider.fallbackSemanticVariant,
      errorCode: error.errorCode,
    };
  }

  shouldFallback(context = {}) {
    return this.fallbackDecision(context).allowed;
  }
}

export const defaultFallbackPolicy = Object.freeze(new FallbackPolicy());
