import {
  ADJUSTMENT_STATUSES,
  MARKET_ASSET_CLASSES,
  CONTINUITY_KINDS,
  PRICE_BASES,
  PROVENANCE_SOURCES,
} from "./constants.js";
import { CANONICAL_INSTRUMENT_ID_PATTERN } from "../core/constants.js";
import { HISTORY_ALLOWLIST } from "../core/history.js";
import { collectFieldAvailabilityIssues } from "./availability.js";
import { collectDataQualityIssues, collectSurfaceQualityIssues } from "./dataQuality.js";
import { collectProvenanceIssues } from "./provenance.js";
import { collectSessionIssues } from "./session.js";
import { assetPolicyFor } from "../../instruments/assetPolicies.js";
import {
  hasOwn,
  isFiniteNumber,
  isNonEmptyString,
  isObject,
  issue,
  requireEnum,
  requireObject,
  requireString,
  requireTimestamp,
  throwIfInvalid,
} from "./validation.js";

const BAR_NULLABLE_FIELDS = Object.freeze(["volume", "adjustedClose", "displayClose"]);
const ADJUSTMENT_STATUS_BY_BASIS = Object.freeze({
  raw: ["none", "unknown"],
  provider_adjusted: ["provider_defined"],
  split_adjusted: ["split_adjusted"],
});
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function policyFor(assetClass) {
  try {
    return assetPolicyFor(assetClass);
  } catch {
    return null;
  }
}

function tribool(value) {
  return typeof value === "boolean" || value === "unknown";
}

function collectAdjustmentIssues(value, priceBasis, path, issues) {
  if (!requireObject(value, path, issues)) return;
  requireEnum(value, "status", ADJUSTMENT_STATUSES, path, issues);
  const allowed = ADJUSTMENT_STATUS_BY_BASIS[priceBasis];
  if (allowed && ADJUSTMENT_STATUSES.includes(value.status) && !allowed.includes(value.status)) {
    issues.push(issue(`${path}.status`, `must be one of: ${allowed.join(", ")} for a ${priceBasis} series`));
  }
  if (!tribool(value.includesSplits)) {
    issues.push(issue(`${path}.includesSplits`, "must be a boolean or \"unknown\""));
  }
  if (!tribool(value.includesDistributions)) {
    issues.push(issue(`${path}.includesDistributions`, "must be a boolean or \"unknown\""));
  }
  if (value.formulaVersion !== null && !isNonEmptyString(value.formulaVersion)) {
    issues.push(issue(`${path}.formulaVersion`, "must be a non-empty string or null"));
  }
}

function collectContinuityIssues(value, assetClass, path, issues) {
  if (!requireObject(value, path, issues)) return;
  requireEnum(value, "kind", CONTINUITY_KINDS, path, issues);
  if (value.kind === "single_instrument") {
    if (value.rollover !== null) {
      issues.push(issue(`${path}.rollover`, "must be null for a single instrument series"));
    }
    return;
  }
  if (value.kind !== "provider_continuous_front") return;
  if (assetClass !== "commodity_future") {
    issues.push(issue(`${path}.kind`, "provider continuity is only valid for commodity futures"));
  }
  requireString(value, "activeContract", path, issues);
  if (value.expirationDate !== null && !isNonEmptyString(value.expirationDate)) {
    issues.push(issue(`${path}.expirationDate`, "must be an ISO-8601 timestamp or null"));
  } else if (isNonEmptyString(value.expirationDate) && !Number.isFinite(Date.parse(value.expirationDate))) {
    issues.push(issue(`${path}.expirationDate`, "must be an ISO-8601 timestamp or null"));
  }
  if (value.rollover !== "provider_managed") {
    issues.push(issue(`${path}.rollover`, "must be provider_managed for a continuous series"));
  }
  if (!["none", "unknown"].includes(value.backAdjustment)) {
    issues.push(issue(`${path}.backAdjustment`, "must be none or unknown"));
  }
  if (value.comparableAcrossRollover !== false) {
    issues.push(issue(`${path}.comparableAcrossRollover`, "must be false: rollovers break comparability"));
  }
}

function collectEventIssues(events, policy, path, issues) {
  if (!Array.isArray(events)) {
    issues.push(issue(path, "must be an array"));
    return;
  }
  if (events.length && policy && !policy.history.corporateActions) {
    issues.push(issue(path, "must be empty: corporate actions do not apply to this asset class"));
  }
  events.forEach((event, index) => {
    const eventPath = `${path}[${index}]`;
    if (!requireObject(event, eventPath, issues)) return;
    requireTimestamp(event, "timestamp", eventPath, issues);
    requireEnum(event, "source", PROVENANCE_SOURCES, eventPath, issues);
    if (event.type === "dividend") {
      if (!isFiniteNumber(event.amount) || event.amount <= 0) {
        issues.push(issue(`${eventPath}.amount`, "must be a positive number"));
      }
      if (!isNonEmptyString(event.currency) || !CURRENCY_PATTERN.test(event.currency)) {
        issues.push(issue(`${eventPath}.currency`, "must be a three-letter currency code"));
      }
    } else if (event.type === "split") {
      for (const key of ["numerator", "denominator"]) {
        if (!Number.isInteger(event[key]) || event[key] <= 0) {
          issues.push(issue(`${eventPath}.${key}`, "must be a positive integer"));
        }
      }
    } else {
      issues.push(issue(`${eventPath}.type`, "must be dividend or split"));
    }
  });
}

function seriesDefaultExplains(seriesAvailability, field) {
  const entry = isObject(seriesAvailability) ? seriesAvailability[field] : undefined;
  return isObject(entry) && entry.status !== "available" && entry.status !== "stale";
}

function barExplains(bar, field) {
  const entry = isObject(bar.fieldAvailability) ? bar.fieldAvailability[field] : undefined;
  return isObject(entry) && entry.status !== "available" && entry.status !== "stale";
}

export function collectHistorySeriesIssues(value, path = "history") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;

  requireString(value, "instrumentId", path, issues);
  if (isNonEmptyString(value.instrumentId) && !CANONICAL_INSTRUMENT_ID_PATTERN.test(value.instrumentId)) {
    issues.push(issue(`${path}.instrumentId`, "must be a canonical instrument ID"));
  }
  requireEnum(value, "assetClass", MARKET_ASSET_CLASSES, path, issues);

  if (!HISTORY_ALLOWLIST[value.range]) {
    issues.push(issue(`${path}.range`, `must be one of: ${Object.keys(HISTORY_ALLOWLIST).join(", ")}`));
  } else if (!HISTORY_ALLOWLIST[value.range].includes(value.interval)) {
    issues.push(issue(`${path}.interval`, `is not allowed for range ${value.range}`));
  }

  requireEnum(value, "priceBasis", PRICE_BASES, path, issues);
  requireEnum(value, "requestedPriceBasis", PRICE_BASES, path, issues);
  if (value.priceBasis !== value.requestedPriceBasis) {
    issues.push(issue(`${path}.priceBasis`, "must satisfy the requested basis; downgrades are a distinct request"));
  }

  const policy = policyFor(value.assetClass);
  if (policy && PRICE_BASES.includes(value.priceBasis)
    && !policy.history.priceBases.includes(value.priceBasis)) {
    issues.push(issue(`${path}.priceBasis`, `is not an allowed basis for ${value.assetClass}`));
  }

  collectAdjustmentIssues(value.adjustment, value.priceBasis, `${path}.adjustment`, issues);
  collectContinuityIssues(value.continuity, value.assetClass, `${path}.continuity`, issues);
  issues.push(...collectSessionIssues(value.session, `${path}.session`, { requirePhase: false }));

  if (hasOwn(value, "fieldAvailability") && value.fieldAvailability !== undefined) {
    if (requireObject(value.fieldAvailability, `${path}.fieldAvailability`, issues)) {
      for (const key of Object.keys(value.fieldAvailability)) {
        if (!BAR_NULLABLE_FIELDS.includes(key)) {
          issues.push(issue(`${path}.fieldAvailability.${key}`, "does not correspond to a bar field"));
          continue;
        }
        issues.push(...collectFieldAvailabilityIssues(value.fieldAvailability[key], `${path}.fieldAvailability.${key}`));
      }
    }
  }

  let missingAdjustedRows = 0;
  if (!Array.isArray(value.bars) || !value.bars.length) {
    issues.push(issue(`${path}.bars`, "must be a non-empty array"));
  } else {
    let previousTime = -Infinity;
    value.bars.forEach((bar, index) => {
      const barPath = `${path}.bars[${index}]`;
      if (!requireObject(bar, barPath, issues)) return;
      requireTimestamp(bar, "timestamp", barPath, issues);
      const timestamp = Date.parse(bar.timestamp);
      if (Number.isFinite(timestamp)) {
        if (timestamp <= previousTime) {
          issues.push(issue(`${barPath}.timestamp`, "must be unique and strictly ascending"));
        }
        previousTime = timestamp;
      }

      for (const key of ["open", "high", "low", "close"]) {
        if (!isFiniteNumber(bar[key])) {
          issues.push(issue(`${barPath}.${key}`, "must be a finite number"));
        } else if (policy && !policy.allowNegativePrices && bar[key] <= 0) {
          issues.push(issue(`${barPath}.${key}`, `must be positive for ${value.assetClass}`));
        }
      }
      if ([bar.open, bar.high, bar.low, bar.close].every(isFiniteNumber)) {
        if (bar.high < Math.max(bar.open, bar.low, bar.close)) {
          issues.push(issue(`${barPath}.high`, "must be at least open, low, and close"));
        }
        if (bar.low > Math.min(bar.open, bar.high, bar.close)) {
          issues.push(issue(`${barPath}.low`, "must be at most open, high, and close"));
        }
      }

      for (const key of BAR_NULLABLE_FIELDS) {
        if (bar[key] !== null && bar[key] !== undefined && !isFiniteNumber(bar[key])) {
          issues.push(issue(`${barPath}.${key}`, "must be a finite number or null"));
        }
      }
      if (isFiniteNumber(bar.volume) && bar.volume < 0) {
        issues.push(issue(`${barPath}.volume`, "must be non-negative"));
      }

      if (value.priceBasis === "raw" || value.priceBasis === "split_adjusted") {
        if (isFiniteNumber(bar.close) && bar.displayClose !== bar.close) {
          issues.push(issue(`${barPath}.displayClose`, `must equal close for a ${value.priceBasis} series`));
        }
      } else if (value.priceBasis === "provider_adjusted") {
        if (isFiniteNumber(bar.adjustedClose)) {
          if (bar.displayClose !== bar.adjustedClose) {
            issues.push(issue(`${barPath}.displayClose`, "must equal adjustedClose for a provider_adjusted series"));
          }
        } else {
          missingAdjustedRows += 1;
          if (bar.displayClose !== null && bar.displayClose !== undefined) {
            issues.push(issue(`${barPath}.displayClose`, "must be a gap when adjustedClose is missing, not raw close"));
          }
          if (!barExplains(bar, "adjustedClose") && !seriesDefaultExplains(value.fieldAvailability, "adjustedClose")) {
            issues.push(issue(`${barPath}.fieldAvailability.adjustedClose`, "is required to explain a missing adjusted close"));
          }
        }
      }

      if ((bar.volume === null || bar.volume === undefined)
        && !barExplains(bar, "volume")
        && !seriesDefaultExplains(value.fieldAvailability, "volume")) {
        issues.push(issue(`${barPath}.fieldAvailability.volume`, "is required to explain a null volume"));
      }
    });
  }

  collectEventIssues(value.events, policy, `${path}.events`, issues);
  issues.push(...collectSurfaceQualityIssues(value, path));
  issues.push(...collectDataQualityIssues(value.dataQuality, `${path}.dataQuality`));

  if (isObject(value.dataQuality)) {
    const declaredRows = value.dataQuality.rowCount;
    if (declaredRows !== undefined && Array.isArray(value.bars) && declaredRows !== value.bars.length) {
      issues.push(issue(`${path}.dataQuality.rowCount`, "must match the number of returned bars"));
    }
    const declaredMissing = value.dataQuality.missingAdjustedCloseRows;
    if (value.priceBasis === "provider_adjusted") {
      if (declaredMissing !== undefined && declaredMissing !== missingAdjustedRows) {
        issues.push(issue(`${path}.dataQuality.missingAdjustedCloseRows`, "must match the observed adjusted-close gaps"));
      }
      if (missingAdjustedRows > 0 && Array.isArray(value.dataQuality.issues)
        && !value.dataQuality.issues.some((entry) => entry?.code === "partial_adjusted_series")) {
        issues.push(issue(`${path}.dataQuality.issues`, "must report partial_adjusted_series when adjusted closes are missing"));
      }
    }
  }

  issues.push(...collectProvenanceIssues(value.provenance, `${path}.provenance`));
  requireTimestamp(value, "asOf", path, issues);
  requireTimestamp(value, "fetchedAt", path, issues);
  return issues;
}

export function validateHistorySeries(value, options = {}) {
  const issues = collectHistorySeriesIssues(value, options.path || "history");
  throwIfInvalid("HistorySeries", issues, options.code);
  return value;
}
