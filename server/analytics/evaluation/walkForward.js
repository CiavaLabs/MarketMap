import {
  EMPIRICAL_REFERENCE_SCORES,
  EWMA_LAMBDA,
  EWMA_MISSING_RETURN_POLICY,
  EWMA_WARMUP_RETURNS,
} from "../contracts/constants.js";
import { alignDailySeries } from "../data/alignDailySeries.js";
import { assessSeriesQuality } from "../data/assessSeriesQuality.js";
import { sessionDateFromTimestamp } from "../data/sessionDate.js";
import { validateSessionGrid } from "../data/sessionGrid.js";
import { empiricalExceedance } from "../quant/empirical.js";
import { computeEwmaForecastPath } from "../quant/ewma.js";
import { buildAdjacentReturns } from "../quant/returns.js";
import {
  QLIKE_VARIANCE_DEFINITION,
  qlikeVarianceLoss,
} from "./scoring.js";

export const MOVEMENT_EVALUATION_METHOD = Object.freeze({
  version: "movement-evaluation-ewma@1",
  family: "ewma",
  lambda: EWMA_LAMBDA,
  mean: "zero",
  initialization: "zero_mean_second_moment",
  missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
  warmupReturns: EWMA_WARMUP_RETURNS,
  referenceScoreCount: EMPIRICAL_REFERENCE_SCORES,
  forecastHorizonSessions: 1,
  informationPolicy: "through_previous_session",
  sampleStartPolicy: "later_of_first_observed_coverage",
  primaryLoss: "qlike_variance",
  primaryLossDefinition: QLIKE_VARIANCE_DEFINITION,
});

export const MOVEMENT_EVALUATION_FAILURE_REASONS = Object.freeze([
  "insufficient_reference_scores",
  "missing_or_invalid_realized_return",
  "missing_or_invalid_forecast",
  "non_finite_standardized_return",
  "non_finite_qlike_loss",
]);

const FIRST_EVALUATION_RETURN_INDEX =
  MOVEMENT_EVALUATION_METHOD.warmupReturns
  + MOVEMENT_EVALUATION_METHOD.referenceScoreCount;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requireHistorySeries(series, label) {
  if (!series || typeof series !== "object" || Array.isArray(series)) {
    throw new TypeError(`${label} must be a history series`);
  }
  if (!Array.isArray(series.bars)) {
    throw new TypeError(`${label}.bars must be an array`);
  }
}

function firstSessionDate(series) {
  const first = series.bars[0];
  if (!first) return null;
  return sessionDateFromTimestamp(first.timestamp, series.session?.timezone);
}

function trimLeadingBars(series, analysisStartSessionDate) {
  return {
    ...series,
    bars: series.bars.filter((bar) => (
      sessionDateFromTimestamp(bar.timestamp, series.session?.timezone)
        >= analysisStartSessionDate
    )),
  };
}

function prepareEvaluationSample(assetSeries, benchmarkSeries, sessionGrid) {
  try {
    const grid = validateSessionGrid(sessionGrid);
    const assetStart = firstSessionDate(assetSeries);
    const benchmarkStart = firstSessionDate(benchmarkSeries);
    if (!assetStart || !benchmarkStart) {
      return {
        assetSeries,
        benchmarkSeries,
        sessionGrid: grid,
        analysisStartSessionDate: null,
      };
    }
    const analysisStartSessionDate = assetStart > benchmarkStart
      ? assetStart
      : benchmarkStart;
    return {
      assetSeries: trimLeadingBars(assetSeries, analysisStartSessionDate),
      benchmarkSeries: trimLeadingBars(
        benchmarkSeries,
        analysisStartSessionDate,
      ),
      sessionGrid: {
        ...grid,
        sessionDates: grid.sessionDates.filter((sessionDate) => (
          sessionDate >= analysisStartSessionDate
        )),
      },
      analysisStartSessionDate,
    };
  } catch {
    return {
      assetSeries,
      benchmarkSeries,
      sessionGrid,
      analysisStartSessionDate: null,
    };
  }
}

function failedRecord({
  instrumentId,
  sessionDate,
  originSessionDate,
  failureReasons,
}) {
  return {
    instrumentId,
    sessionDate,
    originSessionDate,
    informationSetEnd: originSessionDate,
    status: "failed",
    failureReasons: MOVEMENT_EVALUATION_FAILURE_REASONS
      .filter((reason) => failureReasons.includes(reason)),
  };
}

function buildFiniteScoreIndex(forecasts, returnRows) {
  const finiteScores = [];
  const finiteCountBefore = new Array(forecasts.length + 1);
  finiteCountBefore[0] = 0;
  for (let index = 0; index < forecasts.length; index += 1) {
    const score = forecasts[index]?.standardizedReturn;
    if (finite(score)) {
      finiteScores.push({
        sessionDate: returnRows[index]?.sessionDate || null,
        score,
      });
    }
    finiteCountBefore[index + 1] = finiteScores.length;
  }
  return { finiteScores, finiteCountBefore };
}

function referenceScoresBefore(scoreIndex, currentIndex) {
  const priorCount = scoreIndex.finiteCountBefore[currentIndex];
  return scoreIndex.finiteScores.slice(
    Math.max(0, priorCount - MOVEMENT_EVALUATION_METHOD.referenceScoreCount),
    priorCount,
  );
}

export function evaluateMovementWalkForward({
  assetSeries,
  benchmarkSeries,
  sessionGrid,
} = {}) {
  requireHistorySeries(assetSeries, "assetSeries");
  requireHistorySeries(benchmarkSeries, "benchmarkSeries");
  if (typeof assetSeries.instrumentId !== "string"
    || !assetSeries.instrumentId.length) {
    throw new TypeError("assetSeries.instrumentId is required");
  }

  const sample = prepareEvaluationSample(
    assetSeries,
    benchmarkSeries,
    sessionGrid,
  );
  const inputQuality = assessSeriesQuality({
    assetSeries: sample.assetSeries,
    benchmarkSeries: sample.benchmarkSeries,
    sessionGrid: sample.sessionGrid,
  });
  if (!inputQuality.eligible) {
    return {
      schemaVersion: 1,
      evaluationKind: "movement_walk_forward",
      instrumentId: assetSeries.instrumentId,
      status: "unavailable",
      failureReasons: inputQuality.reasonCodes,
      analysisStartSessionDate: sample.analysisStartSessionDate,
      method: MOVEMENT_EVALUATION_METHOD,
      candidateSessionCount: 0,
      records: [],
    };
  }

  const alignment = inputQuality.alignment
    || alignDailySeries({
      assetSeries: sample.assetSeries,
      benchmarkSeries: sample.benchmarkSeries,
      sessionGrid: sample.sessionGrid,
    });
  const returnRows = buildAdjacentReturns(alignment.rows);
  const logReturns = returnRows.map(({ logReturn }) => logReturn);
  const path = computeEwmaForecastPath(logReturns, {
    lambda: MOVEMENT_EVALUATION_METHOD.lambda,
    warmupReturns: MOVEMENT_EVALUATION_METHOD.warmupReturns,
  });
  const scoreIndex = buildFiniteScoreIndex(path.forecasts, returnRows);
  const records = [];

  for (
    let currentIndex = FIRST_EVALUATION_RETURN_INDEX;
    currentIndex < returnRows.length;
    currentIndex += 1
  ) {
    const currentReturn = returnRows[currentIndex];
    const currentForecast = path.forecasts[currentIndex];
    const originSessionDate = currentReturn?.previousSessionDate || null;
    const sessionDate = currentReturn?.sessionDate || null;
    const failureReasons = [];
    const priorScores = referenceScoresBefore(scoreIndex, currentIndex);

    if (priorScores.length < MOVEMENT_EVALUATION_METHOD.referenceScoreCount) {
      failureReasons.push("insufficient_reference_scores");
    }
    if (!finite(currentReturn?.logReturn)) {
      failureReasons.push("missing_or_invalid_realized_return");
    }
    if (!finite(currentForecast?.variance)
      || currentForecast.variance <= 0) {
      failureReasons.push("missing_or_invalid_forecast");
    }
    if (currentForecast
      && currentForecast.standardizedReturn !== null
      && !finite(currentForecast.standardizedReturn)) {
      failureReasons.push("non_finite_standardized_return");
    }

    if (failureReasons.length) {
      records.push(failedRecord({
        instrumentId: assetSeries.instrumentId,
        sessionDate,
        originSessionDate,
        failureReasons,
      }));
      continue;
    }

    let qlikeLoss;
    try {
      qlikeLoss = qlikeVarianceLoss({
        forecastVariance: currentForecast.variance,
        realizedReturn: currentReturn.logReturn,
      });
    } catch {
      records.push(failedRecord({
        instrumentId: assetSeries.instrumentId,
        sessionDate,
        originSessionDate,
        failureReasons: ["non_finite_qlike_loss"],
      }));
      continue;
    }

    const absoluteStandardizedReturn =
      Math.abs(currentForecast.standardizedReturn);
    const empirical = empiricalExceedance(
      absoluteStandardizedReturn,
      priorScores.map(({ score }) => Math.abs(score)),
    );
    const record = {
      instrumentId: assetSeries.instrumentId,
      sessionDate,
      originSessionDate,
      informationSetEnd: originSessionDate,
      status: "scored",
      forecastVariance: currentForecast.variance,
      realizedLogReturn: currentReturn.logReturn,
      realizedSquaredReturn: currentReturn.logReturn ** 2,
      qlikeLoss,
      standardizedReturn: currentForecast.standardizedReturn,
      absoluteStandardizedReturn,
      empiricalExceedanceRate: empirical.empiricalExceedanceRate,
      historicalRarityPercentile: empirical.historicalRarityPercentile,
      reference: {
        scoreCount: MOVEMENT_EVALUATION_METHOD.referenceScoreCount,
        startSessionDate: priorScores[0].sessionDate,
        endSessionDate: priorScores.at(-1).sessionDate,
      },
    };
    const numericValues = [
      record.forecastVariance,
      record.realizedLogReturn,
      record.realizedSquaredReturn,
      record.qlikeLoss,
      record.standardizedReturn,
      record.absoluteStandardizedReturn,
      record.empiricalExceedanceRate,
      record.historicalRarityPercentile,
    ];
    if (numericValues.some((value) => !finite(value))) {
      records.push(failedRecord({
        instrumentId: assetSeries.instrumentId,
        sessionDate,
        originSessionDate,
        failureReasons: ["non_finite_qlike_loss"],
      }));
      continue;
    }
    records.push(record);
  }

  return {
    schemaVersion: 1,
    evaluationKind: "movement_walk_forward",
    instrumentId: assetSeries.instrumentId,
    status: "available",
    failureReasons: [],
    analysisStartSessionDate: sample.analysisStartSessionDate,
    method: MOVEMENT_EVALUATION_METHOD,
    candidateSessionCount: records.length,
    records,
  };
}
