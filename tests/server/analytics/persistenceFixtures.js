import { analyticsSha256 } from "../../../server/analytics/canonicalDigest.js";
import { computeMovementAssessment } from "../../../server/analytics/computeMovementAssessment.js";
import {
  dailyObservationInputHash,
  historySeriesHash,
  historySeriesProjectionFromInput,
} from "../../../server/analytics/historyDigests.js";
import {
  HISTORY_CUTOFF_PREDICATE,
  HISTORY_REVISION_SELECTION,
  HISTORY_SESSION_MEMBERSHIP,
} from "../../../server/analytics/persistence/records.js";
import { movementFixture } from "./fixtures.js";

export const digest = (character) => `sha256:${character.repeat(64)}`;

export const HASH = Object.freeze({
  observationA: digest("a"),
  observationB: digest("b"),
  observationC: digest("c"),
  run: digest("2"),
  attempt: digest("3"),
  sessionSentinelSeries: digest("4"),
  assessmentInput: digest("5"),
  forecastInput: digest("6"),
});

export const GRID = Object.freeze({
  calendarId: "XNYS",
  source: "host-calendar",
  revision: "2026-07-28",
  timeZone: "America/New_York",
  sessionDates: Object.freeze(["2026-07-14", "2026-07-15", "2026-07-16"]),
});

export const GRID_HASH = analyticsSha256(GRID);

export const CONFIG_SNAPSHOT = Object.freeze({
  analyticsSchemaVersion: 1,
  runnerVersion: "daily-movement-runner@1",
  sessionGrid: Object.freeze({
    inputHash: GRID_HASH,
    source: "host-calendar",
    revision: "2026-07-28",
  }),
});

export const CONFIG_HASH = analyticsSha256(CONFIG_SNAPSHOT);

export const OBSERVATION = Object.freeze({
  instrumentId: "XNAS:AAPL",
  sessionDate: "2026-07-27",
  observedAt: "2026-07-28T00:05:00.000Z",
  provider: "yahoo",
  inputHash: HASH.observationA,
  bar: Object.freeze({
    providerClose: 214.05,
    providerAdjustedClose: 213.82,
    providerVolume: 48_200_000,
  }),
});

export function analyticsRecords() {
  const assessment = computeMovementAssessment(movementFixture());
  return {
    forecast: {
      runId: HASH.run,
      targetSessionDate: assessment.sessionDate,
      informationSetEnd: assessment.forecast.informationSetEnd,
      recordedAt: "2026-07-28T22:01:00.000Z",
      origin: "backfill",
      inputHash: HASH.forecastInput,
      configHash: CONFIG_HASH,
      forecast: assessment.forecast,
    },
    assessment: {
      runId: HASH.run,
      computedAt: "2026-07-28T22:02:00.000Z",
      inputHash: HASH.assessmentInput,
      configHash: CONFIG_HASH,
      assessment,
    },
  };
}

export function historyInput(overrides = {}) {
  const {
    observationBars = null,
    ...manifestOverrides
  } = overrides;
  const observedAt = manifestOverrides.observedAt || "2026-07-28T00:05:00.000Z";
  const manifest = {
    seriesHash: digest("d"),
    instrumentId: "XNAS:AAPL",
    assetClass: "equity",
    range: "5y",
    interval: "1d",
    observedAt,
    provider: "yahoo",
    providerSymbol: "AAPL",
    fallback: false,
    originalSource: null,
    priceBasis: "provider_adjusted",
    requestedPriceBasis: "provider_adjusted",
    adjustment: {
      status: "provider_defined",
      includesSplits: true,
      includesDistributions: "unknown",
      formulaVersion: null,
    },
    continuity: { kind: "single_instrument", rollover: null },
    session: { model: "exchange_hours", timezone: "America/New_York" },
    quality: "fresh",
    dataQuality: {
      status: "usable",
      rowCount: 3,
      droppedRows: 0,
      missingAdjustedCloseRows: 0,
      issues: [],
    },
    sourceAsOf: "2026-07-16T20:00:00.000Z",
    firstSessionDate: "2026-07-14",
    lastSessionDate: "2026-07-16",
    barCount: 3,
    sessionDates: ["2026-07-14", "2026-07-15", "2026-07-16"],
    barTimestamps: [
      "2026-07-14T20:00:00.000Z",
      "2026-07-15T20:00:00.000Z",
      "2026-07-16T20:00:00.000Z",
    ],
    barInputHashes: [digest("a"), digest("b"), digest("c")],
    sessionGrid: {
      gridHash: GRID_HASH,
      ...GRID,
    },
    fetchCutoff: {
      throughObservedAt: observedAt,
      predicate: HISTORY_CUTOFF_PREDICATE,
      revisionSelection: HISTORY_REVISION_SELECTION,
      sessionMembership: HISTORY_SESSION_MEMBERSHIP,
    },
    ...manifestOverrides,
  };
  const gridContent = {
    calendarId: manifest.sessionGrid.calendarId,
    source: manifest.sessionGrid.source,
    revision: manifest.sessionGrid.revision,
    timeZone: manifest.sessionGrid.timeZone,
    sessionDates: manifest.sessionGrid.sessionDates,
  };
  manifest.sessionGrid = {
    gridHash: analyticsSha256(gridContent),
    ...gridContent,
  };
  const observations = manifest.sessionDates.map((sessionDate, index) => ({
    instrumentId: manifest.instrumentId,
    sessionDate,
    observedAt: manifest.observedAt,
    provider: manifest.provider,
    inputHash: digest(String((index + 6) % 10)),
    bar: observationBars?.[index] || {
      providerClose: 100 + index,
      providerAdjustedClose: 99.5 + index,
      providerVolume: 1_000 + index,
    },
  }));
  manifest.barInputHashes = observations.map((observation, index) => (
    dailyObservationInputHash({
      manifest,
      observation,
      barTimestamp: manifest.barTimestamps[index],
    })
  ));
  observations.forEach((observation, index) => {
    observation.inputHash = manifest.barInputHashes[index];
  });
  manifest.seriesHash = historySeriesHash(
    historySeriesProjectionFromInput({ manifest, observations }),
    manifest.sessionGrid.gridHash,
  );
  return { manifest, observations };
}

export function historyManifest(overrides = {}) {
  return historyInput(overrides).manifest;
}

export function runAttempt(overrides = {}) {
  return {
    attemptId: HASH.attempt,
    runId: HASH.run,
    expectedCompletedSessionDate: "2026-07-27",
    expectedNextSessionDate: "2026-07-29",
    startedAt: "2026-07-28T22:30:00.000Z",
    completedAt: "2026-07-28T22:31:00.000Z",
    configHash: CONFIG_HASH,
    configSnapshot: CONFIG_SNAPSHOT,
    status: "completed",
    counts: { requested: 1, available: 1, unavailable: 0, failed: 0 },
    inputManifest: {
      sessionGridHash: GRID_HASH,
      sessionSentinel: {
        instrumentId: "ARCX:SPY",
        seriesHash: HASH.sessionSentinelSeries,
      },
      missingReturnPolicy: "preserve_gaps",
      historySelection: {
        range: "5y",
        interval: "1d",
        priceBasis: "provider_adjusted",
        predicate: HISTORY_CUTOFF_PREDICATE,
        revisionSelection: HISTORY_REVISION_SELECTION,
        sessionMembership: HISTORY_SESSION_MEMBERSHIP,
      },
      assets: [{
        instrumentId: "XNAS:AAPL",
        assetSeriesHash: historyManifest().seriesHash,
        assessmentInputHash: HASH.assessmentInput,
      }],
    },
    failureSummary: { failures: [] },
    ...overrides,
  };
}
