import { describe, expect, it, vi } from "vitest";

import {
  DAILY_ANALYTICS_CUTOFF_UTC,
  DailyAnalyticsRunner,
} from "../../../server/analytics/DailyAnalyticsRunner.js";
import { analyticsSha256 } from "../../../server/analytics/canonicalDigest.js";
import { AnalyticsEngine } from "../../../server/analytics/AnalyticsEngine.js";
import { InMemoryAnalyticsStore } from "../../../server/analytics/persistence/InMemoryAnalyticsStore.js";
import { movementFixture } from "./fixtures.js";

const AAPL = "XNAS:AAPL";
const MSFT = "XNAS:MSFT";
const SPY = "ARCX:SPY";
const AFTER_CUTOFF = "2026-04-08T23:00:00.000Z";
const SESSION_AUTHORITY = Object.freeze({
  completedSessionDate: "2026-04-08",
  nextSessionDate: "2026-04-09",
});

function sessionAuthority(fixture, overrides = {}) {
  return {
    ...SESSION_AUTHORITY,
    sessionGrid: fixture.sessionGrid,
    ...overrides,
  };
}

function historyService(batchFactory) {
  return {
    getHistoryBatch: vi.fn(async (...args) => batchFactory(...args)),
  };
}

function runner({
  service,
  store = new InMemoryAnalyticsStore(),
  equityInstrumentIds = [AAPL],
  clock = () => new Date(AFTER_CUTOFF),
  engine,
} = {}) {
  return {
    store,
    runner: new DailyAnalyticsRunner({
      historyService: service,
      analyticsStore: store,
      equityInstrumentIds,
      clock,
      ...(engine ? { engine } : {}),
    }),
  };
}

function withInstrument(series, instrumentId) {
  const copy = structuredClone(series);
  copy.instrumentId = instrumentId;
  copy.provenance.providerSymbol = instrumentId.split(":").at(-1);
  return copy;
}

describe("DailyAnalyticsRunner", { timeout: 20_000 }, () => {
  it("caps the explicitly curated equity universe at 40 instruments", () => {
    const service = historyService(() => ({ data: [], errors: [] }));
    const ids = Array.from(
      { length: 41 },
      (_, index) => `XNAS:T${String(index).padStart(2, "0")}`,
    );

    expect(() => runner({ service, equityInstrumentIds: ids })).toThrow(
      /must not exceed 40/u,
    );
    expect(service.getHistoryBatch).not.toHaveBeenCalled();
  });

  it(`refuses an explicit run before ${DAILY_ANALYTICS_CUTOFF_UTC} UTC`, async () => {
    const fixture = movementFixture();
    const service = historyService(() => {
      throw new Error("must not fetch");
    });
    const { runner: dailyRunner } = runner({
      service,
      clock: () => new Date("2026-04-08T22:29:59.999Z"),
    });

    await expect(dailyRunner.run(sessionAuthority(fixture))).rejects.toMatchObject({
      code: "analytics_cutoff_not_reached",
    });
    expect(service.getHistoryBatch).not.toHaveBeenCalled();
  });

  it("records a rejected whole-batch attempt without inventing input records", async () => {
    const fixture = movementFixture();
    const failure = Object.assign(new Error("provider unavailable"), {
      code: "provider_unavailable",
    });
    const service = historyService(() => {
      throw failure;
    });
    const { runner: dailyRunner, store } = runner({ service });

    const summary = await dailyRunner.run(sessionAuthority(fixture));
    const attempt = await store.getRunAttempt(summary.attemptId);

    expect(summary).toMatchObject({
      status: "batch_failed",
      benchmark: {
        instrumentId: SPY,
        status: "failed",
        reasonCodes: ["history_batch_failed"],
        upstreamCode: "provider_unavailable",
      },
      counts: { requested: 1, available: 0, unavailable: 0, failed: 1 },
      results: [{
        instrumentId: AAPL,
        status: "failed",
        reasonCodes: ["history_batch_failed"],
        upstreamCode: "provider_unavailable",
      }],
    });
    expect(attempt).toMatchObject({
      runId: summary.runId,
      status: "batch_failed",
      inputManifest: {
        sessionSentinel: null,
        assets: [],
      },
      failureSummary: {
        benchmark: {
          reasonCodes: ["history_batch_failed"],
          upstreamCode: "provider_unavailable",
        },
      },
    });
    expect(attempt.configSnapshot).toMatchObject({
      analyticsSchemaVersion: 1,
      runnerVersion: "daily-movement-runner@1",
      methodVersion: "movement-ewma-empirical@1",
      cutoffUtc: DAILY_ANALYTICS_CUTOFF_UTC,
      benchmarkInstrumentId: SPY,
      equityInstrumentIds: [AAPL],
      model: {
        ewma: {
          lambda: 0.94,
          missingReturnPolicy:
            "conditional_variance_carry_forward_no_return_imputation",
        },
        empirical: {
          referenceScores: 756,
          tail: "absolute_two_sided",
        },
      },
      sessionGrid: {
        inputHash: summary.sessionGrid.inputHash,
      },
    });
    expect(analyticsSha256(attempt.configSnapshot)).toBe(summary.configHash);
    expect(store.observations.size).toBe(0);
    expect(store.historyManifests.size).toBe(0);
    expect(store.forecasts.size).toBe(0);
    expect(store.assessments.size).toBe(0);
    expect(store.runAttempts.size).toBe(1);
  });

  it("rejects an asset observed after compute time instead of creating look-ahead lineage", async () => {
    const fixture = movementFixture();
    fixture.assetSeries.fetchedAt = "2026-04-08T23:00:02.000Z";
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const clockValues = [
      new Date("2026-04-08T23:00:00.000Z"),
      new Date("2026-04-08T23:00:01.000Z"),
      new Date("2026-04-08T23:00:03.000Z"),
    ];
    const { runner: dailyRunner, store } = runner({
      service,
      clock: () => clockValues.shift(),
    });

    const summary = await dailyRunner.run(sessionAuthority(fixture));
    const attempt = await store.getRunAttempt(summary.attemptId);

    expect(summary).toMatchObject({
      computedAt: "2026-04-08T23:00:01.000Z",
      status: "completed_with_failures",
      benchmark: { status: "available" },
      counts: { requested: 1, available: 0, unavailable: 0, failed: 1 },
      results: [{
        instrumentId: AAPL,
        status: "failed",
        reasonCodes: ["history_fetched_at_after_compute"],
      }],
    });
    expect(attempt).toMatchObject({
      startedAt: "2026-04-08T23:00:00.000Z",
      completedAt: "2026-04-08T23:00:03.000Z",
      inputManifest: { assets: [] },
      failureSummary: {
        results: [{
          instrumentId: AAPL,
          status: "failed",
          reasonCodes: ["history_fetched_at_after_compute"],
        }],
      },
    });
    expect(store.historyManifests.size).toBe(1);
    expect(await store.listAssessments(summary.runId)).toEqual([]);
    expect(store.forecasts.size).toBe(0);
  });

  it("uses the exact daily fetch contract and persists honest backfill records", async () => {
    const fixture = movementFixture();
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const { runner: dailyRunner, store } = runner({ service });
    const appendHistoryInput = vi.spyOn(store, "appendHistoryInput");

    const summary = await dailyRunner.run(sessionAuthority(fixture));

    expect(appendHistoryInput).toHaveBeenCalledTimes(2);
    expect(appendHistoryInput.mock.calls.map(([{ observations, manifest }]) => ({
      instrumentId: manifest.instrumentId,
      observations: observations.length,
    })).sort((left, right) => (
      left.instrumentId.localeCompare(right.instrumentId)
    ))).toEqual([
      { instrumentId: SPY, observations: fixture.benchmarkSeries.bars.length },
      { instrumentId: AAPL, observations: fixture.assetSeries.bars.length },
    ].sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)));
    expect(service.getHistoryBatch).toHaveBeenCalledOnce();
    expect(service.getHistoryBatch).toHaveBeenCalledWith(
      [AAPL, SPY],
      {
        range: "5y",
        interval: "1d",
        priceBasis: "provider_adjusted",
      },
    );
    expect(summary).toMatchObject({
      status: "completed",
      completedSessionDate: SESSION_AUTHORITY.completedSessionDate,
      nextSessionDate: SESSION_AUTHORITY.nextSessionDate,
      sessionGrid: {
        authority: "host_supplied_not_certified_by_runner",
        calendarId: "US_EQUITIES_CORE",
        revision: "fixture@1",
        endSessionDate: SESSION_AUTHORITY.completedSessionDate,
      },
      counts: { requested: 1, available: 1, unavailable: 0, failed: 0 },
      benchmark: {
        instrumentId: SPY,
        status: "available",
        observedSessionDate: SESSION_AUTHORITY.completedSessionDate,
      },
      results: [{ instrumentId: AAPL, status: "available", reasonCodes: [] }],
    });
    expect(() => JSON.stringify(summary)).not.toThrow();

    const [assessmentRecord] = await store.listAssessments(summary.runId);
    expect(assessmentRecord).toMatchObject({
      runId: summary.runId,
      inputHash: summary.results[0].inputHash,
      configHash: summary.configHash,
      assessment: { instrumentId: AAPL, status: "available" },
    });
    const attempt = await store.getRunAttempt(summary.attemptId);
    expect(attempt.inputManifest).toMatchObject({
      sessionGridHash: summary.sessionGrid.inputHash,
      sessionSentinel: {
        instrumentId: SPY,
        seriesHash: summary.benchmark.inputHash,
      },
      missingReturnPolicy:
        "conditional_variance_carry_forward_no_return_imputation",
      historySelection: {
        range: "5y",
        interval: "1d",
        priceBasis: "provider_adjusted",
      },
      assets: [{
        instrumentId: AAPL,
        assessmentInputHash: summary.results[0].inputHash,
      }],
    });
    const assetManifest = await store.getHistoryManifest(
      attempt.inputManifest.assets[0].assetSeriesHash,
    );
    const benchmarkManifest = await store.getHistoryManifest(
      attempt.inputManifest.sessionSentinel.seriesHash,
    );
    expect(assetManifest).toMatchObject({
      instrumentId: AAPL,
      observedAt: fixture.assetSeries.fetchedAt,
      provider: "yahoo",
      providerSymbol: "AAPL",
      assetClass: "equity",
      range: "5y",
      interval: "1d",
      priceBasis: "provider_adjusted",
      sessionGrid: {
        gridHash: summary.sessionGrid.inputHash,
        calendarId: "US_EQUITIES_CORE",
        revision: "fixture@1",
      },
    });
    expect(benchmarkManifest).toMatchObject({
      instrumentId: SPY,
      observedAt: fixture.benchmarkSeries.fetchedAt,
      providerSymbol: "SPY",
      assetClass: "etf",
      sessionGrid: { gridHash: summary.sessionGrid.inputHash },
    });
    expect(await store.listDailyObservationsAsOf({
      instrumentId: AAPL,
      throughObservedAt: assetManifest.fetchCutoff.throughObservedAt,
    })).toHaveLength(fixture.assetSeries.bars.length);
    expect(await store.listDailyObservationsAsOf({
      instrumentId: SPY,
      throughObservedAt: benchmarkManifest.fetchCutoff.throughObservedAt,
    })).toHaveLength(fixture.benchmarkSeries.bars.length);

    const [forecastRecord] = await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: summary.results[0].sessionDate,
    });
    expect(forecastRecord).toMatchObject({
      runId: summary.runId,
      targetSessionDate: summary.results[0].sessionDate,
      informationSetEnd: assessmentRecord.assessment.forecast.informationSetEnd,
      origin: "backfill",
      configHash: summary.configHash,
    });
    expect(forecastRecord.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(forecastRecord.inputHash).not.toBe(summary.results[0].inputHash);
    const [liveForecastRecord] = await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: SESSION_AUTHORITY.nextSessionDate,
    });
    const expectedNextVariance = (
      0.94 * assessmentRecord.assessment.forecast.variance
    ) + (
      0.06 * (assessmentRecord.assessment.evidence.observed.logReturn ** 2)
    );
    expect(liveForecastRecord).toMatchObject({
      runId: summary.runId,
      targetSessionDate: SESSION_AUTHORITY.nextSessionDate,
      informationSetEnd: SESSION_AUTHORITY.completedSessionDate,
      origin: "live",
      configHash: summary.configHash,
      forecast: {
        originSessionDate: SESSION_AUTHORITY.completedSessionDate,
        informationSetEnd: SESSION_AUTHORITY.completedSessionDate,
      },
    });
    expect(liveForecastRecord.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(liveForecastRecord.inputHash).not.toBe(forecastRecord.inputHash);
    expect(liveForecastRecord.forecast.variance).toBeCloseTo(expectedNextVariance, 15);

    const [observation] = await store.listDailyObservations({
      instrumentId: AAPL,
      sessionDate: summary.results[0].sessionDate,
    });
    const lastBar = fixture.assetSeries.bars.at(-1);
    expect(observation).toMatchObject({
      instrumentId: AAPL,
      observedAt: fixture.assetSeries.fetchedAt,
      provider: "yahoo",
      bar: {
        providerClose: lastBar.close,
        providerAdjustedClose: lastBar.adjustedClose,
        providerVolume: lastBar.volume,
      },
    });
    expect(observation.observedAt).not.toBe(summary.computedAt);

    const serialized = JSON.stringify({
      summary,
      assessmentRecord,
      forecastRecord,
      liveForecastRecord,
      observation,
    });
    expect(serialized).not.toMatch(
      /pValue|adjustedQ|benjamini|confidenceInterval|movementTag|alert|volumeStatistic/u,
    );
  });

  it("derives stable hashes and identities so an identical retry appends nothing", async () => {
    const fixture = movementFixture();
    let fetchCount = 0;
    const service = historyService(() => {
      fetchCount += 1;
      const assetSeries = structuredClone(fixture.assetSeries);
      const benchmarkSeries = structuredClone(fixture.benchmarkSeries);
      assetSeries.fetchedAt = `2026-04-08T22:50:0${fetchCount}.000Z`;
      benchmarkSeries.fetchedAt = `2026-04-08T22:50:0${fetchCount}.000Z`;
      return { data: [assetSeries, benchmarkSeries], errors: [] };
    });
    const firstRecordedAt = "2026-04-08T23:00:01.000Z";
    const clockValues = [
      new Date("2026-04-08T23:00:00.000Z"),
      new Date(firstRecordedAt),
      new Date("2026-04-08T23:00:02.000Z"),
      new Date("2026-04-08T23:05:00.000Z"),
      new Date("2026-04-08T23:05:01.000Z"),
      new Date("2026-04-08T23:05:02.000Z"),
    ];
    const { runner: dailyRunner, store } = runner({
      service,
      clock: () => clockValues.shift(),
    });

    const first = await dailyRunner.run(sessionAuthority(fixture));
    const retry = await dailyRunner.run(sessionAuthority(fixture));

    expect(retry.runId).toBe(first.runId);
    expect(retry.configHash).toBe(first.configHash);
    expect(retry.results[0].inputHash).toBe(first.results[0].inputHash);
    expect(retry.benchmark.inputHash).toBe(first.benchmark.inputHash);
    expect(retry.computedAt).not.toBe(first.computedAt);
    expect(first.runId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.configHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    expect(await store.listAssessments(first.runId)).toHaveLength(1);
    expect(await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: first.results[0].sessionDate,
    })).toHaveLength(1);
    const [liveForecast] = await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: SESSION_AUTHORITY.nextSessionDate,
    });
    expect(liveForecast.recordedAt).toBe(firstRecordedAt);
    expect(await store.listDailyObservations({
      instrumentId: AAPL,
      sessionDate: first.results[0].sessionDate,
    })).toHaveLength(1);
    expect(await store.listRunAttempts(first.runId)).toHaveLength(2);
  });

  it("does not revise unchanged bars when only series-level quality changes", async () => {
    const fixture = movementFixture();
    let fetchCount = 0;
    const service = historyService(() => {
      fetchCount += 1;
      const assetSeries = structuredClone(fixture.assetSeries);
      const benchmarkSeries = structuredClone(fixture.benchmarkSeries);
      if (fetchCount === 2) {
        assetSeries.quality = "stale";
        assetSeries.dataQuality.status = "usable_with_warnings";
        assetSeries.dataQuality.issues.push({
          code: "stale_last_known_good",
          severity: "warning",
          field: null,
        });
        assetSeries.provenance.originalSource = "yahoo";
        assetSeries.fetchedAt = "2026-04-08T22:55:00.000Z";
      }
      return { data: [assetSeries, benchmarkSeries], errors: [] };
    });
    const clockValues = [
      new Date("2026-04-08T23:00:00.000Z"),
      new Date("2026-04-08T23:00:01.000Z"),
      new Date("2026-04-08T23:00:02.000Z"),
      new Date("2026-04-08T23:05:00.000Z"),
      new Date("2026-04-08T23:05:01.000Z"),
      new Date("2026-04-08T23:05:02.000Z"),
    ];
    const { runner: dailyRunner, store } = runner({
      service,
      clock: () => clockValues.shift(),
    });

    const first = await dailyRunner.run(sessionAuthority(fixture));
    const revisedQuality = await dailyRunner.run(sessionAuthority(fixture));
    const firstAttempt = await store.getRunAttempt(first.attemptId);
    const revisedAttempt = await store.getRunAttempt(revisedQuality.attemptId);

    expect(revisedQuality.runId).not.toBe(first.runId);
    expect(revisedAttempt.inputManifest.assets[0].assetSeriesHash).not.toBe(
      firstAttempt.inputManifest.assets[0].assetSeriesHash,
    );
    expect([...store.observations.values()].every((revisions) => (
      revisions.length === 1
    ))).toBe(true);
    expect(await store.listDailyObservations({
      instrumentId: AAPL,
      sessionDate: SESSION_AUTHORITY.completedSessionDate,
    })).toHaveLength(1);
  });

  it("binds series and run identities to the certified session-grid revision", async () => {
    const fixture = movementFixture();
    const service = historyService(() => ({
      data: [
        structuredClone(fixture.assetSeries),
        structuredClone(fixture.benchmarkSeries),
      ],
      errors: [],
    }));
    const clockValues = [
      new Date("2026-04-08T23:00:00.000Z"),
      new Date("2026-04-08T23:00:01.000Z"),
      new Date("2026-04-08T23:00:02.000Z"),
      new Date("2026-04-08T23:05:00.000Z"),
      new Date("2026-04-08T23:05:01.000Z"),
      new Date("2026-04-08T23:05:02.000Z"),
    ];
    const { runner: dailyRunner, store } = runner({
      service,
      clock: () => clockValues.shift(),
    });
    const revisedGrid = {
      ...fixture.sessionGrid,
      revision: "fixture@2",
    };

    const first = await dailyRunner.run(sessionAuthority(fixture));
    const revised = await dailyRunner.run(sessionAuthority(fixture, {
      sessionGrid: revisedGrid,
    }));
    const firstAttempt = await store.getRunAttempt(first.attemptId);
    const revisedAttempt = await store.getRunAttempt(revised.attemptId);
    const firstAssetHash = firstAttempt.inputManifest.assets[0].assetSeriesHash;
    const revisedAssetHash = revisedAttempt.inputManifest.assets[0].assetSeriesHash;

    expect(revised.sessionGrid.inputHash).not.toBe(first.sessionGrid.inputHash);
    expect(revised.configHash).not.toBe(first.configHash);
    expect(revised.runId).not.toBe(first.runId);
    expect(revisedAssetHash).not.toBe(firstAssetHash);
    expect(revisedAttempt.inputManifest.sessionSentinel.seriesHash).not.toBe(
      firstAttempt.inputManifest.sessionSentinel.seriesHash,
    );
    expect(await store.getHistoryManifest(firstAssetHash)).toMatchObject({
      seriesHash: firstAssetHash,
      sessionGrid: { revision: "fixture@1" },
    });
    expect(await store.getHistoryManifest(revisedAssetHash)).toMatchObject({
      seriesHash: revisedAssetHash,
      sessionGrid: { revision: "fixture@2" },
    });
  });

  it("performs no assessment or persistence when the benchmark batch item fails", async () => {
    const fixture = movementFixture();
    const service = historyService(() => ({
      data: [fixture.assetSeries],
      errors: [{ instrumentId: SPY, code: "upstream_unavailable" }],
    }));
    const engine = {
      validateHistory: vi.fn((series) => series),
      validateSessionGrid: vi.fn((sessionGrid) => sessionGrid),
      assessMovement: vi.fn(),
    };
    const store = {
      appendHistoryInput: vi.fn(),
      appendAssessment: vi.fn(),
      appendForecast: vi.fn(),
      appendRunAttempt: vi.fn(async (attempt) => attempt),
    };
    const { runner: dailyRunner } = runner({ service, store, engine });

    const summary = await dailyRunner.run(sessionAuthority(fixture));

    expect(summary).toMatchObject({
      status: "benchmark_unavailable",
      benchmark: {
        instrumentId: SPY,
        status: "failed",
        reasonCodes: ["history_item_failed"],
        upstreamCode: "upstream_unavailable",
      },
      counts: { requested: 1, available: 0, unavailable: 0, failed: 1 },
      results: [{
        instrumentId: AAPL,
        status: "failed",
        reasonCodes: ["benchmark_unavailable"],
      }],
    });
    expect(engine.assessMovement).not.toHaveBeenCalled();
    expect(store.appendHistoryInput).not.toHaveBeenCalled();
    expect(store.appendAssessment).not.toHaveBeenCalled();
    expect(store.appendForecast).not.toHaveBeenCalled();
    expect(store.appendRunAttempt).toHaveBeenCalledOnce();
  });

  it("assesses the session the host names, from history through that session only", async () => {
    const fixture = movementFixture();
    const throughEarlier = {
      completedSessionDate: "2026-04-07",
      nextSessionDate: "2026-04-09",
      sessionGrid: {
        ...fixture.sessionGrid,
        sessionDates: fixture.sessionGrid.sessionDates.slice(0, -1),
      },
    };
    const asOfPreviousDay = (series) => {
      const bars = series.bars.slice(0, -1);
      return {
        ...series,
        bars,
        asOf: bars.at(-1).timestamp,
        dataQuality: { ...series.dataQuality, rowCount: bars.length },
      };
    };

    const withLaterBar = await runner({
      service: historyService(() => ({
        data: [fixture.assetSeries, fixture.benchmarkSeries],
        errors: [],
      })),
    }).runner.run(throughEarlier);
    const withoutIt = await runner({
      service: historyService(() => ({
        data: [
          asOfPreviousDay(fixture.assetSeries),
          asOfPreviousDay(fixture.benchmarkSeries),
        ],
        errors: [],
      })),
    }).runner.run(throughEarlier);

    expect(withLaterBar.status).toBe("completed");
    expect(withLaterBar.completedSessionDate).toBe("2026-04-07");
    expect(withLaterBar.benchmark.status).toBe("available");
    expect(withLaterBar.inputManifest).toEqual(withoutIt.inputManifest);
    expect(withLaterBar.runId).toBe(withoutIt.runId);
  });

  it("reconstructs the quality a gap-free session had, not the one the later bar left", async () => {
    const fixture = movementFixture();
    const throughEarlier = {
      completedSessionDate: "2026-04-07",
      nextSessionDate: "2026-04-09",
      sessionGrid: {
        ...fixture.sessionGrid,
        sessionDates: fixture.sessionGrid.sessionDates.slice(0, -1),
      },
    };
    const withGapOnLastBar = (series) => {
      const bars = series.bars.slice(0, -1).concat({
        ...series.bars.at(-1),
        adjustedClose: null,
        displayClose: null,
      });
      return {
        ...series,
        bars,
        dataQuality: {
          ...series.dataQuality,
          status: "usable_with_warnings",
          missingAdjustedCloseRows: 1,
          issues: [{ code: "partial_adjusted_series", severity: "warning", field: "adjustedClose" }],
        },
      };
    };
    const asOfPreviousDay = (series) => {
      const bars = series.bars.slice(0, -1);
      return { ...series, bars, asOf: bars.at(-1).timestamp, dataQuality: { ...series.dataQuality, rowCount: bars.length } };
    };

    const withLaterGap = await runner({
      service: historyService(() => ({
        data: [withGapOnLastBar(fixture.assetSeries), withGapOnLastBar(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(throughEarlier);
    const withoutIt = await runner({
      service: historyService(() => ({
        data: [asOfPreviousDay(fixture.assetSeries), asOfPreviousDay(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(throughEarlier);

    expect(withLaterGap.status).toBe("completed");
    expect(withLaterGap.runId).toBe(withoutIt.runId);
    expect(withLaterGap.inputManifest).toEqual(withoutIt.inputManifest);
  });

  it("drops an event past the assessed session even when every bar belongs to it", async () => {
    const fixture = movementFixture();
    const withLaterDividend = (series) => ({
      ...series,
      events: [{
        type: "dividend",
        timestamp: "2026-04-09T13:30:00.000Z",
        amount: 1.5,
        currency: "USD",
        source: "yahoo",
      }],
    });
    const seen = [];
    const engine = new AnalyticsEngine();
    const validateHistory = engine.validateHistory.bind(engine);
    engine.validateHistory = (series, label) => {
      seen.push(series);
      return validateHistory(series, label);
    };
    const service = historyService(() => ({
      data: [withLaterDividend(fixture.assetSeries), withLaterDividend(fixture.benchmarkSeries)],
      errors: [],
    }));

    await runner({ service, engine }).runner.run(sessionAuthority(fixture));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(({ events }) => events.length === 0)).toBe(true);
    expect(seen.every(({ bars }) => bars.length === fixture.benchmarkSeries.bars.length)).toBe(true);
  });

  it("fails only the instrument whose history cannot be read to the session", async () => {
    const fixture = movementFixture();
    const malformed = { ...fixture.assetSeries, bars: [{ timestamp: "not-a-timestamp", close: 1 }] };
    const service = historyService(() => ({
      data: [malformed, fixture.benchmarkSeries],
      errors: [],
    }));

    const summary = await runner({ service }).runner.run(sessionAuthority(fixture));

    expect(summary.status).toBe("completed_with_failures");
    expect(summary.results).toEqual([{
      instrumentId: AAPL,
      status: "failed",
      reasonCodes: ["invalid_normalized_history"],
    }]);
  });

  it("forgets a row the provider dropped from a session it is not assessing", async () => {
    const fixture = movementFixture();
    const throughEarlier = {
      completedSessionDate: "2026-04-07",
      nextSessionDate: "2026-04-09",
      sessionGrid: {
        ...fixture.sessionGrid,
        sessionDates: fixture.sessionGrid.sessionDates.slice(0, -1),
      },
    };
    const droppedALaterRow = (series) => ({
      ...series,
      dataQuality: {
        ...series.dataQuality,
        status: "usable_with_warnings",
        droppedRows: 1,
        issues: [{
          code: "duplicate_timestamp",
          severity: "warning",
          field: "timestamp",
          timestamp: series.bars.at(-1).timestamp,
        }],
      },
    });
    const asOfPreviousDay = (series) => {
      const bars = series.bars.slice(0, -1);
      return { ...series, bars, asOf: bars.at(-1).timestamp, dataQuality: { ...series.dataQuality, rowCount: bars.length } };
    };

    const withLaterDrop = await runner({
      service: historyService(() => ({
        data: [droppedALaterRow(fixture.assetSeries), droppedALaterRow(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(throughEarlier);
    const withoutIt = await runner({
      service: historyService(() => ({
        data: [asOfPreviousDay(fixture.assetSeries), asOfPreviousDay(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(throughEarlier);

    expect(withLaterDrop.status).toBe("completed");
    expect(withLaterDrop.runId).toBe(withoutIt.runId);
    expect(withLaterDrop.inputManifest).toEqual(withoutIt.inputManifest);
  });

  it("forgets a discarded row from a later session even when no bar survives it", async () => {
    const fixture = movementFixture();
    const laterDiscardOnly = (series) => {
      const bars = series.bars.slice(0, -1);
      return {
        ...series,
        bars,
        asOf: bars.at(-1).timestamp,
        dataQuality: {
          ...series.dataQuality,
          rowCount: bars.length,
          status: "usable_with_warnings",
          droppedRows: 1,
          issues: [{
            code: "row_dropped_invalid_ohlc",
            severity: "warning",
            field: null,
            timestamp: series.bars.at(-1).timestamp,
          }],
        },
      };
    };
    const clean = (series) => {
      const bars = series.bars.slice(0, -1);
      return { ...series, bars, asOf: bars.at(-1).timestamp, dataQuality: { ...series.dataQuality, rowCount: bars.length } };
    };
    const authority = {
      completedSessionDate: "2026-04-07",
      nextSessionDate: "2026-04-09",
      sessionGrid: { ...fixture.sessionGrid, sessionDates: fixture.sessionGrid.sessionDates.slice(0, -1) },
    };

    const withDiscard = await runner({
      service: historyService(() => ({
        data: [laterDiscardOnly(fixture.assetSeries), laterDiscardOnly(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(authority);
    const withoutIt = await runner({
      service: historyService(() => ({
        data: [clean(fixture.assetSeries), clean(fixture.benchmarkSeries)],
        errors: [],
      })),
    }).runner.run(authority);

    expect(withDiscard.status).toBe("completed");
    expect(withDiscard.runId).toBe(withoutIt.runId);
    expect(withDiscard.inputManifest).toEqual(withoutIt.inputManifest);
  });

  it("keeps a dropped row it cannot place in any session", async () => {
    const fixture = movementFixture();
    const seen = [];
    const engine = new AnalyticsEngine();
    const validateHistory = engine.validateHistory.bind(engine);
    engine.validateHistory = (series, label) => { seen.push(series); return validateHistory(series, label); };
    const unplaceable = (series) => ({
      ...series,
      dataQuality: {
        ...series.dataQuality,
        status: "usable_with_warnings",
        droppedRows: 1,
        issues: [{ code: "row_dropped_invalid_timestamp", severity: "warning", field: "timestamp" }],
      },
    });
    const service = historyService(() => ({
      data: [unplaceable(fixture.assetSeries), unplaceable(fixture.benchmarkSeries)],
      errors: [],
    }));

    await runner({ service, engine }).runner.run({
      completedSessionDate: "2026-04-07",
      nextSessionDate: "2026-04-09",
      sessionGrid: { ...fixture.sessionGrid, sessionDates: fixture.sessionGrid.sessionDates.slice(0, -1) },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(({ dataQuality }) => dataQuality.droppedRows === 1)).toBe(true);
    expect(seen.every(({ dataQuality }) => dataQuality.status === "usable_with_warnings")).toBe(true);
  });

  it("still refuses a benchmark that stops before the session the host names", async () => {
    const fixture = movementFixture();
    const stale = {
      ...fixture.benchmarkSeries,
      bars: fixture.benchmarkSeries.bars.slice(0, -1),
    };
    const service = historyService(() => ({
      data: [fixture.assetSeries, stale],
      errors: [],
    }));
    const store = {
      appendHistoryInput: vi.fn(),
      appendAssessment: vi.fn(),
      appendForecast: vi.fn(),
      appendRunAttempt: vi.fn(async (attempt) => attempt),
    };
    const engine = {
      validateHistory: vi.fn((series) => series),
      validateSessionGrid: vi.fn((sessionGrid) => sessionGrid),
      assessMovement: vi.fn(),
    };
    const { runner: dailyRunner } = runner({ service, store, engine });

    const summary = await dailyRunner.run(sessionAuthority(fixture));

    expect(summary).toMatchObject({
      status: "benchmark_unavailable",
      benchmark: {
        instrumentId: SPY,
        status: "failed",
        observedSessionDate: "2026-04-07",
        reasonCodes: ["benchmark_session_mismatch"],
      },
      counts: { requested: 1, available: 0, unavailable: 0, failed: 1 },
    });
    expect(engine.assessMovement).not.toHaveBeenCalled();
    expect(store.appendHistoryInput).toHaveBeenCalledTimes(2);
    expect(store.appendAssessment).not.toHaveBeenCalled();
    expect(store.appendForecast).not.toHaveBeenCalled();
    expect(store.appendRunAttempt).toHaveBeenCalledOnce();
  });

  it("writes the assessment only after both forecast records succeed", async () => {
    const fixture = movementFixture();
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const store = new InMemoryAnalyticsStore();
    const appendForecast = store.appendForecast.bind(store);
    store.appendForecast = vi.fn(async (record) => {
      if (record.origin === "live") throw new Error("simulated live write failure");
      return appendForecast(record);
    });
    const { runner: dailyRunner } = runner({ service, store });

    const summary = await dailyRunner.run(sessionAuthority(fixture));
    const attempt = await store.getRunAttempt(summary.attemptId);

    expect(summary).toMatchObject({
      status: "completed_with_failures",
      counts: { requested: 1, available: 0, unavailable: 0, failed: 1 },
      results: [{
        instrumentId: AAPL,
        status: "failed",
        reasonCodes: ["analytics_persistence_failed"],
        failedRecords: ["liveForecast"],
      }],
    });
    expect(await store.listAssessments(summary.runId)).toEqual([]);
    expect(await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: SESSION_AUTHORITY.completedSessionDate,
    })).toHaveLength(1);
    expect(await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: SESSION_AUTHORITY.nextSessionDate,
    })).toEqual([]);
    expect(attempt.failureSummary.results).toEqual([
      expect.objectContaining({
        instrumentId: AAPL,
        reasonCodes: ["analytics_persistence_failed"],
        failedRecords: ["liveForecast"],
      }),
    ]);
  });

  it("preserves a successful asset when another batch item fails", async () => {
    const fixture = movementFixture();
    const failedSeries = withInstrument(fixture.assetSeries, MSFT);
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [{ instrumentId: MSFT, code: "rate_limited" }],
    }));
    const { runner: dailyRunner, store } = runner({
      service,
      equityInstrumentIds: [AAPL, MSFT],
    });

    const summary = await dailyRunner.run(sessionAuthority(fixture));

    expect(summary).toMatchObject({
      status: "completed_with_failures",
      counts: { requested: 2, available: 1, unavailable: 0, failed: 1 },
      results: [
        { instrumentId: AAPL, status: "available" },
        {
          instrumentId: MSFT,
          status: "failed",
          reasonCodes: ["history_item_failed"],
          upstreamCode: "rate_limited",
        },
      ],
    });
    expect(await store.listAssessments(summary.runId)).toHaveLength(1);
    expect(await store.listDailyObservations({
      instrumentId: MSFT,
      sessionDate: failedSeries.bars.at(-1).timestamp.slice(0, 10),
    })).toEqual([]);
  });

  it("persists a stale quality rejection without manufacturing a forecast", async () => {
    const fixture = movementFixture();
    fixture.assetSeries.quality = "stale";
    fixture.assetSeries.dataQuality.status = "usable_with_warnings";
    fixture.assetSeries.dataQuality.issues.push({
      code: "stale_last_known_good",
      severity: "warning",
      field: null,
    });
    fixture.assetSeries.provenance.originalSource = "yahoo";
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const { runner: dailyRunner, store } = runner({ service });

    const summary = await dailyRunner.run(sessionAuthority(fixture));

    expect(summary).toMatchObject({
      status: "completed",
      counts: { requested: 1, available: 0, unavailable: 1, failed: 0 },
      results: [{
        instrumentId: AAPL,
        status: "unavailable",
        reasonCodes: expect.arrayContaining(["stale_input"]),
      }],
    });
    const [record] = await store.listAssessments(summary.runId);
    const attempt = await store.getRunAttempt(summary.attemptId);
    const assetManifest = await store.getHistoryManifest(
      attempt.inputManifest.assets[0].assetSeriesHash,
    );
    expect(record.assessment).toMatchObject({
      status: "unavailable",
      forecast: null,
      evidence: null,
      quality: { reasonCodes: expect.arrayContaining(["stale_input"]) },
    });
    expect(assetManifest).toMatchObject({
      instrumentId: AAPL,
      quality: "stale",
    });
    expect(attempt.failureSummary.results).toEqual([
      expect.objectContaining({
        instrumentId: AAPL,
        status: "unavailable",
        reasonCodes: expect.arrayContaining(["stale_input"]),
      }),
    ]);
    expect(await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: summary.results[0].sessionDate,
    })).toEqual([]);
    expect(await store.listForecasts({
      instrumentId: AAPL,
      targetSessionDate: SESSION_AUTHORITY.nextSessionDate,
    })).toEqual([]);
    expect(await store.listDailyObservations({
      instrumentId: AAPL,
      sessionDate: summary.results[0].sessionDate,
    })).toHaveLength(1);
  });

  it("persists an evidence-short assessment as unavailable rather than weakening windows", async () => {
    const fixture = movementFixture(20);
    const shortSessionAuthority = {
      completedSessionDate: "2023-02-01",
      nextSessionDate: "2023-02-02",
      sessionGrid: fixture.sessionGrid,
    };
    const service = historyService(() => ({
      data: [fixture.assetSeries, fixture.benchmarkSeries],
      errors: [],
    }));
    const { runner: dailyRunner, store } = runner({
      service,
      clock: () => new Date("2023-02-01T23:00:00.000Z"),
    });

    const summary = await dailyRunner.run(shortSessionAuthority);
    const [record] = await store.listAssessments(summary.runId);

    expect(summary.counts).toEqual({
      requested: 1,
      available: 0,
      unavailable: 1,
      failed: 0,
    });
    expect(summary.results[0].reasonCodes).toEqual(expect.arrayContaining([
      "insufficient_valid_returns",
      "insufficient_reference_scores",
    ]));
    expect(record.assessment.status).toBe("unavailable");
    expect(record.assessment.forecast).toBeNull();
    expect(record.assessment.evidence).toBeNull();
  });
});
