import { describe, expect, it } from "vitest";
import {
  QLIKE_VARIANCE_DEFINITION,
  qlikeVarianceLoss,
  summarizeRarityDistribution,
} from "../../../server/analytics/evaluation/scoring.js";

describe("movement evaluation scoring", () => {
  it("computes the declared finite Gaussian QLIKE by hand", () => {
    const forecastVariance = 0.04;
    const realizedReturn = 0.1;
    const expected = Math.log(0.04) + 0.1 ** 2 / 0.04;

    expect(QLIKE_VARIANCE_DEFINITION)
      .toBe("log(forecastVariance) + realizedReturn^2 / forecastVariance");
    expect(qlikeVarianceLoss({
      forecastVariance,
      realizedReturn,
    })).toBeCloseTo(expected, 15);
    expect(qlikeVarianceLoss({
      forecastVariance,
      realizedReturn: 0,
    })).toBe(Math.log(forecastVariance));
  });

  it("rejects inputs that could create NaN or Infinity", () => {
    expect(() => qlikeVarianceLoss({
      forecastVariance: 0,
      realizedReturn: 0.1,
    })).toThrow(TypeError);
    expect(() => qlikeVarianceLoss({
      forecastVariance: Number.POSITIVE_INFINITY,
      realizedReturn: 0.1,
    })).toThrow(TypeError);
    expect(() => qlikeVarianceLoss({
      forecastVariance: 0.04,
      realizedReturn: Number.NaN,
    })).toThrow(TypeError);
  });

  it("summarizes rarity with deterministic interpolated quantiles", () => {
    expect(summarizeRarityDistribution([100, 0, 75, 25, 50]))
      .toEqual({
        count: 5,
        minimum: 0,
        p10: 10,
        p25: 25,
        median: 50,
        p75: 75,
        p90: 90,
        maximum: 100,
        mean: 50,
      });
    expect(summarizeRarityDistribution([])).toBeNull();
  });
});
