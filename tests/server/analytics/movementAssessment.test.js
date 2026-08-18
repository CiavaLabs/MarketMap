import { describe, expect, it } from "vitest";
import {
  computeMovementAssessment,
  validateMovementAssessment,
} from "../../../server/analytics/index.js";
import {
  historyFromReturns,
  movementFixture,
  sessionGridFromSeries,
} from "./fixtures.js";

describe("movement-only assessment", () => {
  it("produces a validated forecast and empirical evidence from 817 valid returns", () => {
    const fixture = movementFixture();
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("available");
    expect(validateMovementAssessment(assessment)).toBe(assessment);
    expect(assessment.quality).toMatchObject({
      reasonCodes: [],
      expectedSessionCount: 818,
      missingSessionCount: 0,
      validReturnCount: 817,
      priorScoreCount: 756,
      historySource: "yahoo",
      adjustmentMode: "provider_adjusted",
    });
    expect(assessment.forecast).toMatchObject({
      instrumentId: "XNAS:AAPL",
      horizonSessions: 1,
      informationSetEnd: assessment.forecast.originSessionDate,
      model: {
        family: "ewma",
        lambda: 0.94,
        mean: "zero",
        initialization: "zero_mean_second_moment",
        missingReturnPolicy:
          "conditional_variance_carry_forward_no_return_imputation",
        warmupReturns: 60,
      },
    });
    expect(assessment.evidence).toMatchObject({
      instrumentId: "XNAS:AAPL",
      sessionDate: assessment.sessionDate,
      forecastOriginSessionDate: assessment.forecast.originSessionDate,
      observed: { priceBasis: "provider_adjusted" },
      reference: {
        scoreCount: 756,
        tail: "absolute_two_sided",
        tiePolicy: "greater_than_or_equal",
        correction: "plus_one",
      },
    });
    expect(assessment.evidence.empiricalExceedanceRate).toBeGreaterThanOrEqual(1 / 757);
    expect(assessment.evidence.empiricalExceedanceRate).toBeLessThanOrEqual(1);
  });

  it("keeps a sufficiently old isolated gap unavailable as returns, but can still assess later", () => {
    const fixture = movementFixture(821);
    fixture.assetSeries.bars.splice(100, 1);
    fixture.assetSeries.dataQuality.rowCount -= 1;
    fixture.assetSeries.dataQuality.droppedRows = 1;
    fixture.assetSeries.dataQuality.status = "usable_with_warnings";
    fixture.assetSeries.dataQuality.issues = [{
      code: "row_dropped_invalid_ohlc",
      severity: "warning",
      field: null,
    }];

    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("available");
    expect(assessment.quality).toMatchObject({
      expectedSessionCount: 822,
      missingSessionCount: 1,
      validReturnCount: 819,
      priorScoreCount: 756,
    });
  });

  it("rejects a current or immediately previous missing session", () => {
    const currentGap = movementFixture();
    currentGap.assetSeries.bars.pop();
    currentGap.assetSeries.asOf = currentGap.assetSeries.bars.at(-1).timestamp;
    currentGap.assetSeries.dataQuality.rowCount -= 1;

    const previousGap = movementFixture();
    previousGap.assetSeries.bars.splice(-2, 1);
    previousGap.assetSeries.dataQuality.rowCount -= 1;

    expect(computeMovementAssessment(currentGap).quality.reasonCodes)
      .toContain("missing_current_session");
    expect(computeMovementAssessment(previousGap).quality.reasonCodes)
      .toContain("missing_previous_session");
  });

  it.each([
    ["asset quality", (fixture) => {
      fixture.assetSeries.quality = "stale";
      fixture.assetSeries.dataQuality.status = "usable_with_warnings";
      fixture.assetSeries.dataQuality.issues.push({
        code: "stale_last_known_good",
        severity: "warning",
        field: null,
      });
      fixture.assetSeries.provenance.originalSource = "yahoo";
    }],
    ["benchmark quality", (fixture) => {
      fixture.benchmarkSeries.quality = "stale";
      fixture.benchmarkSeries.dataQuality.status = "usable_with_warnings";
      fixture.benchmarkSeries.dataQuality.issues.push({
        code: "stale_last_known_good",
        severity: "warning",
        field: null,
      });
    }],
  ])("rejects last-known-good %s", (_, mutate) => {
    const fixture = movementFixture();
    mutate(fixture);
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("unavailable");
    expect(assessment.forecast).toBeNull();
    expect(assessment.evidence).toBeNull();
    expect(assessment.quality.reasonCodes).toContain("stale_input");
  });

  it("does not relabel a raw history as adjusted", () => {
    const fixture = movementFixture();
    fixture.assetSeries.priceBasis = "raw";
    fixture.assetSeries.requestedPriceBasis = "raw";
    fixture.assetSeries.adjustment = {
      status: "none",
      includesSplits: false,
      includesDistributions: false,
      formulaVersion: null,
    };
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("unsupported_price_basis");
  });

  it("reports insufficient evidence instead of shrinking the fixed windows", () => {
    const assessment = computeMovementAssessment(movementFixture(816));

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.validReturnCount).toBe(816);
    expect(assessment.quality.priorScoreCount).toBe(755);
    expect(assessment.quality.reasonCodes).toEqual(expect.arrayContaining([
      "insufficient_valid_returns",
      "insufficient_reference_scores",
    ]));
  });

  it("does not mislabel a short warmup as a non-finite numerical failure", () => {
    const assessment = computeMovementAssessment(movementFixture(20));

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("insufficient_valid_returns");
    expect(assessment.quality.reasonCodes).toContain("insufficient_reference_scores");
    expect(assessment.quality.reasonCodes).not.toContain("non_finite_result");
  });

  it("does not manufacture a score from an exactly zero variance", () => {
    const assetSeries = historyFromReturns({
      instrumentId: "XNAS:AAPL",
      assetClass: "equity",
      returns: Array(817).fill(0),
    });
    const benchmarkSeries = historyFromReturns({
      instrumentId: "ARCX:SPY",
      assetClass: "etf",
      returns: Array(817).fill(0.001),
    });
    const assessment = computeMovementAssessment({
      assetSeries,
      benchmarkSeries,
      sessionGrid: sessionGridFromSeries(benchmarkSeries),
    });

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("degenerate_variance");
    expect(assessment.forecast).toBeNull();
    expect(assessment.evidence).toBeNull();
  });

  it("treats an invalid IANA timezone as unavailable data", () => {
    const fixture = movementFixture();
    fixture.assetSeries.session.timezone = "America/Definitely_Not_A_Zone";
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("unavailable");
    expect(assessment.sessionDate).toBeNull();
    expect(assessment.quality.reasonCodes).toContain("invalid_timezone");
  });

  it.each([
    ["invalid", (fixture) => {
      fixture.assetSeries.bars[100].timestamp = "not-a-timestamp";
    }],
    ["out-of-order", (fixture) => {
      fixture.assetSeries.bars[100].timestamp = fixture.assetSeries.bars[99].timestamp;
    }],
  ])("returns unavailable instead of throwing for %s bar timestamps", (_, mutate) => {
    const fixture = movementFixture();
    mutate(fixture);

    expect(() => computeMovementAssessment(fixture)).not.toThrow();
    const assessment = computeMovementAssessment(fixture);
    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("non_monotonic_timestamps");
  });

  it("rejects an as-of timestamp that does not identify the last bar", () => {
    const fixture = movementFixture();
    fixture.assetSeries.asOf = fixture.assetSeries.bars.at(-2).timestamp;
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("as_of_mismatch");
  });

  it("accepts only the declared SPY benchmark grid", () => {
    const fixture = movementFixture();
    fixture.benchmarkSeries.instrumentId = "XNAS:QQQ";
    fixture.benchmarkSeries.provenance.providerSymbol = "QQQ";
    const assessment = computeMovementAssessment(fixture);

    expect(assessment.status).toBe("unavailable");
    expect(assessment.quality.reasonCodes).toContain("unsupported_benchmark");
  });

  it("returns unavailable rather than throwing when the asset is ahead of the certified grid", () => {
    const fixture = movementFixture();
    const extra = structuredClone(fixture.assetSeries.bars.at(-1));
    extra.timestamp = new Date(
      Date.parse(extra.timestamp) + 86_400_000,
    ).toISOString();
    fixture.assetSeries.bars.push(extra);
    fixture.assetSeries.asOf = extra.timestamp;
    fixture.assetSeries.dataQuality.rowCount += 1;

    expect(() => computeMovementAssessment(fixture)).not.toThrow();
    expect(computeMovementAssessment(fixture)).toMatchObject({
      status: "unavailable",
      quality: {
        reasonCodes: expect.arrayContaining(["asset_session_after_grid"]),
      },
    });
  });

  it("rejects non-finite contract mutations", () => {
    const assessment = computeMovementAssessment(movementFixture());
    const invalid = structuredClone(assessment);
    invalid.forecast.variance = Number.NaN;

    expect(() => validateMovementAssessment(invalid)).toThrowError(
      expect.objectContaining({ code: "schema_invalid" }),
    );
  });

  it("rejects reference evidence that extends beyond the forecast information set", () => {
    const invalid = structuredClone(
      computeMovementAssessment(movementFixture()),
    );
    const olderOrigin = invalid.evidence.reference.startSessionDate;
    invalid.forecast.originSessionDate = olderOrigin;
    invalid.forecast.informationSetEnd = olderOrigin;
    invalid.evidence.forecastOriginSessionDate = olderOrigin;

    expect(() => validateMovementAssessment(invalid)).toThrowError(
      expect.objectContaining({ code: "schema_invalid" }),
    );
  });
});
