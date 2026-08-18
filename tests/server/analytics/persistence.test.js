import { describe, expect, it } from "vitest";

import { analyticsSha256 } from "../../../server/analytics/canonicalDigest.js";
import { computeMovementAssessment } from "../../../server/analytics/computeMovementAssessment.js";
import { InMemoryAnalyticsStore } from "../../../server/analytics/persistence/InMemoryAnalyticsStore.js";
import {
  normalizeAssessmentRecord,
  normalizeDailyObservationRecord,
  normalizeForecastRecord,
  normalizeHistoryManifestRecord,
  normalizeRunAttemptRecord,
} from "../../../server/analytics/persistence/records.js";
import { movementFixture } from "./fixtures.js";
import {
  CONFIG_HASH,
  HASH,
  OBSERVATION,
  analyticsRecords,
  digest,
  historyInput,
  historyManifest,
  runAttempt,
} from "./persistenceFixtures.js";

describe("analytics persistence records", () => {
  it("requires canonical fields, dates, UTC instants, and SHA-256 digests", () => {
    expect(normalizeDailyObservationRecord({ ...OBSERVATION, revision: 1 })).toEqual({
      ...OBSERVATION,
      revision: 1,
    });
    expect(() => normalizeDailyObservationRecord({
      ...OBSERVATION,
      revision: 1,
      inputHash: "sha256:not-a-digest",
    })).toThrow(/canonical sha256/);
    expect(() => normalizeDailyObservationRecord({
      ...OBSERVATION,
      revision: 1,
      sessionDate: "2026-02-30",
    })).toThrow(/sessionDate/);
    expect(() => normalizeDailyObservationRecord({
      ...OBSERVATION,
      revision: 1,
      observedAt: "2026-07-28",
    })).toThrow(/complete ISO-8601/);
    expect(() => normalizeDailyObservationRecord({
      ...OBSERVATION,
      revision: 1,
      bar: { ...OBSERVATION.bar, providerAdjustedClose: Number.NaN },
    })).toThrow(/finite number or null/);
    expect(() => normalizeDailyObservationRecord({
      ...OBSERVATION,
      revision: 1,
      bar: {
        rawClose: 1,
        providerAdjustedClose: 1,
        providerVolume: 1,
      },
    })).toThrow(/rawClose is not supported/);
  });

  it("validates forecasts, assessments, manifests, and run attempts", () => {
    const records = analyticsRecords();
    expect(normalizeForecastRecord(records.forecast)).toEqual(records.forecast);
    expect(normalizeAssessmentRecord(records.assessment)).toEqual(records.assessment);
    expect(normalizeHistoryManifestRecord(historyManifest())).toEqual(historyManifest());
    expect(normalizeRunAttemptRecord(runAttempt())).toEqual(runAttempt());

    const invalidForecast = structuredClone(records.forecast);
    invalidForecast.forecast.variance = Number.NaN;
    expect(() => normalizeForecastRecord(invalidForecast)).toThrow();
    expect(() => normalizeRunAttemptRecord(runAttempt({
      configHash: digest("9"),
    }))).toThrow(/must match configSnapshot/);
    expect(() => normalizeHistoryManifestRecord({
      ...historyManifest(),
      barInputHashes: [HASH.observationA],
    })).toThrow(/barInputHashes length/);
    const validManifest = historyManifest();
    expect(() => normalizeHistoryManifestRecord({
      ...validManifest,
      sessionGrid: {
        ...validManifest.sessionGrid,
        gridHash: digest("9"),
      },
    })).toThrow(/gridHash does not match/);
    expect(() => normalizeForecastRecord({
      ...records.forecast,
      origin: "live",
    })).toThrow(/origin is inconsistent/);
    expect(() => normalizeForecastRecord({
      ...records.forecast,
      recordedAt: "2020-01-01T00:00:00.000Z",
    })).toThrow(/origin is inconsistent/);
  });

  it("preserves duplicate and out-of-grid sessions as auditable manifest input", () => {
    const manifest = historyManifest({
      sessionDates: ["2026-07-14", "2026-07-14", "2026-07-16"],
      barTimestamps: [
        "2026-07-14T19:00:00.000Z",
        "2026-07-14T20:00:00.000Z",
        "2026-07-16T20:00:00.000Z",
      ],
      sessionGrid: {
        gridHash: analyticsSha256({
          calendarId: "XNYS",
          source: "host-calendar",
          revision: "2026-07-28",
          timeZone: "America/New_York",
          sessionDates: ["2026-07-14", "2026-07-15"],
        }),
        calendarId: "XNYS",
        source: "host-calendar",
        revision: "2026-07-28",
        timeZone: "America/New_York",
        sessionDates: ["2026-07-14", "2026-07-15"],
      },
    });
    expect(normalizeHistoryManifestRecord(manifest)).toEqual(manifest);
    const nonMonotonic = historyManifest({
      firstSessionDate: "2026-07-16",
      lastSessionDate: "2026-07-15",
      sessionDates: ["2026-07-16", "2026-07-14", "2026-07-15"],
      barTimestamps: [
        "2026-07-16T20:00:00.000Z",
        "2026-07-14T20:00:00.000Z",
        "2026-07-15T20:00:00.000Z",
      ],
    });
    expect(() => normalizeHistoryManifestRecord(nonMonotonic))
      .toThrow(/must not follow|non-decreasing|strictly ascending/);
  });
});

describe("InMemoryAnalyticsStore", () => {
  it("rejects a bound that is not a positive integer", () => {
    expect(() => new InMemoryAnalyticsStore({ maxScopes: 0 })).toThrow(TypeError);
    expect(() => new InMemoryAnalyticsStore({ maxScopes: 1.5 })).toThrow(TypeError);
  });

  it("refuses the write that would pass its bound rather than evicting a ledger record", async () => {
    const store = new InMemoryAnalyticsStore({ maxScopes: 1 });
    await store.appendDailyObservation(OBSERVATION);
    expect(store.scopeCount).toBe(1);
    await expect(store.appendDailyObservation({
      ...OBSERVATION,
      instrumentId: "XNAS:MSFT",
    })).rejects.toThrow(RangeError);
    expect(await store.listDailyObservations({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
    })).toHaveLength(1);
  });

  it("bounds every ledger, not only the observations", async () => {
    const { forecast, assessment } = analyticsRecords();
    const writes = [
      ["appendDailyObservation", { ...OBSERVATION, instrumentId: "XNAS:MSFT" }],
      ["appendForecast", forecast],
      ["appendAssessment", assessment],
      ["appendHistoryManifest", historyManifest()],
      ["appendRunAttempt", runAttempt()],
      ["appendHistoryInput", historyInput()],
    ];
    for (const [method, record] of writes) {
      const store = new InMemoryAnalyticsStore({ maxScopes: 1 });
      await store.appendDailyObservation(OBSERVATION);
      expect(store.scopeCount, method).toBe(1);
      await expect(store[method](record), method).rejects.toThrow(RangeError);
      expect(store.scopeCount, method).toBe(1);
    }
  });

  it("keeps appending revisions to a scope it already holds", async () => {
    const store = new InMemoryAnalyticsStore({ maxScopes: 1 });
    await store.appendDailyObservation(OBSERVATION);
    const second = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T00:15:00.000Z",
      inputHash: HASH.observationB,
      bar: { ...OBSERVATION.bar, providerAdjustedClose: 213.91 },
    });
    expect(second.revision).toBe(2);
    expect(store.scopeCount).toBe(1);
  });

  it("preserves A→B→A event semantics and deterministic as-of selection", async () => {
    const store = new InMemoryAnalyticsStore();
    const first = await store.appendDailyObservation(OBSERVATION);
    const unchanged = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T00:10:00.000Z",
    });
    const second = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T00:15:00.000Z",
      inputHash: HASH.observationB,
      bar: { ...OBSERVATION.bar, providerAdjustedClose: 213.91 },
    });
    const third = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T00:20:00.000Z",
    });

    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
    expect(unchanged).toEqual(first);
    expect((await store.listDailyObservationsAsOf({
      instrumentId: OBSERVATION.instrumentId,
      throughObservedAt: "2026-07-28T00:12:00.000Z",
    }))[0]).toEqual(first);
    expect((await store.listDailyObservationsAsOf({
      instrumentId: OBSERVATION.instrumentId,
      throughObservedAt: "2026-07-28T00:17:00.000Z",
    }))[0]).toEqual(second);
    expect((await store.listDailyObservationsAsOf({
      instrumentId: OBSERVATION.instrumentId,
      throughObservedAt: "2026-07-28T00:20:00.000Z",
    }))[0]).toEqual(third);
  });

  it("rejects same-event hash collisions", async () => {
    const store = new InMemoryAnalyticsStore();
    await store.appendDailyObservation(OBSERVATION);
    await expect(store.appendDailyObservation({
      ...OBSERVATION,
      bar: { ...OBSERVATION.bar, providerClose: 999 },
    })).rejects.toThrow(/collides/);
  });

  it("atomically ingests a manifest projection and reconstructs duplicate bars by hash", async () => {
    const store = new InMemoryAnalyticsStore();
    const input = historyInput({
      sessionDates: ["2026-07-14", "2026-07-14", "2026-07-16"],
      barTimestamps: [
        "2026-07-14T19:00:00.000Z",
        "2026-07-14T20:00:00.000Z",
        "2026-07-16T20:00:00.000Z",
      ],
    });
    const { manifest } = input;
    const stored = await store.appendHistoryInput(input);
    expect(stored.observations).toHaveLength(3);

    const reconstructed = [];
    for (let index = 0; index < manifest.barCount; index += 1) {
      reconstructed.push(await store.getDailyObservation({
        instrumentId: manifest.instrumentId,
        sessionDate: manifest.sessionDates[index],
        inputHash: manifest.barInputHashes[index],
      }));
    }
    expect(reconstructed.map(({ bar }) => bar)).toEqual(
      input.observations.map(({ bar }) => bar),
    );
    expect(await store.getHistoryInput(manifest.seriesHash)).toMatchObject({
      manifest,
      observations: reconstructed,
    });
    expect((await store.appendHistoryInput(input)).manifest).toEqual(manifest);

    await expect(store.appendHistoryInput({
      manifest: { ...manifest, providerSymbol: "COLLISION" },
      observations: input.observations,
    })).rejects.toThrow(/inputHash does not match/);
    expect(await store.getHistoryManifest(manifest.seriesHash)).toEqual(manifest);
  });

  it("revalidates content-addressed history and fails on tampered or missing rows", async () => {
    const store = new InMemoryAnalyticsStore();
    const input = historyInput();
    await store.appendHistoryInput(input);
    const [scopeKey, revisions] = [...store.observations.entries()][0];
    revisions[0].bar.providerClose += 1;
    store.observations.set(scopeKey, revisions);
    await expect(store.getHistoryInput(input.manifest.seriesHash))
      .rejects.toThrow(/inputHash does not match/);

    const missingStore = new InMemoryAnalyticsStore();
    await missingStore.appendHistoryInput(input);
    missingStore.observations.delete([...missingStore.observations.keys()][0]);
    await expect(missingStore.getHistoryInput(input.manifest.seriesHash))
      .rejects.toThrow(/is missing/);

    const cleanStore = new InMemoryAnalyticsStore();
    const countBefore = cleanStore.observations.size;
    const tampered = structuredClone(input);
    tampered.observations[0].bar.providerClose += 1;
    await expect(cleanStore.appendHistoryInput(tampered))
      .rejects.toThrow(/inputHash does not match/);
    expect(cleanStore.observations.size).toBe(countBefore);
    expect(cleanStore.historyManifests.size).toBe(0);
  });

  it("deduplicates unchanged bars across later manifests without losing cutoff provenance", async () => {
    const store = new InMemoryAnalyticsStore();
    const first = historyInput();
    await store.appendHistoryInput(first);
    const second = historyInput({
      observedAt: "2026-07-29T00:05:00.000Z",
      observationBars: [
        first.observations[0].bar,
        first.observations[1].bar,
        {
          ...first.observations[2].bar,
          providerAdjustedClose: 103,
        },
      ],
    });
    const stored = await store.appendHistoryInput(second);
    expect(stored.observations.slice(0, 2).map(({ observedAt }) => observedAt))
      .toEqual([first.manifest.observedAt, first.manifest.observedAt]);
    expect(stored.observations[2].revision).toBe(2);
    expect(await store.getHistoryInput(second.manifest.seriesHash)).toMatchObject({
      manifest: second.manifest,
    });
  });

  it("distinguishes identical history projections bound to different session grids", async () => {
    const store = new InMemoryAnalyticsStore();
    const firstInput = historyInput();
    const secondInput = historyInput({
      sessionGrid: {
        ...firstInput.manifest.sessionGrid,
        revision: "2026-07-29",
      },
    });
    await store.appendHistoryInput(firstInput);
    await store.appendHistoryInput(secondInput);
    expect(firstInput.manifest.seriesHash).not.toBe(secondInput.manifest.seriesHash);
    expect(await store.getHistoryManifest(firstInput.manifest.seriesHash))
      .toEqual(firstInput.manifest);
    expect(await store.getHistoryManifest(secondInput.manifest.seriesHash))
      .toEqual(secondInput.manifest);
  });

  it("keeps all five ledgers immutable, idempotent, and identity-bound", async () => {
    const store = new InMemoryAnalyticsStore();
    const records = analyticsRecords();
    const forecast = await store.appendForecast(records.forecast);
    const assessment = await store.appendAssessment(records.assessment);
    const attempt = await store.appendRunAttempt(runAttempt());
    forecast.forecast.variance = 1;
    assessment.assessment.quality.missingRate = 1;
    attempt.configSnapshot.runnerVersion = "mutated";

    expect(await store.getForecast({
      runId: records.forecast.runId,
      instrumentId: records.forecast.forecast.instrumentId,
      targetSessionDate: records.forecast.targetSessionDate,
      informationSetEnd: records.forecast.informationSetEnd,
      origin: records.forecast.origin,
      inputHash: records.forecast.inputHash,
      configHash: records.forecast.configHash,
    })).toEqual(records.forecast);
    expect(await store.getAssessment({
      runId: records.assessment.runId,
      instrumentId: records.assessment.assessment.instrumentId,
    })).toEqual(records.assessment);
    expect(await store.getRunAttempt(HASH.attempt)).toEqual(runAttempt());
    expect(await store.appendRunAttempt(runAttempt())).toEqual(runAttempt());

    const [forecastKey, persistedForecast] = [...store.forecasts.entries()][0];
    store.forecasts.delete(forecastKey);
    store.forecasts.set(JSON.stringify([
      HASH.run,
      "XNAS:MSFT",
      records.forecast.targetSessionDate,
      records.forecast.informationSetEnd,
      records.forecast.origin,
      records.forecast.inputHash,
      records.forecast.configHash,
    ]), persistedForecast);
    await expect(store.listForecasts({
      instrumentId: "XNAS:MSFT",
      targetSessionDate: records.forecast.targetSessionDate,
    })).rejects.toThrow(/key does not match/);
  });

  it("closes idempotently", async () => {
    const store = new InMemoryAnalyticsStore();
    const first = store.close();
    expect(store.close()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it("selects the latest assessment per instrument by session date, then compute time", async () => {
    const store = new InMemoryAnalyticsStore();
    const current = computeMovementAssessment(movementFixture());
    const later = computeMovementAssessment(movementFixture(818));
    const otherInstrument = structuredClone(later);
    otherInstrument.instrumentId = "XNAS:MSFT";
    otherInstrument.forecast.instrumentId = "XNAS:MSFT";
    otherInstrument.evidence.instrumentId = "XNAS:MSFT";

    await store.appendAssessment({
      runId: digest("1"),
      computedAt: "2026-07-28T22:02:00.000Z",
      inputHash: HASH.assessmentInput,
      configHash: CONFIG_HASH,
      assessment: current,
    });
    await store.appendAssessment({
      runId: digest("2"),
      computedAt: "2026-07-28T23:30:00.000Z",
      inputHash: HASH.assessmentInput,
      configHash: CONFIG_HASH,
      assessment: current,
    });
    await store.appendAssessment({
      runId: digest("3"),
      computedAt: "2026-07-28T21:00:00.000Z",
      inputHash: HASH.assessmentInput,
      configHash: CONFIG_HASH,
      assessment: later,
    });
    await store.appendAssessment({
      runId: digest("4"),
      computedAt: "2026-07-29T22:02:00.000Z",
      inputHash: HASH.assessmentInput,
      configHash: CONFIG_HASH,
      assessment: otherInstrument,
    });

    const latest = await store.getLatestAssessment("XNAS:AAPL");
    expect(latest).toMatchObject({
      runId: digest("3"),
      assessment: { instrumentId: "XNAS:AAPL", sessionDate: later.sessionDate },
    });
    expect(latest.assessment.sessionDate > current.sessionDate).toBe(true);
    expect(await store.getLatestAssessment("XNAS:NVDA")).toBeNull();

    const sameSession = await store.getLatestAssessment("XNAS:MSFT");
    expect(sameSession.runId).toBe(digest("4"));

    const [key, persisted] = [...store.assessments.entries()][0];
    store.assessments.set(key, { ...persisted, computedAt: "not-a-timestamp" });
    await expect(store.getLatestAssessment("XNAS:AAPL")).rejects.toThrow();
  });
});
