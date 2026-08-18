import { describe, expect, it } from "vitest";

import { computeMovementAssessment } from "../../../server/analytics/computeMovementAssessment.js";
import {
  validateMovementAssessment,
  validateMovementEvidence,
  validateVolatilityForecast,
} from "../../../server/analytics/contracts/validators.js";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { movementFixture } from "./fixtures.js";

const VALID = computeMovementAssessment(movementFixture());

function issuePaths(validate, subject, mutate, options) {
  const candidate = structuredClone(subject);
  mutate(candidate);
  try {
    validate(candidate, options);
  } catch (error) {
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
    return error.details.issues.map((issue) => issue.path);
  }
  return [];
}

const forecastPaths = (mutate, options) =>
  issuePaths(validateVolatilityForecast, VALID.forecast, mutate, options);
const dayAfter = (sessionDate) => new Date(Date.parse(`${sessionDate}T00:00:00.000Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10);

const evidencePaths = (mutate, options) =>
  issuePaths(validateMovementEvidence, VALID.evidence, mutate, options);
const assessmentPaths = (mutate, options) =>
  issuePaths(validateMovementAssessment, VALID, mutate, options);

function unavailable(mutate = () => {}) {
  const candidate = structuredClone(VALID);
  candidate.status = "unavailable";
  candidate.sessionDate = null;
  candidate.forecast = null;
  candidate.evidence = null;
  candidate.quality.reasonCodes = ["insufficient_valid_returns"];
  mutate(candidate);
  return candidate;
}

describe("volatility forecast validation", () => {
  it("accepts the computed forecast and returns it unchanged", () => {
    expect(validateVolatilityForecast(VALID.forecast)).toBe(VALID.forecast);
  });

  it.each([
    ["a malformed instrument ID", (f) => { f.instrumentId = "AAPL"; }, "forecast.instrumentId"],
    ["a malformed origin date", (f) => { f.originSessionDate = "28-03-2025"; }, "forecast.originSessionDate"],
    ["an impossible calendar date", (f) => { f.originSessionDate = "2025-02-30"; }, "forecast.originSessionDate"],
    ["an information set past the origin", (f) => { f.informationSetEnd = "2025-03-27"; }, "forecast.informationSetEnd"],
    ["a horizon other than one session", (f) => { f.horizonSessions = 2; }, "forecast.horizonSessions"],
    ["a non-positive variance", (f) => { f.variance = 0; }, "forecast.variance"],
    ["a non-finite variance", (f) => { f.variance = Number.NaN; }, "forecast.variance"],
    ["a non-positive volatility", (f) => { f.dailyVolatility = -0.1; }, "forecast.dailyVolatility"],
    ["a volatility that is not the square root of variance", (f) => { f.dailyVolatility *= 2; }, "forecast.dailyVolatility"],
    ["a missing model", (f) => { f.model = "ewma"; }, "forecast.model"],
    ["a non-EWMA family", (f) => { f.model.family = "garch"; }, "forecast.model.family"],
    ["a different decay factor", (f) => { f.model.lambda = 0.97; }, "forecast.model.lambda"],
    ["a non-zero mean", (f) => { f.model.mean = "sample"; }, "forecast.model.mean"],
    ["a different initialization", (f) => { f.model.initialization = "sample_variance"; }, "forecast.model.initialization"],
    ["a different missing-return policy", (f) => { f.model.missingReturnPolicy = "impute_zero"; }, "forecast.model.missingReturnPolicy"],
    ["a different warmup length", (f) => { f.model.warmupReturns = 30; }, "forecast.model.warmupReturns"],
    ["a different model version", (f) => { f.model.version = "ewma-zero-mean@2"; }, "forecast.model.version"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(forecastPaths(mutate)).toContain(path);
  });

  it("rejects a non-object forecast", () => {
    expect(() => validateVolatilityForecast([])).toThrowError(/failed runtime validation/u);
    expect(issuePaths(validateVolatilityForecast, {}, () => {})).toContain("forecast.instrumentId");
  });

  it("reports issues under a caller-supplied path", () => {
    const paths = forecastPaths((f) => { f.horizonSessions = 5; }, { path: "record.forecast" });
    expect(paths).toContain("record.forecast.horizonSessions");
  });
});

describe("movement evidence validation", () => {
  it("accepts the computed evidence and returns it unchanged", () => {
    expect(validateMovementEvidence(VALID.evidence)).toBe(VALID.evidence);
  });

  it.each([
    ["a malformed instrument ID", (e) => { e.instrumentId = "xnas:aapl!"; }, "evidence.instrumentId"],
    ["a malformed session date", (e) => { e.sessionDate = "2025/03/29"; }, "evidence.sessionDate"],
    ["a forecast origin on the observed session", (e) => { e.forecastOriginSessionDate = e.sessionDate; }, "evidence.forecastOriginSessionDate"],
    ["a forecast origin after the observed session", (e) => { e.forecastOriginSessionDate = dayAfter(e.sessionDate); }, "evidence.forecastOriginSessionDate"],
    ["a different method version", (e) => { e.methodVersion = "movement-ewma-empirical@2"; }, "evidence.methodVersion"],
    ["a missing observation", (e) => { e.observed = null; }, "evidence.observed"],
    ["a non-finite simple return", (e) => { e.observed.simpleReturn = Number.POSITIVE_INFINITY; }, "evidence.observed.simpleReturn"],
    ["a total loss simple return", (e) => { e.observed.simpleReturn = -1; }, "evidence.observed.simpleReturn"],
    ["a non-finite log return", (e) => { e.observed.logReturn = "-0.0026"; }, "evidence.observed.logReturn"],
    ["an unadjusted price basis", (e) => { e.observed.priceBasis = "raw"; }, "evidence.observed.priceBasis"],
    ["a simple return inconsistent with the log return", (e) => { e.observed.simpleReturn = 0.01; }, "evidence.observed.simpleReturn"],
    ["a non-finite standardized return", (e) => { e.standardizedReturn = null; }, "evidence.standardizedReturn"],
    ["a negative absolute standardized return", (e) => { e.absoluteStandardizedReturn = -0.5; }, "evidence.absoluteStandardizedReturn"],
    ["an absolute value that disagrees with the signed one", (e) => { e.absoluteStandardizedReturn += 1; }, "evidence.absoluteStandardizedReturn"],
    ["an exceedance rate above one", (e) => { e.empiricalExceedanceRate = 1.2; }, "evidence.empiricalExceedanceRate"],
    ["an exceedance rate below the finite-sample floor", (e) => { e.empiricalExceedanceRate = 0.0001; }, "evidence.empiricalExceedanceRate"],
    ["a non-numeric exceedance rate", (e) => { e.empiricalExceedanceRate = "0.44"; }, "evidence.empiricalExceedanceRate"],
    ["a rarity percentile above one hundred", (e) => { e.historicalRarityPercentile = 101; }, "evidence.historicalRarityPercentile"],
    ["a rarity percentile below zero", (e) => { e.historicalRarityPercentile = -1; }, "evidence.historicalRarityPercentile"],
    ["a missing reference window", (e) => { e.reference = null; }, "evidence.reference"],
    ["a different reference score count", (e) => { e.reference.scoreCount = 500; }, "evidence.reference.scoreCount"],
    ["a malformed reference start", (e) => { e.reference.startSessionDate = "2023-13-04"; }, "evidence.reference.startSessionDate"],
    ["a malformed reference end", (e) => { e.reference.endSessionDate = null; }, "evidence.reference.endSessionDate"],
    ["a reference window that does not move forward", (e) => { e.reference.startSessionDate = e.reference.endSessionDate; }, "evidence.reference.startSessionDate"],
    ["a reference window reaching the observed session", (e) => {
      e.reference.endSessionDate = e.sessionDate;
    }, "evidence.reference.endSessionDate"],
    ["a different tail convention", (e) => { e.reference.tail = "upper_one_sided"; }, "evidence.reference.tail"],
    ["a different tie policy", (e) => { e.reference.tiePolicy = "greater_than"; }, "evidence.reference.tiePolicy"],
    ["a different small-sample correction", (e) => { e.reference.correction = "none"; }, "evidence.reference.correction"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(evidencePaths(mutate)).toContain(path);
  });

  it("rejects a rarity percentile that contradicts the exceedance rate", () => {
    const paths = evidencePaths((e) => { e.historicalRarityPercentile = 40; });
    expect(paths).toContain("evidence.historicalRarityPercentile");
  });

  it("rejects an exceedance rate off the finite-sample rank grid", () => {
    const paths = evidencePaths((e) => {
      e.empiricalExceedanceRate = 0.4375;
      e.historicalRarityPercentile = 56.25;
    });
    expect(paths).toEqual(["evidence.empiricalExceedanceRate"]);
  });

  it("rejects a reference window that outruns the forecast information set", () => {
    const paths = evidencePaths((e) => {
      e.reference.endSessionDate = dayAfter(e.forecastOriginSessionDate);
    });
    expect(paths).toContain("evidence.reference.endSessionDate");
  });

  it("rejects a non-object evidence record", () => {
    expect(() => validateMovementEvidence("evidence")).toThrowError(/failed runtime validation/u);
  });
});

describe("movement assessment validation", () => {
  it("accepts an available assessment and an unavailable one", () => {
    expect(validateMovementAssessment(VALID)).toBe(VALID);
    const absent = unavailable();
    expect(validateMovementAssessment(absent)).toBe(absent);
  });

  it("rejects a non-object assessment without inspecting its fields", () => {
    try {
      validateMovementAssessment(null);
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error.details.issues).toEqual([{ path: "assessment", message: "must be an object" }]);
    }
  });

  it.each([
    ["a different schema version", (a) => { a.schemaVersion = 2; }, "assessment.schemaVersion"],
    ["a malformed instrument ID", (a) => { a.instrumentId = ""; }, "assessment.instrumentId"],
    ["an unsupported status", (a) => { a.status = "partial"; }, "assessment.status"],
    ["a malformed session date", (a) => { a.sessionDate = "20250329"; }, "assessment.sessionDate"],
    ["a different method version", (a) => { a.methodVersion = "movement@0"; }, "assessment.methodVersion"],
    ["a missing quality block", (a) => { a.quality = null; }, "assessment.quality"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(assessmentPaths(mutate)).toContain(path);
  });

  it("reports assessment issues under a caller-supplied path", () => {
    const paths = assessmentPaths((a) => { a.schemaVersion = 9; }, { path: "row" });
    expect(paths).toContain("row.schemaVersion");
  });
});

describe("movement quality validation", () => {
  it.each([
    ["reason codes that are not an array", (a) => { a.quality.reasonCodes = "none"; }, "assessment.quality.reasonCodes"],
    ["an unsupported reason code", (a) => { a.quality.reasonCodes = ["market_closed"]; }, "assessment.quality.reasonCodes[0]"],
    ["duplicate reason codes", (a) => {
      a.quality.reasonCodes = ["stale_input", "stale_input"];
    }, "assessment.quality.reasonCodes[1]"],
    ["warnings that are not an array", (a) => { a.quality.warnings = null; }, "assessment.quality.warnings"],
    ["an unsupported warning", (a) => { a.quality.warnings = ["clock_skew"]; }, "assessment.quality.warnings[0]"],
    ["duplicate warnings", (a) => {
      a.quality.warnings = ["dropped_rows_observed", "dropped_rows_observed"];
    }, "assessment.quality.warnings[1]"],
    ["a fractional expected session count", (a) => { a.quality.expectedSessionCount = 818.5; }, "assessment.quality.expectedSessionCount"],
    ["a negative missing session count", (a) => { a.quality.missingSessionCount = -1; }, "assessment.quality.missingSessionCount"],
    ["a non-integer valid return count", (a) => { a.quality.validReturnCount = "817"; }, "assessment.quality.validReturnCount"],
    ["a missing rate above one", (a) => { a.quality.missingRate = 1.5; }, "assessment.quality.missingRate"],
    ["a malformed latest asset session", (a) => { a.quality.latestAssetSession = "2025-03-32"; }, "assessment.quality.latestAssetSession"],
    ["a malformed latest benchmark session", (a) => { a.quality.latestBenchmarkSession = 20250329; }, "assessment.quality.latestBenchmarkSession"],
    ["a non-string history source", (a) => { a.quality.historySource = 7; }, "assessment.quality.historySource"],
    ["a non-string adjustment mode", (a) => { a.quality.adjustmentMode = false; }, "assessment.quality.adjustmentMode"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(assessmentPaths(mutate)).toContain(path);
  });

  it("accepts a null latest session on an unavailable assessment", () => {
    const absent = unavailable((a) => {
      a.quality.latestAssetSession = null;
      a.quality.latestBenchmarkSession = null;
      a.quality.historySource = null;
      a.quality.adjustmentMode = null;
    });
    expect(validateMovementAssessment(absent)).toBe(absent);
  });

  it("rejects more missing sessions than expected sessions", () => {
    const paths = assessmentPaths((a) => {
      a.quality.expectedSessionCount = 10;
      a.quality.missingSessionCount = 11;
    });
    expect(paths).toContain("assessment.quality.missingSessionCount");
  });

  it("rejects a missing rate that contradicts the session counts", () => {
    const paths = assessmentPaths((a) => { a.quality.missingRate = 0.5; });
    expect(paths).toContain("assessment.quality.missingRate");
  });
});

describe("movement session grid validation", () => {
  it.each([
    ["a non-object grid", (a) => { a.quality.sessionGrid = "US_EQUITIES_CORE"; }, "assessment.quality.sessionGrid"],
    ["a different calendar", (a) => { a.quality.sessionGrid.calendarId = "XNYS"; }, "assessment.quality.sessionGrid.calendarId"],
    ["a blank source", (a) => { a.quality.sessionGrid.source = "   "; }, "assessment.quality.sessionGrid.source"],
    ["a non-string revision", (a) => { a.quality.sessionGrid.revision = 1; }, "assessment.quality.sessionGrid.revision"],
    ["a missing time zone", (a) => { a.quality.sessionGrid.timeZone = ""; }, "assessment.quality.sessionGrid.timeZone"],
    ["a malformed grid start", (a) => { a.quality.sessionGrid.startSessionDate = "2023-1-02"; }, "assessment.quality.sessionGrid.startSessionDate"],
    ["a single-session grid", (a) => { a.quality.sessionGrid.sessionCount = 1; }, "assessment.quality.sessionGrid.sessionCount"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(assessmentPaths(mutate)).toContain(path);
  });

  it("rejects a grid that does not move forward", () => {
    const paths = assessmentPaths((a) => {
      a.quality.sessionGrid.startSessionDate = a.quality.sessionGrid.endSessionDate;
    });
    expect(paths).toContain("assessment.quality.sessionGrid.startSessionDate");
  });

  it("accepts a null grid on an unavailable assessment", () => {
    const absent = unavailable((a) => { a.quality.sessionGrid = null; });
    expect(validateMovementAssessment(absent)).toBe(absent);
  });
});

describe("available assessment cross-checks", () => {
  it.each([
    ["a null session date", (a) => { a.sessionDate = null; }, "assessment.sessionDate"],
    ["reason codes alongside a result", (a) => { a.quality.reasonCodes = ["stale_input"]; }, "assessment.quality.reasonCodes"],
    ["a history source other than yahoo", (a) => { a.quality.historySource = "finnhub"; }, "assessment.quality.historySource"],
    ["an unadjusted history", (a) => { a.quality.adjustmentMode = "raw"; }, "assessment.quality.adjustmentMode"],
    ["a latest asset session behind the assessed one", (a) => { a.quality.latestAssetSession = "2025-03-28"; }, "assessment.quality"],
    ["a missing session grid", (a) => { a.quality.sessionGrid = null; }, "assessment.quality.sessionGrid"],
    ["a grid ending away from the assessed session", (a) => {
      a.quality.sessionGrid.endSessionDate = "2025-03-28";
    }, "assessment.quality.sessionGrid.endSessionDate"],
    ["a grid length that disagrees with the expected count", (a) => {
      a.quality.sessionGrid.sessionCount = 800;
    }, "assessment.quality.sessionGrid.sessionCount"],
    ["a prior score count below the reference window", (a) => { a.quality.priorScoreCount = 700; }, "assessment.quality.priorScoreCount"],
    ["a forecast for the benchmark instead of the asset", (a) => {
      a.instrumentId = "ARCX:SPY";
      a.forecast.instrumentId = "ARCX:SPY";
      a.evidence.instrumentId = "ARCX:SPY";
    }, "assessment.forecast.instrumentId"],
    ["a forecast for a different instrument", (a) => { a.forecast.instrumentId = "XNAS:MSFT"; }, "assessment.instrumentId"],
    ["evidence for a different session", (a) => { a.evidence.sessionDate = "2025-03-28"; }, "assessment.sessionDate"],
    ["no forecast at all", (a) => { a.forecast = null; }, "assessment.forecast"],
    ["no evidence at all", (a) => { a.evidence = null; }, "assessment.evidence"],
  ])("rejects %s", (_label, mutate, path) => {
    expect(assessmentPaths(mutate)).toContain(path);
  });

  it("rejects a forecast origin that evidence does not share", () => {
    const paths = assessmentPaths((a) => {
      a.forecast.originSessionDate = "2025-03-27";
      a.forecast.informationSetEnd = "2025-03-27";
    });
    expect(paths).toContain("assessment.forecast.originSessionDate");
  });

  it("rejects a standardized return not produced by the attached forecast", () => {
    const paths = assessmentPaths((a) => {
      a.evidence.standardizedReturn = -0.5;
      a.evidence.absoluteStandardizedReturn = 0.5;
    });
    expect(paths).toContain("assessment.evidence.standardizedReturn");
  });
});

describe("unavailable assessment cross-checks", () => {
  it.each([
    ["a forecast", (a) => { a.forecast = VALID.forecast; }, "assessment.forecast"],
    ["evidence", (a) => { a.evidence = VALID.evidence; }, "assessment.evidence"],
    ["no reason codes", (a) => { a.quality.reasonCodes = []; }, "assessment.quality.reasonCodes"],
    ["reason codes of the wrong type", (a) => { a.quality.reasonCodes = null; }, "assessment.quality.reasonCodes"],
  ])("rejects an unavailable assessment carrying %s", (_label, mutate, path) => {
    const candidate = unavailable(mutate);
    try {
      validateMovementAssessment(candidate);
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error.details.issues.map((issue) => issue.path)).toContain(path);
    }
  });
});
