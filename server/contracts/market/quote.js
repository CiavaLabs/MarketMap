import {
  MARKET_ASSET_CLASSES,
  PRICE_UNITS,
} from "./constants.js";
import { CANONICAL_INSTRUMENT_ID_PATTERN } from "../core/constants.js";
import { collectAvailabilityInvariantIssues } from "./availability.js";
import { collectDataQualityIssues, collectSurfaceQualityIssues } from "./dataQuality.js";
import { collectProvenanceIssues } from "./provenance.js";
import { collectSessionIssues } from "./session.js";
import { assetPolicyFor } from "../../instruments/assetPolicies.js";
import {
  isFiniteNumber,
  isNonEmptyString,
  isObject,
  issue,
  requireEnum,
  requireNullableNumber,
  requireObject,
  requireString,
  requireTimestamp,
  throwIfInvalid,
} from "./validation.js";

export const QUOTE_OBSERVATION_FIELDS = Object.freeze([
  "change",
  "changePercent",
  "open",
  "previousClose",
  "dayHigh",
  "dayLow",
  "bid",
  "ask",
  "volume",
  "averageVolume3m",
]);

const PRICE_LEVEL_FIELDS = ["value", "open", "previousClose", "dayHigh", "dayLow"];

function policyFor(assetClass) {
  try {
    return assetPolicyFor(assetClass);
  } catch {
    return null;
  }
}

export function collectQuoteSnapshotIssues(value, path = "quote") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;

  requireString(value, "instrumentId", path, issues);
  if (isNonEmptyString(value.instrumentId) && !CANONICAL_INSTRUMENT_ID_PATTERN.test(value.instrumentId)) {
    issues.push(issue(`${path}.instrumentId`, "must be a canonical instrument ID"));
  }
  requireEnum(value, "assetClass", MARKET_ASSET_CLASSES, path, issues);
  requireEnum(value, "priceUnit", PRICE_UNITS, path, issues);

  if (!isFiniteNumber(value.value)) {
    issues.push(issue(`${path}.value`, "must be a finite number"));
  }
  if (value.price !== value.value) {
    issues.push(issue(`${path}.price`, "must alias value during the migration"));
  }
  if (!(value.currency === null || isNonEmptyString(value.currency))) {
    issues.push(issue(`${path}.currency`, "must be a non-empty string or null"));
  }

  for (const key of QUOTE_OBSERVATION_FIELDS) {
    requireNullableNumber(value, key, path, issues);
  }

  const policy = policyFor(value.assetClass);
  if (policy) {
    if (!policy.allowNegativePrices) {
      for (const key of PRICE_LEVEL_FIELDS) {
        if (isFiniteNumber(value[key]) && value[key] <= 0) {
          issues.push(issue(`${path}.${key}`, `must be positive for ${value.assetClass}`));
        }
      }
      for (const key of ["bid", "ask"]) {
        if (isFiniteNumber(value[key]) && value[key] <= 0) {
          issues.push(issue(`${path}.${key}`, "must be positive when present; provider zeros are placeholders"));
        }
      }
    }
    if (value.priceUnit !== policy.priceUnit) {
      issues.push(issue(`${path}.priceUnit`, `must be ${policy.priceUnit} for ${value.assetClass}`));
    }
    if (policy.bidAsk === "not_applicable") {
      for (const key of ["bid", "ask"]) {
        if (value[key] !== null) {
          issues.push(issue(`${path}.${key}`, `must be null: order book does not apply to ${value.assetClass}`));
        }
      }
    }
    if (policy.volume === "not_applicable") {
      for (const key of ["volume", "averageVolume3m"]) {
        if (value[key] !== null) {
          issues.push(issue(`${path}.${key}`, `must be null: volume does not apply to ${value.assetClass}`));
        }
      }
    }
    if (isObject(value.session) && value.session.model !== policy.sessionModel && value.session.model !== "unknown") {
      issues.push(issue(`${path}.session.model`, `must be ${policy.sessionModel} for ${value.assetClass}`));
    }
  }

  if (isFiniteNumber(value.dayHigh) && isFiniteNumber(value.dayLow) && value.dayHigh < value.dayLow) {
    issues.push(issue(`${path}.dayHigh`, "must be greater than or equal to dayLow"));
  }
  if (isFiniteNumber(value.bid) && isFiniteNumber(value.ask) && value.ask < value.bid) {
    issues.push(issue(`${path}.ask`, "must be greater than or equal to bid"));
  }

  issues.push(...collectSessionIssues(value.session, `${path}.session`));
  issues.push(...collectAvailabilityInvariantIssues({
    values: value,
    fieldAvailability: value.fieldAvailability,
    fields: QUOTE_OBSERVATION_FIELDS,
    path: `${path}.fieldAvailability`,
  }));
  issues.push(...collectSurfaceQualityIssues(value, path));
  issues.push(...collectDataQualityIssues(value.dataQuality, `${path}.dataQuality`));
  issues.push(...collectProvenanceIssues(value.provenance, `${path}.provenance`));
  requireTimestamp(value, "asOf", path, issues);
  requireTimestamp(value, "fetchedAt", path, issues);
  return issues;
}

export function validateQuoteSnapshot(value, options = {}) {
  const issues = collectQuoteSnapshotIssues(value, options.path || "quote");
  throwIfInvalid("QuoteSnapshot", issues, options.code);
  return value;
}
