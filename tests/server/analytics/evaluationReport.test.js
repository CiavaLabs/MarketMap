import { describe, expect, it } from "vitest";
import {
  buildMovementEvaluationReport,
} from "../../../server/analytics/evaluation/evaluationReport.js";
import {
  evaluateMovementWalkForward,
} from "../../../server/analytics/evaluation/walkForward.js";
import { movementFixture } from "./fixtures.js";

function evaluationFor(instrumentId, { withGap = false } = {}) {
  const fixture = movementFixture(830);
  fixture.assetSeries.instrumentId = instrumentId;
  fixture.assetSeries.provenance.providerSymbol = instrumentId.split(":").at(-1);
  if (withGap) fixture.assetSeries.bars.splice(822, 1);
  return evaluateMovementWalkForward(fixture);
}

describe("movement evaluation summary", () => {
  it("reports finite QLIKE, rarity distribution, and failures per asset and subperiod", () => {
    const aapl = evaluationFor("XNAS:AAPL", { withGap: true });
    const msft = evaluationFor("XNAS:MSFT");
    const failedDates = aapl.records
      .filter(({ status }) => status === "failed")
      .map(({ sessionDate }) => sessionDate);
    const report = buildMovementEvaluationReport({
      evaluations: [msft, aapl],
      subperiods: [
        {
          id: "failed_window",
          startSessionDate: failedDates[0],
          endSessionDate: failedDates.at(-1),
        },
        {
          id: "full_sample",
          startSessionDate: null,
          endSessionDate: null,
        },
      ],
    });

    expect(report.assets.map(({ instrumentId }) => instrumentId))
      .toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
    const aaplReport = report.assets[0];
    expect(aaplReport).toMatchObject({
      status: "available",
      failureReasons: [],
    });
    const full = aaplReport.subperiods
      .find(({ id }) => id === "full_sample");
    const failedWindow = aaplReport.subperiods
      .find(({ id }) => id === "failed_window");
    const scoredLosses = aapl.records
      .filter(({ status }) => status === "scored")
      .map(({ qlikeLoss }) => qlikeLoss);
    const manualMean = scoredLosses
      .reduce((total, value) => total + value, 0) / scoredLosses.length;

    expect(full.count).toEqual({
      candidateSessions: 14,
      scoredSessions: 12,
      failedSessions: 2,
    });
    expect(full.loss.mean).toBeCloseTo(manualMean, 15);
    expect(full.rarityDistribution.count).toBe(12);
    expect(full.failureReasons).toEqual([{
      reason: "missing_or_invalid_realized_return",
      count: 2,
    }]);
    expect(failedWindow.count).toEqual({
      candidateSessions: 2,
      scoredSessions: 0,
      failedSessions: 2,
    });
    expect(failedWindow.loss).toBeNull();
    expect(failedWindow.rarityDistribution).toBeNull();
  });

  it("is JSON-serializable and stable under evaluation input ordering", () => {
    const aapl = evaluationFor("XNAS:AAPL");
    const msft = evaluationFor("XNAS:MSFT");
    const first = buildMovementEvaluationReport({
      evaluations: [aapl, msft],
    });
    const reversed = buildMovementEvaluationReport({
      evaluations: [msft, aapl],
    });

    expect(reversed).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("declares the ex-post universe and the scope of the summary in the artifact", () => {
    const report = buildMovementEvaluationReport({
      evaluations: [evaluationFor("XNAS:AAPL")],
    });
    expect(report.limitations).toEqual({
      universeSelection: "ex_post_selected_universe_survivorship_biased",
      transferability: "not_transferable_to_a_randomly_selected_universe",
      expectedRateReadout: "read_recent_subperiod_not_full_sample_aggregate",
      sampleStartPolicy: "later_of_first_observed_coverage",
      sampleStartEvidence: "first_observed_bar_does_not_certify_listing_or_coverage",
      scope: "descriptive_summary_not_model_comparison_calibration_or_utility",
    });
    expect(JSON.parse(JSON.stringify(report)).limitations).toEqual(report.limitations);
  });

  it("keeps input-quality failures visible instead of producing a calibration", () => {
    const fixture = movementFixture(830);
    fixture.assetSeries.quality = "stale";
    fixture.assetSeries.dataQuality.status = "usable_with_warnings";
    fixture.assetSeries.dataQuality.issues.push({
      code: "stale_last_known_good",
      severity: "warning",
      field: null,
    });
    const evaluation = evaluateMovementWalkForward(fixture);
    const report = buildMovementEvaluationReport({
      evaluations: [evaluation],
    });

    expect(report.assets[0]).toMatchObject({
      status: "unavailable",
      failureReasons: expect.arrayContaining(["stale_input"]),
      subperiods: [{
        count: {
          candidateSessions: 0,
          scoredSessions: 0,
          failedSessions: 0,
        },
        loss: null,
        rarityDistribution: null,
      }],
    });
  });

  it("rejects malformed evaluation records instead of summarizing them", () => {
    const wrongIdentity = structuredClone(evaluationFor("XNAS:AAPL"));
    wrongIdentity.records[0].instrumentId = "XNAS:MSFT";
    const wrongLoss = structuredClone(evaluationFor("XNAS:AAPL"));
    wrongLoss.records[0].qlikeLoss += 1;
    const offRankGrid = structuredClone(evaluationFor("XNAS:AAPL"));
    offRankGrid.records[0].empiricalExceedanceRate = 0.5;
    offRankGrid.records[0].historicalRarityPercentile = 50;

    expect(() => buildMovementEvaluationReport({
      evaluations: [wrongIdentity],
    })).toThrow(/identity or chronology/u);
    expect(() => buildMovementEvaluationReport({
      evaluations: [wrongLoss],
    })).toThrow(/inconsistent scoring/u);
    expect(() => buildMovementEvaluationReport({
      evaluations: [offRankGrid],
    })).toThrow(/invalid scored values/u);
  });
});
