import { describe, expect, it } from "vitest";
import {
  MOVEMENT_EVALUATION_METHOD,
  evaluateMovementWalkForward,
} from "../../../server/analytics/evaluation/walkForward.js";
import { movementFixture } from "./fixtures.js";

function expectOnlyFiniteNumbers(value) {
  if (typeof value === "number") {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectOnlyFiniteNumbers);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(expectOnlyFiniteNumbers);
  }
}

describe("movement walk-forward evaluation", () => {
  it("uses the frozen baseline and only prior information for every scored t", () => {
    const evaluation = evaluateMovementWalkForward(movementFixture(830));

    expect(evaluation.method).toEqual(MOVEMENT_EVALUATION_METHOD);
    expect(evaluation.method).toMatchObject({
      family: "ewma",
      lambda: 0.94,
      warmupReturns: 60,
      referenceScoreCount: 756,
      missingReturnPolicy:
        "conditional_variance_carry_forward_no_return_imputation",
      informationPolicy: "through_previous_session",
      sampleStartPolicy: "later_of_first_observed_coverage",
      primaryLoss: "qlike_variance",
    });
    expect(evaluation.records).toHaveLength(14);
    expect(evaluation.records.every(({ status }) => status === "scored"))
      .toBe(true);

    for (const record of evaluation.records) {
      expect(record.originSessionDate).toBe(record.informationSetEnd);
      expect(record.originSessionDate < record.sessionDate).toBe(true);
      expect(record.reference.scoreCount).toBe(756);
      expect(record.reference.endSessionDate < record.sessionDate).toBe(true);
      expect(record.empiricalExceedanceRate).toBeGreaterThanOrEqual(1 / 757);
      expect(record.empiricalExceedanceRate).toBeLessThanOrEqual(1);
      expect(record.historicalRarityPercentile).toBeGreaterThanOrEqual(0);
      expect(record.historicalRarityPercentile).toBeLessThanOrEqual(100);
    }
  });

  it("does not change records through T when bars after T are mutated", () => {
    const originalFixture = movementFixture(850);
    const original = evaluateMovementWalkForward(originalFixture);
    const cutoffSessionDate = original.records[10].sessionDate;
    const changedFixture = structuredClone(originalFixture);

    for (const bar of changedFixture.assetSeries.bars) {
      if (bar.timestamp.slice(0, 10) > cutoffSessionDate) {
        bar.adjustedClose *= bar.timestamp.endsWith("000Z") ? 4 : 0.25;
      }
    }

    const changed = evaluateMovementWalkForward(changedFixture);
    const throughCutoff = (evaluation) => evaluation.records
      .filter(({ sessionDate }) => sessionDate <= cutoffSessionDate);

    expect(throughCutoff(changed)).toEqual(throughCutoff(original));
  });

  it("does not let the realized return at t alter its own variance forecast", () => {
    const originalFixture = movementFixture(830);
    const original = evaluateMovementWalkForward(originalFixture);
    const targetSessionDate = original.records[5].sessionDate;
    const changedFixture = structuredClone(originalFixture);
    const targetBar = changedFixture.assetSeries.bars
      .find(({ timestamp }) => timestamp.slice(0, 10) === targetSessionDate);
    targetBar.adjustedClose *= 1.5;

    const changed = evaluateMovementWalkForward(changedFixture);
    const originalTarget = original.records
      .find(({ sessionDate }) => sessionDate === targetSessionDate);
    const changedTarget = changed.records
      .find(({ sessionDate }) => sessionDate === targetSessionDate);

    expect(changedTarget.forecastVariance).toBe(originalTarget.forecastVariance);
    expect(changedTarget.realizedLogReturn)
      .not.toBe(originalTarget.realizedLogReturn);
  });

  it("emits deterministic JSON without NaN or Infinity", () => {
    const fixture = movementFixture(830);
    const first = evaluateMovementWalkForward(fixture);
    const second = evaluateMovementWalkForward(structuredClone(fixture));

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expectOnlyFiniteNumbers(first);
  });

  it("records missing realized sessions as failures without fabricating scores", () => {
    const fixture = movementFixture(830);
    fixture.assetSeries.bars.splice(822, 1);

    const evaluation = evaluateMovementWalkForward(fixture);
    const failed = evaluation.records.filter(({ status }) => status === "failed");

    expect(failed).toHaveLength(2);
    expect(failed.every(({ failureReasons }) => (
      failureReasons.includes("missing_or_invalid_realized_return")
    ))).toBe(true);
    expect(failed.every((record) => !Object.hasOwn(record, "qlikeLoss")))
      .toBe(true);
  });

  it.each([
    ["stale input", (fixture) => {
      fixture.assetSeries.quality = "stale";
      fixture.assetSeries.dataQuality.status = "usable_with_warnings";
      fixture.assetSeries.dataQuality.issues.push({
        code: "stale_last_known_good",
        severity: "warning",
        field: null,
      });
    }, "stale_input"],
    ["raw history", (fixture) => {
      fixture.assetSeries.priceBasis = "raw";
      fixture.assetSeries.requestedPriceBasis = "raw";
      fixture.assetSeries.adjustment = {
        status: "none",
        includesSplits: false,
        includesDistributions: false,
        formulaVersion: null,
      };
    }, "unsupported_price_basis"],
    ["non-daily history", (fixture) => {
      fixture.assetSeries.interval = "1wk";
    }, "unsupported_interval"],
    ["non-SPY benchmark", (fixture) => {
      fixture.benchmarkSeries.instrumentId = "ARCX:QQQ";
    }, "unsupported_benchmark"],
  ])("refuses to calibrate %s", (_, mutate, reason) => {
    const fixture = movementFixture(830);
    mutate(fixture);

    const evaluation = evaluateMovementWalkForward(fixture);

    expect(evaluation).toMatchObject({
      status: "unavailable",
      candidateSessionCount: 0,
      records: [],
      failureReasons: expect.arrayContaining([reason]),
    });
  });

  it.each([
    ["asset inception", "assetSeries", 100],
    ["benchmark inception", "benchmarkSeries", 100],
  ])("starts at the later first-observed %s coverage without classifying it as missing", (
    _,
    trimmedSeries,
    leadingBars,
  ) => {
    const fixture = movementFixture(1_050);
    fixture[trimmedSeries].bars.splice(0, leadingBars);
    fixture[trimmedSeries].dataQuality.rowCount -= leadingBars;
    const expectedStart = fixture[trimmedSeries].bars[0].timestamp.slice(0, 10);

    const evaluation = evaluateMovementWalkForward(fixture);

    expect(evaluation).toMatchObject({
      status: "available",
      failureReasons: [],
      analysisStartSessionDate: expectedStart,
      candidateSessionCount: 134,
    });
    expect(evaluation.records.every(({ sessionDate }) => (
      sessionDate >= expectedStart
    ))).toBe(true);
  });
});
