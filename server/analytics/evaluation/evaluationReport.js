import { isSessionDate } from "../data/sessionDate.js";
import {
  QLIKE_VARIANCE_DEFINITION,
  qlikeVarianceLoss,
  summarizeRarityDistribution,
} from "./scoring.js";
import {
  MOVEMENT_EVALUATION_FAILURE_REASONS,
  MOVEMENT_EVALUATION_METHOD,
} from "./walkForward.js";

export const MOVEMENT_EVALUATION_LIMITATIONS = Object.freeze({
  universeSelection: "ex_post_selected_universe_survivorship_biased",
  transferability: "not_transferable_to_a_randomly_selected_universe",
  expectedRateReadout: "read_recent_subperiod_not_full_sample_aggregate",
  sampleStartPolicy: MOVEMENT_EVALUATION_METHOD.sampleStartPolicy,
  sampleStartEvidence: "first_observed_bar_does_not_certify_listing_or_coverage",
  scope: "descriptive_summary_not_model_comparison_calibration_or_utility",
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function byteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireEvaluation(evaluation, index) {
  if (!evaluation
    || typeof evaluation !== "object"
    || Array.isArray(evaluation)
    || evaluation.schemaVersion !== 1
    || evaluation.evaluationKind !== "movement_walk_forward"
    || typeof evaluation.instrumentId !== "string"
    || !["available", "unavailable"].includes(evaluation.status)
    || !Array.isArray(evaluation.failureReasons)
    || !Array.isArray(evaluation.records)
    || !Number.isInteger(evaluation.candidateSessionCount)
    || evaluation.candidateSessionCount !== evaluation.records.length
    || (evaluation.analysisStartSessionDate !== null
      && !isSessionDate(evaluation.analysisStartSessionDate))) {
    throw new TypeError(`evaluations[${index}] must be a movement evaluation`);
  }
  if (JSON.stringify(evaluation.method) !== JSON.stringify(MOVEMENT_EVALUATION_METHOD)) {
    throw new TypeError(`evaluations[${index}] must use the fixed movement method`);
  }
  if (evaluation.status === "unavailable") {
    if (!evaluation.failureReasons.length || evaluation.records.length) {
      throw new TypeError(
        `evaluations[${index}] unavailable input must have reasons and no records`,
      );
    }
  } else if (evaluation.failureReasons.length) {
    throw new TypeError(
      `evaluations[${index}] available input must not have input failure reasons`,
    );
  }

  let previousSessionDate = null;
  evaluation.records.forEach((record, recordIndex) => {
    const path = `evaluations[${index}].records[${recordIndex}]`;
    if (!record || typeof record !== "object" || Array.isArray(record)
      || record.instrumentId !== evaluation.instrumentId
      || !isSessionDate(record.sessionDate)
      || !isSessionDate(record.originSessionDate)
      || record.informationSetEnd !== record.originSessionDate
      || record.originSessionDate >= record.sessionDate
      || (previousSessionDate !== null
        && record.sessionDate <= previousSessionDate)
      || !["scored", "failed"].includes(record.status)) {
      throw new TypeError(`${path} has invalid identity or chronology`);
    }
    previousSessionDate = record.sessionDate;

    if (record.status === "failed") {
      if (!Array.isArray(record.failureReasons)
        || !record.failureReasons.length
        || record.failureReasons.some((reason) => (
          !MOVEMENT_EVALUATION_FAILURE_REASONS.includes(reason)
        ))) {
        throw new TypeError(`${path} has invalid failure reasons`);
      }
      return;
    }

    const numericFields = [
      "forecastVariance",
      "realizedLogReturn",
      "realizedSquaredReturn",
      "qlikeLoss",
      "standardizedReturn",
      "absoluteStandardizedReturn",
      "empiricalExceedanceRate",
      "historicalRarityPercentile",
    ];
    const impliedExceedanceRank = record.empiricalExceedanceRate
      * (MOVEMENT_EVALUATION_METHOD.referenceScoreCount + 1);
    const nearestExceedanceRank = Math.round(impliedExceedanceRank);
    if (numericFields.some((field) => !finite(record[field]))
      || record.forecastVariance <= 0
      || record.realizedSquaredReturn < 0
      || record.absoluteStandardizedReturn < 0
      || record.empiricalExceedanceRate <= 0
      || record.empiricalExceedanceRate > 1
      || nearestExceedanceRank < 1
      || nearestExceedanceRank
        > MOVEMENT_EVALUATION_METHOD.referenceScoreCount + 1
      || Math.abs(impliedExceedanceRank - nearestExceedanceRank) > 1e-10
      || record.historicalRarityPercentile < 0
      || record.historicalRarityPercentile > 100) {
      throw new TypeError(`${path} has invalid scored values`);
    }
    const expectedLoss = qlikeVarianceLoss({
      forecastVariance: record.forecastVariance,
      realizedReturn: record.realizedLogReturn,
    });
    const approximately = (left, right) => (
      Math.abs(left - right)
      <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right))
    );
    if (!approximately(record.realizedSquaredReturn, record.realizedLogReturn ** 2)
      || !approximately(record.qlikeLoss, expectedLoss)
      || !approximately(
        record.standardizedReturn,
        record.realizedLogReturn / Math.sqrt(record.forecastVariance),
      )
      || !approximately(
        record.absoluteStandardizedReturn,
        Math.abs(record.standardizedReturn),
      )
      || !approximately(
        record.historicalRarityPercentile,
        100 * (1 - record.empiricalExceedanceRate),
      )) {
      throw new TypeError(`${path} contains internally inconsistent scoring`);
    }
    if (!record.reference
      || record.reference.scoreCount
        !== MOVEMENT_EVALUATION_METHOD.referenceScoreCount
      || !isSessionDate(record.reference.startSessionDate)
      || !isSessionDate(record.reference.endSessionDate)
      || record.reference.startSessionDate >= record.reference.endSessionDate
      || record.reference.endSessionDate > record.informationSetEnd) {
      throw new TypeError(`${path}.reference is invalid`);
    }
  });
}

function normalizedSubperiods(subperiods) {
  if (subperiods === undefined) {
    return [{
      id: "full_sample",
      startSessionDate: null,
      endSessionDate: null,
    }];
  }
  if (!Array.isArray(subperiods) || !subperiods.length) {
    throw new TypeError("subperiods must be a non-empty array");
  }

  const ids = new Set();
  const normalized = subperiods.map((subperiod, index) => {
    if (!subperiod || typeof subperiod !== "object" || Array.isArray(subperiod)) {
      throw new TypeError(`subperiods[${index}] must be an object`);
    }
    if (typeof subperiod.id !== "string" || !subperiod.id.length) {
      throw new TypeError(`subperiods[${index}].id is required`);
    }
    if (ids.has(subperiod.id)) {
      throw new TypeError("subperiod IDs must be unique");
    }
    ids.add(subperiod.id);
    const startSessionDate = subperiod.startSessionDate ?? null;
    const endSessionDate = subperiod.endSessionDate ?? null;
    if (startSessionDate !== null && !isSessionDate(startSessionDate)) {
      throw new TypeError(
        `subperiods[${index}].startSessionDate must be a session date or null`,
      );
    }
    if (endSessionDate !== null && !isSessionDate(endSessionDate)) {
      throw new TypeError(
        `subperiods[${index}].endSessionDate must be a session date or null`,
      );
    }
    if (startSessionDate && endSessionDate
      && startSessionDate > endSessionDate) {
      throw new TypeError(
        `subperiods[${index}] startSessionDate must not follow endSessionDate`,
      );
    }
    return {
      id: subperiod.id,
      startSessionDate,
      endSessionDate,
    };
  });

  return normalized.sort((left, right) => (
    byteOrder(left.startSessionDate || "", right.startSessionDate || "")
      || byteOrder(left.endSessionDate || "", right.endSessionDate || "")
      || byteOrder(left.id, right.id)
  ));
}

function inSubperiod(record, subperiod) {
  return (!subperiod.startSessionDate
      || record.sessionDate >= subperiod.startSessionDate)
    && (!subperiod.endSessionDate
      || record.sessionDate <= subperiod.endSessionDate);
}

function mean(values) {
  if (!values.length) return null;
  const result = values.reduce((total, value) => total + value, 0)
    / values.length;
  if (!finite(result)) {
    throw new RangeError("mean QLIKE loss must be finite");
  }
  return result;
}

function countFailures(records) {
  const counts = new Map();
  for (const record of records) {
    if (record.status !== "failed") continue;
    for (const reason of record.failureReasons || []) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => byteOrder(left, right))
    .map(([reason, count]) => ({ reason, count }));
}

function reportSubperiod(records, subperiod) {
  const selected = records.filter((record) => inSubperiod(record, subperiod));
  const scored = selected.filter((record) => record.status === "scored");
  const failed = selected.filter((record) => record.status === "failed");
  const qlikeLosses = scored.map(({ qlikeLoss }) => qlikeLoss);
  const rarityValues = scored
    .map(({ historicalRarityPercentile }) => historicalRarityPercentile);
  if (qlikeLosses.some((value) => !finite(value))) {
    throw new TypeError("scored records must contain finite QLIKE losses");
  }

  return {
    ...subperiod,
    count: {
      candidateSessions: selected.length,
      scoredSessions: scored.length,
      failedSessions: failed.length,
    },
    loss: scored.length
      ? {
        name: "qlike_variance",
        definition: QLIKE_VARIANCE_DEFINITION,
        mean: mean(qlikeLosses),
      }
      : null,
    rarityDistribution: summarizeRarityDistribution(rarityValues),
    failureReasons: countFailures(failed),
  };
}

export function buildMovementEvaluationReport({
  evaluations,
  subperiods,
} = {}) {
  if (!Array.isArray(evaluations) || !evaluations.length) {
    throw new TypeError("evaluations must be a non-empty array");
  }
  evaluations.forEach(requireEvaluation);
  const periods = normalizedSubperiods(subperiods);
  const byInstrument = new Map();

  for (const evaluation of evaluations) {
    if (byInstrument.has(evaluation.instrumentId)) {
      throw new TypeError(
        `duplicate evaluation for ${evaluation.instrumentId}`,
      );
    }
    byInstrument.set(evaluation.instrumentId, evaluation);
  }

  const assets = [...byInstrument.values()]
    .sort((left, right) => byteOrder(left.instrumentId, right.instrumentId))
    .map((evaluation) => ({
      instrumentId: evaluation.instrumentId,
      status: evaluation.status,
      failureReasons: [...evaluation.failureReasons],
      analysisStartSessionDate: evaluation.analysisStartSessionDate,
      subperiods: periods.map((subperiod) => (
        reportSubperiod(evaluation.records, subperiod)
      )),
    }));

  return {
    schemaVersion: 1,
    reportKind: "movement_evaluation_summary",
    method: MOVEMENT_EVALUATION_METHOD,
    primaryLoss: {
      name: "qlike_variance",
      definition: QLIKE_VARIANCE_DEFINITION,
      aggregation: "arithmetic_mean_over_scored_sessions",
    },
    limitations: MOVEMENT_EVALUATION_LIMITATIONS,
    assets,
  };
}
