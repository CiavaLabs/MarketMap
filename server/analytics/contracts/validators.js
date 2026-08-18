import { CANONICAL_INSTRUMENT_ID_PATTERN, ERROR_CODES } from "../../contracts/core/constants.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import {
  ANALYTICS_SCHEMA_VERSION,
  EMPIRICAL_CORRECTION,
  EMPIRICAL_REFERENCE_SCORES,
  EMPIRICAL_TAIL,
  EMPIRICAL_TIE_POLICY,
  EWMA_LAMBDA,
  EWMA_MISSING_RETURN_POLICY,
  EWMA_MODEL_VERSION,
  EWMA_WARMUP_RETURNS,
  MOVEMENT_BENCHMARK_INSTRUMENT_ID,
  MOVEMENT_ASSESSMENT_STATUSES,
  MOVEMENT_METHOD_VERSION,
  MOVEMENT_QUALITY_WARNINGS,
  MOVEMENT_SESSION_CALENDAR_ID,
  MOVEMENT_UNAVAILABLE_REASONS,
  SESSION_DATE_PATTERN,
} from "./constants.js";

const RELATIVE_TOLERANCE = 1e-12;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isSessionDate(value) {
  if (typeof value !== "string" || !SESSION_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function approximatelyEqual(left, right, tolerance = RELATIVE_TOLERANCE) {
  if (left === right) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= tolerance * scale;
}

function push(issues, path, message) {
  issues.push({ path, message });
}

function requireObject(value, path, issues) {
  if (isObject(value)) return true;
  push(issues, path, "must be an object");
  return false;
}

function requireInstrumentId(value, path, issues) {
  if (typeof value !== "string" || !CANONICAL_INSTRUMENT_ID_PATTERN.test(value)) {
    push(issues, path, "must be a canonical instrument ID");
  }
}

function requireSessionDate(value, path, issues, { nullable = false } = {}) {
  if ((nullable && value === null) || isSessionDate(value)) return;
  push(issues, path, nullable
    ? "must be a valid YYYY-MM-DD session date or null"
    : "must be a valid YYYY-MM-DD session date");
}

function requireFinite(value, path, issues, { positive = false, minimum, maximum } = {}) {
  if (!isFiniteNumber(value)) {
    push(issues, path, "must be a finite number");
    return;
  }
  if (positive && value <= 0) push(issues, path, "must be greater than zero");
  if (minimum !== undefined && value < minimum) push(issues, path, `must be at least ${minimum}`);
  if (maximum !== undefined && value > maximum) push(issues, path, `must be at most ${maximum}`);
}

function requireInteger(value, path, issues, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    push(issues, path, `must be an integer greater than or equal to ${minimum}`);
  }
}

function collectUniqueEnumArray(value, allowed, path, issues) {
  if (!Array.isArray(value)) {
    push(issues, path, "must be an array");
    return;
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    if (!allowed.includes(entry)) push(issues, `${path}[${index}]`, "contains an unsupported value");
    if (seen.has(entry)) push(issues, `${path}[${index}]`, "must not contain duplicates");
    seen.add(entry);
  });
}

function throwIfInvalid(contract, issues) {
  if (!issues.length) return;
  throw new MarketDataError(
    ERROR_CODES.SCHEMA_INVALID,
    `${contract} failed runtime validation`,
    { details: { contract, issues } },
  );
}

function collectVolatilityForecastIssues(value, path, issues) {
  if (!requireObject(value, path, issues)) return;
  requireInstrumentId(value.instrumentId, `${path}.instrumentId`, issues);
  requireSessionDate(value.originSessionDate, `${path}.originSessionDate`, issues);
  requireSessionDate(value.informationSetEnd, `${path}.informationSetEnd`, issues);
  if (value.informationSetEnd !== value.originSessionDate) {
    push(issues, `${path}.informationSetEnd`, "must equal originSessionDate");
  }
  if (value.horizonSessions !== 1) {
    push(issues, `${path}.horizonSessions`, "must equal one");
  }
  requireFinite(value.variance, `${path}.variance`, issues, { positive: true });
  requireFinite(value.dailyVolatility, `${path}.dailyVolatility`, issues, { positive: true });
  if (isFiniteNumber(value.variance) && value.variance > 0
    && isFiniteNumber(value.dailyVolatility)
    && !approximatelyEqual(value.dailyVolatility ** 2, value.variance)) {
    push(issues, `${path}.dailyVolatility`, "must be the square root of variance");
  }

  if (!requireObject(value.model, `${path}.model`, issues)) return;
  if (value.model.family !== "ewma") push(issues, `${path}.model.family`, "must equal ewma");
  if (value.model.lambda !== EWMA_LAMBDA) {
    push(issues, `${path}.model.lambda`, `must equal ${EWMA_LAMBDA}`);
  }
  if (value.model.mean !== "zero") push(issues, `${path}.model.mean`, "must equal zero");
  if (value.model.initialization !== "zero_mean_second_moment") {
    push(issues, `${path}.model.initialization`, "must equal zero_mean_second_moment");
  }
  if (value.model.missingReturnPolicy !== EWMA_MISSING_RETURN_POLICY) {
    push(
      issues,
      `${path}.model.missingReturnPolicy`,
      `must equal ${EWMA_MISSING_RETURN_POLICY}`,
    );
  }
  if (value.model.warmupReturns !== EWMA_WARMUP_RETURNS) {
    push(issues, `${path}.model.warmupReturns`, `must equal ${EWMA_WARMUP_RETURNS}`);
  }
  if (value.model.version !== EWMA_MODEL_VERSION) {
    push(issues, `${path}.model.version`, `must equal ${EWMA_MODEL_VERSION}`);
  }
}

export function validateVolatilityForecast(value, options = {}) {
  const issues = [];
  collectVolatilityForecastIssues(value, options.path || "forecast", issues);
  throwIfInvalid("VolatilityForecast", issues);
  return value;
}

function collectMovementEvidenceIssues(value, path, issues) {
  if (!requireObject(value, path, issues)) return;
  requireInstrumentId(value.instrumentId, `${path}.instrumentId`, issues);
  requireSessionDate(value.sessionDate, `${path}.sessionDate`, issues);
  requireSessionDate(value.forecastOriginSessionDate, `${path}.forecastOriginSessionDate`, issues);
  if (isSessionDate(value.sessionDate) && isSessionDate(value.forecastOriginSessionDate)
    && value.forecastOriginSessionDate >= value.sessionDate) {
    push(issues, `${path}.forecastOriginSessionDate`, "must precede sessionDate");
  }
  if (value.methodVersion !== MOVEMENT_METHOD_VERSION) {
    push(issues, `${path}.methodVersion`, `must equal ${MOVEMENT_METHOD_VERSION}`);
  }

  if (requireObject(value.observed, `${path}.observed`, issues)) {
    requireFinite(value.observed.simpleReturn, `${path}.observed.simpleReturn`, issues);
    requireFinite(value.observed.logReturn, `${path}.observed.logReturn`, issues);
    if (isFiniteNumber(value.observed.simpleReturn) && value.observed.simpleReturn <= -1) {
      push(issues, `${path}.observed.simpleReturn`, "must be greater than -1");
    }
    if (value.observed.priceBasis !== "provider_adjusted") {
      push(issues, `${path}.observed.priceBasis`, "must equal provider_adjusted");
    }
    if (isFiniteNumber(value.observed.simpleReturn) && value.observed.simpleReturn > -1
      && isFiniteNumber(value.observed.logReturn)
      && !approximatelyEqual(Math.expm1(value.observed.logReturn), value.observed.simpleReturn)) {
      push(issues, `${path}.observed.simpleReturn`, "must correspond to logReturn");
    }
  }

  requireFinite(value.standardizedReturn, `${path}.standardizedReturn`, issues);
  requireFinite(value.absoluteStandardizedReturn, `${path}.absoluteStandardizedReturn`, issues, {
    minimum: 0,
  });
  if (isFiniteNumber(value.standardizedReturn)
    && isFiniteNumber(value.absoluteStandardizedReturn)
    && !approximatelyEqual(Math.abs(value.standardizedReturn), value.absoluteStandardizedReturn)) {
    push(issues, `${path}.absoluteStandardizedReturn`, "must equal abs(standardizedReturn)");
  }
  requireFinite(value.empiricalExceedanceRate, `${path}.empiricalExceedanceRate`, issues, {
    minimum: 1 / (EMPIRICAL_REFERENCE_SCORES + 1),
    maximum: 1,
  });
  requireFinite(value.historicalRarityPercentile, `${path}.historicalRarityPercentile`, issues, {
    minimum: 0,
    maximum: 100,
  });
  if (isFiniteNumber(value.empiricalExceedanceRate)
    && isFiniteNumber(value.historicalRarityPercentile)
    && !approximatelyEqual(
      100 * (1 - value.empiricalExceedanceRate),
      value.historicalRarityPercentile,
    )) {
    push(issues, `${path}.historicalRarityPercentile`, "must equal 100 * (1 - empiricalExceedanceRate)");
  }

  if (!requireObject(value.reference, `${path}.reference`, issues)) return;
  if (value.reference.scoreCount !== EMPIRICAL_REFERENCE_SCORES) {
    push(
      issues,
      `${path}.reference.scoreCount`,
      `must equal ${EMPIRICAL_REFERENCE_SCORES}`,
    );
  }
  requireSessionDate(value.reference.startSessionDate, `${path}.reference.startSessionDate`, issues);
  requireSessionDate(value.reference.endSessionDate, `${path}.reference.endSessionDate`, issues);
  if (isSessionDate(value.reference.startSessionDate)
    && isSessionDate(value.reference.endSessionDate)
    && value.reference.startSessionDate >= value.reference.endSessionDate) {
    push(issues, `${path}.reference.startSessionDate`, "must precede endSessionDate");
  }
  if (isSessionDate(value.reference.endSessionDate) && isSessionDate(value.sessionDate)
    && value.reference.endSessionDate >= value.sessionDate) {
    push(issues, `${path}.reference.endSessionDate`, "must precede the observed session");
  }
  if (isSessionDate(value.reference.endSessionDate)
    && isSessionDate(value.forecastOriginSessionDate)
    && value.reference.endSessionDate > value.forecastOriginSessionDate) {
    push(
      issues,
      `${path}.reference.endSessionDate`,
      "must not follow the forecast information set",
    );
  }
  if (value.reference.tail !== EMPIRICAL_TAIL) {
    push(issues, `${path}.reference.tail`, `must equal ${EMPIRICAL_TAIL}`);
  }
  if (value.reference.tiePolicy !== EMPIRICAL_TIE_POLICY) {
    push(issues, `${path}.reference.tiePolicy`, `must equal ${EMPIRICAL_TIE_POLICY}`);
  }
  if (value.reference.correction !== EMPIRICAL_CORRECTION) {
    push(issues, `${path}.reference.correction`, `must equal ${EMPIRICAL_CORRECTION}`);
  }
  if (isFiniteNumber(value.empiricalExceedanceRate)) {
    const resolvedRank = value.empiricalExceedanceRate * (EMPIRICAL_REFERENCE_SCORES + 1);
    if (!approximatelyEqual(resolvedRank, Math.round(resolvedRank))) {
      push(
        issues,
        `${path}.empiricalExceedanceRate`,
        "must lie on the finite-sample rank grid",
      );
    }
  }
}

export function validateMovementEvidence(value, options = {}) {
  const issues = [];
  collectMovementEvidenceIssues(value, options.path || "evidence", issues);
  throwIfInvalid("MovementEvidence", issues);
  return value;
}

function collectQualityIssues(value, path, issues) {
  if (!requireObject(value, path, issues)) return;
  collectUniqueEnumArray(
    value.reasonCodes,
    MOVEMENT_UNAVAILABLE_REASONS,
    `${path}.reasonCodes`,
    issues,
  );
  collectUniqueEnumArray(
    value.warnings,
    MOVEMENT_QUALITY_WARNINGS,
    `${path}.warnings`,
    issues,
  );
  for (const key of [
    "expectedSessionCount",
    "missingSessionCount",
    "validReturnCount",
    "priorScoreCount",
  ]) {
    requireInteger(value[key], `${path}.${key}`, issues);
  }
  requireFinite(value.missingRate, `${path}.missingRate`, issues, { minimum: 0, maximum: 1 });
  requireSessionDate(value.latestAssetSession, `${path}.latestAssetSession`, issues, { nullable: true });
  requireSessionDate(
    value.latestBenchmarkSession,
    `${path}.latestBenchmarkSession`,
    issues,
    { nullable: true },
  );
  if (value.sessionGrid !== null) {
    if (requireObject(value.sessionGrid, `${path}.sessionGrid`, issues)) {
      if (value.sessionGrid.calendarId !== MOVEMENT_SESSION_CALENDAR_ID) {
        push(
          issues,
          `${path}.sessionGrid.calendarId`,
          `must equal ${MOVEMENT_SESSION_CALENDAR_ID}`,
        );
      }
      for (const key of ["source", "revision", "timeZone"]) {
        if (typeof value.sessionGrid[key] !== "string"
          || !value.sessionGrid[key].trim()) {
          push(issues, `${path}.sessionGrid.${key}`, "must be a non-empty string");
        }
      }
      requireSessionDate(
        value.sessionGrid.startSessionDate,
        `${path}.sessionGrid.startSessionDate`,
        issues,
      );
      requireSessionDate(
        value.sessionGrid.endSessionDate,
        `${path}.sessionGrid.endSessionDate`,
        issues,
      );
      requireInteger(
        value.sessionGrid.sessionCount,
        `${path}.sessionGrid.sessionCount`,
        issues,
        { minimum: 2 },
      );
      if (isSessionDate(value.sessionGrid.startSessionDate)
        && isSessionDate(value.sessionGrid.endSessionDate)
        && value.sessionGrid.startSessionDate >= value.sessionGrid.endSessionDate) {
        push(
          issues,
          `${path}.sessionGrid.startSessionDate`,
          "must precede endSessionDate",
        );
      }
    }
  }
  if (value.historySource !== null && typeof value.historySource !== "string") {
    push(issues, `${path}.historySource`, "must be a string or null");
  }
  if (value.adjustmentMode !== null && typeof value.adjustmentMode !== "string") {
    push(issues, `${path}.adjustmentMode`, "must be a string or null");
  }
  if (Number.isInteger(value.missingSessionCount)
    && Number.isInteger(value.expectedSessionCount)
    && value.missingSessionCount > value.expectedSessionCount) {
    push(issues, `${path}.missingSessionCount`, "must not exceed expectedSessionCount");
  }
  if (Number.isInteger(value.missingSessionCount)
    && Number.isInteger(value.expectedSessionCount)
    && value.expectedSessionCount > 0
    && isFiniteNumber(value.missingRate)
    && !approximatelyEqual(
      value.missingSessionCount / value.expectedSessionCount,
      value.missingRate,
    )) {
    push(issues, `${path}.missingRate`, "must match the session counts");
  }
}

export function validateMovementAssessment(value, options = {}) {
  const path = options.path || "assessment";
  const issues = [];
  if (!requireObject(value, path, issues)) {
    throwIfInvalid("MovementAssessment", issues);
    return value;
  }

  if (value.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    push(issues, `${path}.schemaVersion`, `must equal ${ANALYTICS_SCHEMA_VERSION}`);
  }
  requireInstrumentId(value.instrumentId, `${path}.instrumentId`, issues);
  if (!MOVEMENT_ASSESSMENT_STATUSES.includes(value.status)) {
    push(issues, `${path}.status`, "contains an unsupported status");
  }
  requireSessionDate(value.sessionDate, `${path}.sessionDate`, issues, { nullable: true });
  if (value.methodVersion !== MOVEMENT_METHOD_VERSION) {
    push(issues, `${path}.methodVersion`, `must equal ${MOVEMENT_METHOD_VERSION}`);
  }
  collectQualityIssues(value.quality, `${path}.quality`, issues);

  if (value.status === "available") {
    if (value.sessionDate === null) push(issues, `${path}.sessionDate`, "is required when available");
    collectVolatilityForecastIssues(value.forecast, `${path}.forecast`, issues);
    collectMovementEvidenceIssues(value.evidence, `${path}.evidence`, issues);
    if (Array.isArray(value.quality?.reasonCodes) && value.quality.reasonCodes.length) {
      push(issues, `${path}.quality.reasonCodes`, "must be empty when available");
    }
    if (value.quality?.historySource !== "yahoo") {
      push(issues, `${path}.quality.historySource`, "must equal yahoo when available");
    }
    if (value.quality?.adjustmentMode !== "provider_adjusted") {
      push(
        issues,
        `${path}.quality.adjustmentMode`,
        "must equal provider_adjusted when available",
      );
    }
    if (value.quality?.latestAssetSession !== value.sessionDate
      || value.quality?.latestBenchmarkSession !== value.sessionDate) {
      push(issues, `${path}.quality`, "latest asset and benchmark sessions must match sessionDate");
    }
    if (!isObject(value.quality?.sessionGrid)) {
      push(issues, `${path}.quality.sessionGrid`, "is required when available");
    } else {
      if (value.quality.sessionGrid.endSessionDate !== value.sessionDate) {
        push(
          issues,
          `${path}.quality.sessionGrid.endSessionDate`,
          "must match sessionDate when available",
        );
      }
      if (value.quality.sessionGrid.sessionCount
        !== value.quality.expectedSessionCount) {
        push(
          issues,
          `${path}.quality.sessionGrid.sessionCount`,
          "must match expectedSessionCount",
        );
      }
    }
    if (value.quality?.priorScoreCount !== EMPIRICAL_REFERENCE_SCORES) {
      push(
        issues,
        `${path}.quality.priorScoreCount`,
        `must equal ${EMPIRICAL_REFERENCE_SCORES} when available`,
      );
    }
    if (value.forecast?.instrumentId === MOVEMENT_BENCHMARK_INSTRUMENT_ID) {
      push(issues, `${path}.forecast.instrumentId`, "must identify the assessed asset, not the benchmark");
    }
    if (isObject(value.forecast) && isObject(value.evidence)) {
      if (value.forecast.instrumentId !== value.instrumentId
        || value.evidence.instrumentId !== value.instrumentId) {
        push(issues, `${path}.instrumentId`, "must match forecast and evidence");
      }
      if (value.evidence.sessionDate !== value.sessionDate) {
        push(issues, `${path}.sessionDate`, "must match evidence.sessionDate");
      }
      if (value.forecast.originSessionDate !== value.evidence.forecastOriginSessionDate) {
        push(issues, `${path}.forecast.originSessionDate`, "must match evidence forecast origin");
      }
      if (isFiniteNumber(value.evidence.observed?.logReturn)
        && isFiniteNumber(value.forecast.dailyVolatility)
        && isFiniteNumber(value.evidence.standardizedReturn)
        && !approximatelyEqual(
          value.evidence.observed.logReturn / value.forecast.dailyVolatility,
          value.evidence.standardizedReturn,
        )) {
        push(issues, `${path}.evidence.standardizedReturn`, "must use the attached forecast");
      }
    }
  } else if (value.status === "unavailable") {
    if (value.forecast !== null) push(issues, `${path}.forecast`, "must be null when unavailable");
    if (value.evidence !== null) push(issues, `${path}.evidence`, "must be null when unavailable");
    if (!Array.isArray(value.quality?.reasonCodes) || !value.quality.reasonCodes.length) {
      push(issues, `${path}.quality.reasonCodes`, "must explain an unavailable assessment");
    }
  }

  throwIfInvalid("MovementAssessment", issues);
  return value;
}
