const EXCEEDANCE = 20 / 757;

export function movementAnalyticsRecord(mutate = () => {}) {
  const value = {
    instrumentId: "XNAS:AAPL",
    runId: `sha256:${"a".repeat(64)}`,
    computedAt: "2026-07-27T23:05:00.000Z",
    assessment: {
      schemaVersion: 1,
      instrumentId: "XNAS:AAPL",
      sessionDate: "2026-07-27",
      status: "available",
      methodVersion: "movement-ewma-empirical@1",
      forecast: {
        instrumentId: "XNAS:AAPL",
        originSessionDate: "2026-07-24",
        informationSetEnd: "2026-07-24",
        horizonSessions: 1,
        variance: 0.00012544,
        dailyVolatility: 0.0112,
        model: {
          family: "ewma",
          lambda: 0.94,
          mean: "zero",
          initialization: "zero_mean_second_moment",
          missingReturnPolicy: "conditional_variance_carry_forward_no_return_imputation",
          warmupReturns: 60,
          version: "ewma-zero-mean@1",
        },
      },
      evidence: {
        instrumentId: "XNAS:AAPL",
        sessionDate: "2026-07-27",
        forecastOriginSessionDate: "2026-07-24",
        observed: { simpleReturn: 0.0234, logReturn: 0.023130, priceBasis: "provider_adjusted" },
        standardizedReturn: 2.0652,
        absoluteStandardizedReturn: 2.0652,
        empiricalExceedanceRate: EXCEEDANCE,
        historicalRarityPercentile: 100 * (1 - EXCEEDANCE),
        reference: {
          scoreCount: 756,
          startSessionDate: "2023-07-25",
          endSessionDate: "2026-07-24",
          tail: "absolute_two_sided",
          tiePolicy: "greater_than_or_equal",
          correction: "plus_one",
        },
        methodVersion: "movement-ewma-empirical@1",
      },
      quality: {
        reasonCodes: [],
        warnings: ["provider_distributions_unknown"],
        expectedSessionCount: 1254,
        missingSessionCount: 3,
        missingRate: 3 / 1254,
        validReturnCount: 1250,
        priorScoreCount: 756,
        latestAssetSession: "2026-07-27",
        latestBenchmarkSession: "2026-07-27",
        sessionGrid: {
          calendarId: "US_EQUITIES_CORE",
          source: "host-calendar",
          revision: "2026-07-28",
          timeZone: "America/New_York",
          startSessionDate: "2021-07-27",
          endSessionDate: "2026-07-27",
          sessionCount: 1254,
        },
        historySource: "yahoo",
        adjustmentMode: "provider_adjusted",
      },
    },
  };
  mutate(value);
  return value;
}
