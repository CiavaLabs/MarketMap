import { describe, expect, it } from "vitest";
import {
  buildAdjacentReturns,
  calculateLogReturn,
  calculateSimpleReturn,
  computeEwmaForecastPath,
  empiricalExceedance,
  zeroMeanSecondMoment,
} from "../../../server/analytics/index.js";

describe("movement returns", () => {
  it("uses scale-invariant simple and log returns", () => {
    expect(calculateSimpleReturn(100, 105)).toBeCloseTo(0.05, 14);
    expect(calculateSimpleReturn(1_000, 1_050)).toBeCloseTo(0.05, 14);
    expect(calculateLogReturn(100, 105)).toBeCloseTo(Math.log(1.05), 14);
    expect(calculateLogReturn(1_000, 1_050)).toBeCloseTo(Math.log(1.05), 14);
    expect(calculateLogReturn(0, 105)).toBeNull();
  });

  it("never joins prices across a missing benchmark-aligned asset session", () => {
    const rows = [
      { sessionDate: "2026-07-20", assetBar: { adjustedClose: 100 } },
      { sessionDate: "2026-07-21", assetBar: { adjustedClose: 101 } },
      { sessionDate: "2026-07-22", assetBar: null },
      { sessionDate: "2026-07-23", assetBar: { adjustedClose: 110 } },
      { sessionDate: "2026-07-24", assetBar: { adjustedClose: 111 } },
    ];

    const returns = buildAdjacentReturns(rows);

    expect(returns.map(({ logReturn }) => logReturn)).toEqual([
      Math.log(1.01),
      null,
      null,
      Math.log(111 / 110),
    ]);
    expect(returns.slice(1, 3).every(({ reasonCode }) => (
      reasonCode === "missing_asset_session"
    ))).toBe(true);
  });
});

describe("EWMA point-in-time forecast", () => {
  it("initializes with the zero-mean second moment and applies the exact recursion", () => {
    const result = computeEwmaForecastPath(
      [0.1, -0.2, 0.3, null, 0.4],
      { lambda: 0.5, warmupReturns: 2 },
    );

    expect(zeroMeanSecondMoment([0.1, -0.2])).toBeCloseTo(0.025, 15);
    expect(result.initialVariance).toBeCloseTo(0.025, 15);
    expect(result.forecasts.slice(0, 2)).toEqual([null, null]);
    expect(result.forecasts[2].variance).toBeCloseTo(0.025, 15);
    expect(result.forecasts[2].standardizedReturn).toBeCloseTo(
      0.3 / Math.sqrt(0.025),
      15,
    );
    expect(result.forecasts[3]).toMatchObject({
      variance: 0.0575,
      standardizedReturn: null,
    });
    expect(result.forecasts[4].variance).toBeCloseTo(0.0575, 15);
  });

  it("does not let the observed return at t alter its own forecast", () => {
    const first = computeEwmaForecastPath(
      [0.1, -0.2, 0.3],
      { lambda: 0.5, warmupReturns: 2 },
    );
    const changedOutcome = computeEwmaForecastPath(
      [0.1, -0.2, 0.9],
      { lambda: 0.5, warmupReturns: 2 },
    );

    expect(changedOutcome.forecasts[2].variance).toBe(first.forecasts[2].variance);
    expect(changedOutcome.forecasts[2].standardizedReturn)
      .not.toBe(first.forecasts[2].standardizedReturn);
  });

  it("does not change past forecasts when future returns change", () => {
    const original = computeEwmaForecastPath(
      [0.01, -0.02, 0.03, -0.01, 0.02, -0.04],
      { lambda: 0.94, warmupReturns: 2 },
    );
    const changedFuture = computeEwmaForecastPath(
      [0.01, -0.02, 0.03, -0.01, 2, -3],
      { lambda: 0.94, warmupReturns: 2 },
    );

    expect(changedFuture.forecasts.slice(0, 4)).toEqual(original.forecasts.slice(0, 4));
  });

  it("carries conditional variance without imputing a missing outcome", () => {
    const result = computeEwmaForecastPath(
      [0.1, -0.2, 0.3, null, 0.4],
      { lambda: 0.5, warmupReturns: 2 },
    );

    expect(result.forecasts[3].variance).toBe(result.forecasts[4].variance);
    expect(result.forecasts[3].standardizedReturn).toBeNull();
  });

  it("marks an exactly zero initialization variance as unavailable", () => {
    const result = computeEwmaForecastPath([0, 0, 0.1], {
      lambda: 0.94,
      warmupReturns: 2,
    });

    expect(result.status).toBe("degenerate_variance");
    expect(result.initialVariance).toBe(0);
    expect(result.forecasts).toEqual([null, null, null]);
  });
});

describe("empirical historical rank", () => {
  it("uses upper-tail ties and the plus-one correction", () => {
    const result = empiricalExceedance(2, [1, 2, 2, 3]);
    expect(result).toMatchObject({
      exceedanceCount: 3,
      referenceCount: 4,
      empiricalExceedanceRate: 4 / 5,
    });
    expect(result.historicalRarityPercentile).toBeCloseTo(20, 14);
  });

  it("is monotone in the current score for a fixed reference sample", () => {
    const reference = [0.5, 1, 1.5, 2, 3];
    const rates = [0.5, 1, 2, 4]
      .map((score) => empiricalExceedance(score, reference).empiricalExceedanceRate);

    expect(rates).toEqual([...rates].sort((left, right) => right - left));
    expect(empiricalExceedance(10, reference).empiricalExceedanceRate).toBe(1 / 6);
    expect(empiricalExceedance(0, reference).empiricalExceedanceRate).toBe(1);
  });
});
