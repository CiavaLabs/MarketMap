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
  MOVEMENT_METHOD_VERSION,
  MOVEMENT_REQUIRED_VALID_RETURNS,
  MOVEMENT_UNAVAILABLE_REASONS,
} from "./contracts/constants.js";
import { validateMovementAssessment } from "./contracts/validators.js";
import { assessSeriesQuality } from "./data/assessSeriesQuality.js";
import { computeEwmaForecastPath } from "./quant/ewma.js";
import { empiricalExceedance } from "./quant/empirical.js";
import { buildAdjacentReturns } from "./quant/returns.js";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function orderedReasons(values) {
  const set = new Set(values);
  return MOVEMENT_UNAVAILABLE_REASONS.filter((reason) => set.has(reason));
}

function qualityPayload({
  assessment,
  validReturnCount,
  priorScoreCount,
  reasonCodes,
}) {
  return {
    reasonCodes: orderedReasons(reasonCodes),
    warnings: assessment.warnings,
    expectedSessionCount: assessment.diagnostics.expectedSessionCount,
    missingSessionCount: assessment.diagnostics.missingSessionCount,
    missingRate: assessment.diagnostics.missingRate,
    validReturnCount,
    priorScoreCount,
    latestAssetSession: assessment.diagnostics.latestAssetSession,
    latestBenchmarkSession: assessment.diagnostics.latestBenchmarkSession,
    sessionGrid: assessment.diagnostics.sessionGrid,
    historySource: null,
    adjustmentMode: null,
  };
}

function unavailable({
  instrumentId,
  sessionDate,
  seriesAssessment,
  validReturnCount = 0,
  priorScoreCount = 0,
  reasonCodes,
  historySource,
  adjustmentMode,
}) {
  const quality = qualityPayload({
    assessment: seriesAssessment,
    validReturnCount,
    priorScoreCount,
    reasonCodes,
  });
  quality.historySource = historySource;
  quality.adjustmentMode = adjustmentMode;
  return validateMovementAssessment({
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    instrumentId,
    sessionDate,
    status: "unavailable",
    forecast: null,
    evidence: null,
    quality,
    methodVersion: MOVEMENT_METHOD_VERSION,
  });
}

export function computeMovementAssessment({
  assetSeries,
  benchmarkSeries,
  sessionGrid,
} = {}) {
  if (!assetSeries?.instrumentId) {
    throw new TypeError("assetSeries.instrumentId is required");
  }
  const instrumentId = assetSeries.instrumentId;
  const historySource = typeof assetSeries.provenance?.source === "string"
    ? assetSeries.provenance.source
    : null;
  const adjustmentMode = typeof assetSeries.priceBasis === "string"
    ? assetSeries.priceBasis
    : null;
  const seriesAssessment = assessSeriesQuality({
    assetSeries,
    benchmarkSeries,
    sessionGrid,
  });
  const sessionDate = seriesAssessment.diagnostics.latestBenchmarkSession;

  if (!seriesAssessment.alignment || !seriesAssessment.eligible) {
    return unavailable({
      instrumentId,
      sessionDate,
      seriesAssessment,
      reasonCodes: seriesAssessment.reasonCodes,
      historySource,
      adjustmentMode,
    });
  }

  const returnRows = buildAdjacentReturns(seriesAssessment.alignment.rows);
  const logReturns = returnRows.map(({ logReturn }) => logReturn);
  const validReturnCount = logReturns.filter(finite).length;
  const path = computeEwmaForecastPath(logReturns);
  const currentIndex = returnRows.length - 1;
  const currentReturn = returnRows[currentIndex] || null;
  const currentForecast = path.forecasts[currentIndex] || null;
  const priorScores = path.forecasts
    .slice(0, Math.max(currentIndex, 0))
    .map((forecast, index) => ({
      sessionDate: returnRows[index]?.sessionDate || null,
      score: forecast?.standardizedReturn,
    }))
    .filter(({ score }) => finite(score))
    .slice(-EMPIRICAL_REFERENCE_SCORES);
  const reasonCodes = [];

  if (validReturnCount < MOVEMENT_REQUIRED_VALID_RETURNS) {
    reasonCodes.push("insufficient_valid_returns");
  }
  if (path.status === "degenerate_variance") {
    reasonCodes.push("degenerate_variance");
  }
  if ((!currentForecast
    || !finite(currentForecast.variance)
    || !finite(currentForecast.dailyVolatility)
    || !finite(currentForecast.standardizedReturn)
    || !finite(currentReturn?.simpleReturn)
    || !finite(currentReturn?.logReturn))
    && path.status !== "degenerate_variance"
    && path.status !== "insufficient_data") {
    reasonCodes.push("non_finite_result");
  }
  if (priorScores.length < EMPIRICAL_REFERENCE_SCORES) {
    reasonCodes.push("insufficient_reference_scores");
  }

  if (reasonCodes.length) {
    return unavailable({
      instrumentId,
      sessionDate,
      seriesAssessment,
      validReturnCount,
      priorScoreCount: priorScores.length,
      reasonCodes,
      historySource,
      adjustmentMode,
    });
  }

  const absoluteStandardizedReturn = Math.abs(currentForecast.standardizedReturn);
  const empirical = empiricalExceedance(
    absoluteStandardizedReturn,
    priorScores.map(({ score }) => Math.abs(score)),
  );
  const forecastOriginSessionDate = currentReturn.previousSessionDate;
  const forecast = {
    instrumentId,
    originSessionDate: forecastOriginSessionDate,
    horizonSessions: 1,
    informationSetEnd: forecastOriginSessionDate,
    variance: currentForecast.variance,
    dailyVolatility: currentForecast.dailyVolatility,
    model: {
      family: "ewma",
      lambda: EWMA_LAMBDA,
      mean: "zero",
      initialization: "zero_mean_second_moment",
      missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
      warmupReturns: EWMA_WARMUP_RETURNS,
      version: EWMA_MODEL_VERSION,
    },
  };
  const evidence = {
    instrumentId,
    sessionDate,
    forecastOriginSessionDate,
    observed: {
      simpleReturn: currentReturn.simpleReturn,
      logReturn: currentReturn.logReturn,
      priceBasis: "provider_adjusted",
    },
    standardizedReturn: currentForecast.standardizedReturn,
    absoluteStandardizedReturn,
    empiricalExceedanceRate: empirical.empiricalExceedanceRate,
    historicalRarityPercentile: empirical.historicalRarityPercentile,
    reference: {
      scoreCount: EMPIRICAL_REFERENCE_SCORES,
      startSessionDate: priorScores[0].sessionDate,
      endSessionDate: priorScores.at(-1).sessionDate,
      tail: EMPIRICAL_TAIL,
      tiePolicy: EMPIRICAL_TIE_POLICY,
      correction: EMPIRICAL_CORRECTION,
    },
    methodVersion: MOVEMENT_METHOD_VERSION,
  };
  const quality = qualityPayload({
    assessment: seriesAssessment,
    validReturnCount,
    priorScoreCount: priorScores.length,
    reasonCodes: [],
  });
  quality.historySource = historySource;
  quality.adjustmentMode = adjustmentMode;

  return validateMovementAssessment({
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    instrumentId,
    sessionDate,
    status: "available",
    forecast,
    evidence,
    quality,
    methodVersion: MOVEMENT_METHOD_VERSION,
  });
}
