import { CANONICAL_INSTRUMENT_ID_PATTERN } from "../contracts/core/constants.js";
import { analyticsSha256 } from "./canonicalDigest.js";
import {
  ANALYTICS_SCHEMA_VERSION,
  EMPIRICAL_CORRECTION,
  EMPIRICAL_REFERENCE_SCORES,
  EMPIRICAL_TAIL,
  EMPIRICAL_TIE_POLICY,
  EWMA_MISSING_RETURN_POLICY,
  EWMA_LAMBDA,
  EWMA_MODEL_VERSION,
  EWMA_WARMUP_RETURNS,
  MOVEMENT_BENCHMARK_INSTRUMENT_ID,
  MOVEMENT_MAX_MISSING_RATE,
  MOVEMENT_METHOD_VERSION,
  MOVEMENT_QUALITY_VERSION,
  MOVEMENT_REQUIRED_VALID_RETURNS,
  MOVEMENT_SESSION_CALENDAR_ID,
} from "./contracts/constants.js";
import { validateVolatilityForecast } from "./contracts/validators.js";
import {
  isSessionDate,
  sessionDateFromTimestamp,
} from "./data/sessionDate.js";
import { AnalyticsEngine } from "./AnalyticsEngine.js";
import {
  historyObservationFromSeries,
  historySeriesHash,
  historySeriesProjection,
} from "./historyDigests.js";
import {
  HISTORY_CUTOFF_PREDICATE,
  HISTORY_REVISION_SELECTION,
  HISTORY_SESSION_MEMBERSHIP,
} from "./persistence/records.js";

export const DAILY_ANALYTICS_RUNNER_VERSION = "daily-movement-runner@1";
export const DAILY_ANALYTICS_CUTOFF_UTC = "22:30";

const HISTORY_REQUEST = Object.freeze({
  range: "5y",
  interval: "1d",
  priceBasis: "provider_adjusted",
});
const CUTOFF_MINUTES_UTC = (22 * 60) + 30;
const SUMMARY_SCHEMA_VERSION = 1;
const MAX_EQUITY_INSTRUMENTS = 40;

const REASON_CODES = Object.freeze({
  BATCH_FAILED: "history_batch_failed",
  ITEM_FAILED: "history_item_failed",
  HISTORY_MISSING: "history_missing",
  DUPLICATE_HISTORY: "duplicate_history_series",
  REQUEST_MISMATCH: "history_request_mismatch",
  INVALID_HISTORY: "invalid_normalized_history",
  FUTURE_FETCHED_AT: "history_fetched_at_after_compute",
  BENCHMARK_UNAVAILABLE: "benchmark_unavailable",
  BENCHMARK_SESSION_MISMATCH: "benchmark_session_mismatch",
  CALCULATION_FAILED: "movement_calculation_failed",
  PERSISTENCE_FAILED: "analytics_persistence_failed",
});

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function toDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must return a valid date`);
  return date;
}

function cutoffReached(date) {
  return ((date.getUTCHours() * 60) + date.getUTCMinutes()) >= CUTOFF_MINUTES_UTC;
}

function normalizeSessionAuthority(value, now, engine) {
  if (!isPlainObject(value)) {
    throw new TypeError("run requires completedSessionDate and nextSessionDate");
  }
  const { completedSessionDate, nextSessionDate } = value;
  if (!isSessionDate(completedSessionDate)) {
    throw new TypeError("completedSessionDate must be a valid YYYY-MM-DD session date");
  }
  if (!isSessionDate(nextSessionDate)) {
    throw new TypeError("nextSessionDate must be a valid YYYY-MM-DD session date");
  }
  if (nextSessionDate <= completedSessionDate) {
    throw new RangeError("nextSessionDate must follow completedSessionDate");
  }
  const sessionGrid = engine.validateSessionGrid(value.sessionGrid);
  if (sessionGrid.sessionDates.at(-1) !== completedSessionDate) {
    throw new RangeError("completedSessionDate must equal the end of sessionGrid");
  }

  const recordedDate = now.toISOString().slice(0, 10);
  if (recordedDate < completedSessionDate) {
    const error = new RangeError("The supplied completed session is still in the future");
    error.code = "analytics_completed_session_not_reached";
    throw error;
  }
  if (recordedDate >= nextSessionDate) {
    const error = new RangeError("The supplied next session has already started");
    error.code = "analytics_next_session_started";
    throw error;
  }
  const sessionGridIdentity = {
    authority: "host_supplied_not_certified_by_runner",
    calendarId: sessionGrid.calendarId,
    source: sessionGrid.source,
    revision: sessionGrid.revision,
    timeZone: sessionGrid.timeZone,
    startSessionDate: sessionGrid.sessionDates[0],
    endSessionDate: sessionGrid.sessionDates.at(-1),
    sessionCount: sessionGrid.sessionDates.length,
    inputHash: analyticsSha256(sessionGrid),
  };
  return {
    completedSessionDate,
    nextSessionDate,
    sessionGrid,
    sessionGridIdentity,
  };
}

function normalizedErrorCode(error) {
  if (typeof error?.code !== "string" || error.code.trim().length === 0) return null;
  return error.code.trim();
}

function resultFailure(instrumentId, reasonCodes, upstreamCode = null) {
  return {
    instrumentId,
    status: "failed",
    reasonCodes: [...reasonCodes],
    ...(upstreamCode ? { upstreamCode } : {}),
  };
}

function assertDependencies(historyService, analyticsStore, engine, clock) {
  if (typeof historyService?.getHistoryBatch !== "function") {
    throw new TypeError("historyService.getHistoryBatch is required");
  }
  for (const method of [
    "appendHistoryInput",
    "appendAssessment",
    "appendForecast",
    "appendRunAttempt",
  ]) {
    if (typeof analyticsStore?.[method] !== "function") {
      throw new TypeError(`analyticsStore.${method} is required`);
    }
  }
  if (typeof engine?.validateHistory !== "function"
    || typeof engine?.validateSessionGrid !== "function"
    || typeof engine?.assessMovement !== "function") {
    throw new TypeError(
      "engine must expose validateHistory, validateSessionGrid, and assessMovement",
    );
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
}

function normalizeEquityInstrumentIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("equityInstrumentIds must be a non-empty array");
  }
  if (value.length > MAX_EQUITY_INSTRUMENTS) {
    throw new RangeError(
      `equityInstrumentIds must not exceed ${MAX_EQUITY_INSTRUMENTS} instruments`,
    );
  }
  const seen = new Set();
  return Object.freeze(value.map((instrumentId, index) => {
    if (typeof instrumentId !== "string"
      || !CANONICAL_INSTRUMENT_ID_PATTERN.test(instrumentId)) {
      throw new TypeError(
        `equityInstrumentIds[${index}] must be a canonical instrument ID`,
      );
    }
    if (instrumentId === MOVEMENT_BENCHMARK_INSTRUMENT_ID) {
      throw new TypeError("The SPY benchmark must not be part of equityInstrumentIds");
    }
    if (seen.has(instrumentId)) {
      throw new TypeError("equityInstrumentIds must not contain duplicates");
    }
    seen.add(instrumentId);
    return instrumentId;
  }));
}

function matchesHistoryRequest(series) {
  return Object.entries(HISTORY_REQUEST)
    .every(([key, value]) => series?.[key] === value);
}

function indexBatchData(batch) {
  const seriesById = new Map();
  const duplicates = new Set();
  for (const series of Array.isArray(batch?.data) ? batch.data : []) {
    const instrumentId = series?.instrumentId;
    if (typeof instrumentId !== "string") continue;
    if (seriesById.has(instrumentId)) duplicates.add(instrumentId);
    else seriesById.set(instrumentId, series);
  }

  const errorsById = new Map();
  for (const error of Array.isArray(batch?.errors) ? batch.errors : []) {
    if (typeof error?.instrumentId === "string" && !errorsById.has(error.instrumentId)) {
      errorsById.set(error.instrumentId, error);
    }
  }
  return { seriesById, duplicates, errorsById };
}

const DROPPED_ROW_ISSUE_CODES = Object.freeze(new Set([
  "row_dropped_invalid_timestamp",
  "duplicate_timestamp",
  "row_dropped_invalid_ohlc",
]));

function seriesThroughSession(series, completedSessionDate) {
  const withinSession = ({ timestamp }) => (
    sessionDateFromTimestamp(timestamp, series.session.timezone) <= completedSessionDate
  );
  const bars = series.bars.filter(withinSession);
  const events = series.events.filter(withinSession);
  const fetchedIssues = Array.isArray(series.dataQuality?.issues)
    ? series.dataQuality.issues
    : null;
  const issues = fetchedIssues?.filter((entry) => !(
    DROPPED_ROW_ISSUE_CODES.has(entry?.code) && entry?.timestamp && !withinSession(entry)
  ));
  const discardedRows = fetchedIssues ? fetchedIssues.length - issues.length : 0;
  if (bars.length === series.bars.length
    && events.length === series.events.length
    && !discardedRows) {
    return series;
  }

  const dataQuality = { ...series.dataQuality, rowCount: bars.length };
  if (fetchedIssues) {
    dataQuality.issues = issues;
    dataQuality.droppedRows = Math.max(0, (dataQuality.droppedRows ?? 0) - discardedRows);
  }
  if (series.priceBasis === "provider_adjusted") {
    dataQuality.missingAdjustedCloseRows = bars
      .filter(({ adjustedClose }) => !Number.isFinite(adjustedClose)).length;
    if (!dataQuality.missingAdjustedCloseRows && Array.isArray(dataQuality.issues)) {
      dataQuality.issues = dataQuality.issues
        .filter(({ code }) => code !== "partial_adjusted_series");
    }
  }
  if (dataQuality.status === "usable_with_warnings"
    && Array.isArray(dataQuality.issues)
    && !dataQuality.issues.length) {
    dataQuality.status = "usable";
  }
  return {
    ...series,
    bars,
    events,
    ...(bars.length ? { asOf: bars.at(-1).timestamp } : {}),
    dataQuality,
  };
}

function prepareExpectedSeries({
  instrumentId,
  index,
  engine,
  role,
  sessionGridHash,
  completedSessionDate,
}) {
  const itemError = index.errorsById.get(instrumentId);
  if (itemError) {
    return {
      instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.ITEM_FAILED],
      upstreamCode: normalizedErrorCode(itemError),
    };
  }
  if (index.duplicates.has(instrumentId)) {
    return {
      instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.DUPLICATE_HISTORY],
      upstreamCode: null,
    };
  }
  const fetched = index.seriesById.get(instrumentId);
  if (!fetched) {
    return {
      instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.HISTORY_MISSING],
      upstreamCode: null,
    };
  }
  if (!matchesHistoryRequest(fetched)) {
    return {
      instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.REQUEST_MISMATCH],
      upstreamCode: null,
    };
  }
  try {
    const series = seriesThroughSession(fetched, completedSessionDate);
    engine.validateHistory(series, `${role}Series`);
    return {
      instrumentId,
      status: "ready",
      series,
      seriesHash: historySeriesHash(
        historySeriesProjection(series),
        sessionGridHash,
      ),
    };
  } catch (error) {
    return {
      instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.INVALID_HISTORY],
      upstreamCode: normalizedErrorCode(error),
    };
  }
}

function applyFetchedAtCutoff(prepared, computedAt) {
  if (prepared.status !== "ready") return prepared;
  const fetchedAt = Date.parse(prepared.series.fetchedAt);
  const computeTime = Date.parse(computedAt);
  if (!Number.isFinite(fetchedAt)) {
    return {
      instrumentId: prepared.instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.INVALID_HISTORY],
      upstreamCode: null,
    };
  }
  if (fetchedAt > computeTime) {
    return {
      instrumentId: prepared.instrumentId,
      status: "failed",
      reasonCodes: [REASON_CODES.FUTURE_FETCHED_AT],
      upstreamCode: null,
    };
  }
  return prepared;
}

function runnerConfig(equityInstrumentIds) {
  return Object.freeze({
    analyticsSchemaVersion: ANALYTICS_SCHEMA_VERSION,
    benchmarkInstrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
    cutoffUtc: DAILY_ANALYTICS_CUTOFF_UTC,
    equityInstrumentIds: Object.freeze([...equityInstrumentIds]),
    historyRequest: HISTORY_REQUEST,
    methodVersion: MOVEMENT_METHOD_VERSION,
    missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
    model: Object.freeze({
      empirical: Object.freeze({
        correction: EMPIRICAL_CORRECTION,
        referenceScores: EMPIRICAL_REFERENCE_SCORES,
        tail: EMPIRICAL_TAIL,
        tiePolicy: EMPIRICAL_TIE_POLICY,
      }),
      ewma: Object.freeze({
        lambda: EWMA_LAMBDA,
        missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
        version: EWMA_MODEL_VERSION,
        warmupReturns: EWMA_WARMUP_RETURNS,
      }),
      quality: Object.freeze({
        maxMissingRate: MOVEMENT_MAX_MISSING_RATE,
        requiredValidReturns: MOVEMENT_REQUIRED_VALID_RETURNS,
        version: MOVEMENT_QUALITY_VERSION,
      }),
      sessionCalendarId: MOVEMENT_SESSION_CALENDAR_ID,
    }),
    runnerVersion: DAILY_ANALYTICS_RUNNER_VERSION,
  });
}

function manifestEntry(prepared) {
  if (prepared.status === "ready") {
    return {
      instrumentId: prepared.instrumentId,
      status: "ready",
      seriesHash: prepared.seriesHash,
    };
  }
  return {
    instrumentId: prepared.instrumentId,
    status: "failed",
    reasonCodes: prepared.reasonCodes,
    upstreamCode: prepared.upstreamCode,
  };
}

function sessionIdentity(sessionAuthority) {
  return {
    completedSessionDate: sessionAuthority.completedSessionDate,
    nextSessionDate: sessionAuthority.nextSessionDate,
    sessionGrid: sessionAuthority.sessionGridIdentity,
  };
}

function runIdentity(configHash, benchmark, preparedAssets, sessionAuthority) {
  return analyticsSha256({
    configHash,
    sessionAuthority: sessionIdentity(sessionAuthority),
    benchmark: manifestEntry(benchmark),
    assets: preparedAssets.map(manifestEntry),
  });
}

function latestSeriesSessionDate(series) {
  return series.bars
    .map(({ timestamp }) => (
      sessionDateFromTimestamp(timestamp, series.session.timezone)
    ))
    .reduce((latest, sessionDate) => (
      sessionDate > latest ? sessionDate : latest
    ));
}

function deriveProspectiveForecast(assessment, completedSessionDate) {
  const currentVariance = assessment.forecast.variance;
  const realizedLogReturn = assessment.evidence.observed.logReturn;
  const variance = (EWMA_LAMBDA * currentVariance)
    + ((1 - EWMA_LAMBDA) * (realizedLogReturn ** 2));
  const forecast = {
    ...assessment.forecast,
    originSessionDate: completedSessionDate,
    informationSetEnd: completedSessionDate,
    variance,
    dailyVolatility: Math.sqrt(variance),
  };
  return validateVolatilityForecast(forecast);
}

function historyInputRecords(series, seriesHash, sessionAuthority) {
  const observedAt = series.fetchedAt;
  const observations = series.bars.map((bar) => (
    historyObservationFromSeries({
      series,
      bar,
      observedAt,
      sessionDate: sessionDateFromTimestamp(
        bar.timestamp,
        series.session.timezone,
      ),
    })
  ));
  const sessionDates = observations.map(({ sessionDate }) => sessionDate);
  return {
    observations,
    manifest: {
      seriesHash,
      instrumentId: series.instrumentId,
      assetClass: series.assetClass,
      range: series.range,
      interval: series.interval,
      observedAt,
      provider: series.provenance.source,
      providerSymbol: series.provenance.providerSymbol,
      fallback: series.provenance.fallback,
      originalSource: series.provenance.originalSource ?? null,
      priceBasis: series.priceBasis,
      requestedPriceBasis: series.requestedPriceBasis,
      adjustment: series.adjustment,
      continuity: series.continuity,
      session: series.session,
      quality: series.quality,
      dataQuality: series.dataQuality,
      sourceAsOf: series.asOf,
      firstSessionDate: sessionDates[0],
      lastSessionDate: sessionDates.at(-1),
      barCount: observations.length,
      sessionDates,
      barTimestamps: series.bars.map(({ timestamp }) => timestamp),
      barInputHashes: observations.map(({ inputHash }) => inputHash),
      sessionGrid: {
        gridHash: sessionAuthority.sessionGridIdentity.inputHash,
        calendarId: sessionAuthority.sessionGrid.calendarId,
        source: sessionAuthority.sessionGrid.source,
        revision: sessionAuthority.sessionGrid.revision,
        timeZone: sessionAuthority.sessionGrid.timeZone,
        sessionDates: sessionAuthority.sessionGrid.sessionDates,
      },
      fetchCutoff: {
        throughObservedAt: observedAt,
        predicate: HISTORY_CUTOFF_PREDICATE,
        revisionSelection: HISTORY_REVISION_SELECTION,
        sessionMembership: HISTORY_SESSION_MEMBERSHIP,
      },
    },
  };
}

async function persistHistoryInput(
  store,
  series,
  seriesHash,
  sessionAuthority,
) {
  const historyInput = historyInputRecords(
    series,
    seriesHash,
    sessionAuthority,
  );
  return store.appendHistoryInput(historyInput);
}

function analyticsInputHash({
  assetSeriesHash,
  benchmarkSeriesHash,
  sessionGridHash,
  purpose,
  informationSetEnd,
}) {
  return analyticsSha256({
    assetSeriesHash,
    benchmarkSeriesHash,
    sessionGridHash,
    purpose,
    informationSetEnd,
    historySelection:
      "manifest_cutoff_then_session_dates_lte_information_set_end",
    missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
  });
}

function runInputManifest(benchmark, preparedAssets, sessionAuthority) {
  const sessionSentinel = benchmark.status === "ready"
    ? {
      instrumentId: benchmark.instrumentId,
      seriesHash: benchmark.seriesHash,
    }
    : null;
  const assets = (benchmark.status === "ready" ? preparedAssets : [])
    .filter(({ status }) => status === "ready")
    .map((prepared) => ({
      instrumentId: prepared.instrumentId,
      assetSeriesHash: prepared.seriesHash,
      assessmentInputHash: analyticsInputHash({
        assetSeriesHash: prepared.seriesHash,
        benchmarkSeriesHash: benchmark.seriesHash,
        sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
        purpose: "movement_assessment",
        informationSetEnd: sessionAuthority.completedSessionDate,
      }),
    }))
    .sort(byInstrumentIdCodeUnit);
  return {
    sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
    sessionSentinel,
    missingReturnPolicy: EWMA_MISSING_RETURN_POLICY,
    historySelection: {
      ...HISTORY_REQUEST,
      predicate: HISTORY_CUTOFF_PREDICATE,
      revisionSelection: HISTORY_REVISION_SELECTION,
      sessionMembership: HISTORY_SESSION_MEMBERSHIP,
    },
    assets,
  };
}

function completedStatus(results) {
  return results.some(({ status }) => status === "failed")
    ? "completed_with_failures"
    : "completed";
}

function countResults(results) {
  return {
    requested: results.length,
    available: results.filter(({ status }) => status === "available").length,
    unavailable: results.filter(({ status }) => status === "unavailable").length,
    failed: results.filter(({ status }) => status === "failed").length,
  };
}

function benchmarkFailureSummary({
  runId,
  configHash,
  computedAt,
  sessionAuthority,
  equityInstrumentIds,
  benchmark,
  inputManifest,
  status = "benchmark_unavailable",
  resultReasonCodes = [REASON_CODES.BENCHMARK_UNAVAILABLE],
}) {
  const results = equityInstrumentIds.map((instrumentId) => resultFailure(
    instrumentId,
    resultReasonCodes,
  ));
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runnerVersion: DAILY_ANALYTICS_RUNNER_VERSION,
    runId,
    configHash,
    computedAt,
    ...sessionIdentity(sessionAuthority),
    inputManifest,
    status,
    benchmark: {
      instrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
      status: "failed",
      reasonCodes: benchmark.reasonCodes,
      ...(benchmark.observedSessionDate
        ? { observedSessionDate: benchmark.observedSessionDate }
        : {}),
      ...(benchmark.upstreamCode ? { upstreamCode: benchmark.upstreamCode } : {}),
    },
    counts: countResults(results),
    results,
  };
}

function rejectedBatchSummary({
  runId,
  configHash,
  computedAt,
  sessionAuthority,
  equityInstrumentIds,
  upstreamCode,
  inputManifest,
}) {
  const results = equityInstrumentIds.map((instrumentId) => resultFailure(
    instrumentId,
    [REASON_CODES.BATCH_FAILED],
    upstreamCode,
  ));
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runnerVersion: DAILY_ANALYTICS_RUNNER_VERSION,
    runId,
    configHash,
    computedAt,
    ...sessionIdentity(sessionAuthority),
    inputManifest,
    status: "batch_failed",
    benchmark: {
      instrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
      status: "failed",
      reasonCodes: [REASON_CODES.BATCH_FAILED],
      ...(upstreamCode ? { upstreamCode } : {}),
    },
    counts: countResults(results),
    results,
  };
}

function failureSummaryFromRun(summary) {
  return {
    benchmark: {
      instrumentId: summary.benchmark.instrumentId,
      status: summary.benchmark.status,
      reasonCodes: [...summary.benchmark.reasonCodes],
      ...(summary.benchmark.upstreamCode
        ? { upstreamCode: summary.benchmark.upstreamCode }
        : {}),
      ...(summary.benchmark.observedSessionDate
        ? { observedSessionDate: summary.benchmark.observedSessionDate }
        : {}),
    },
    results: summary.results
      .filter(({ status }) => status !== "available")
      .map((result) => ({
        instrumentId: result.instrumentId,
        status: result.status,
        reasonCodes: [...result.reasonCodes],
        ...(result.upstreamCode ? { upstreamCode: result.upstreamCode } : {}),
        ...(result.failedRecords ? { failedRecords: [...result.failedRecords] } : {}),
      })),
    sessionGrid: summary.sessionGrid,
  };
}

function byInstrumentIdCodeUnit(left, right) {
  if (left.instrumentId === right.instrumentId) return 0;
  return left.instrumentId < right.instrumentId ? -1 : 1;
}

export class DailyAnalyticsRunner {
  constructor({
    historyService,
    analyticsStore,
    equityInstrumentIds,
    engine = new AnalyticsEngine(),
    clock = () => new Date(),
  } = {}) {
    assertDependencies(historyService, analyticsStore, engine, clock);
    this.historyService = historyService;
    this.analyticsStore = analyticsStore;
    this.equityInstrumentIds = normalizeEquityInstrumentIds(equityInstrumentIds);
    this.engine = engine;
    this.clock = clock;
    this.baseConfig = runnerConfig(this.equityInstrumentIds);
  }

  async run(sessionOptions) {
    const now = toDate(this.clock(), "clock");
    const startedAt = now.toISOString();
    const sessionAuthority = normalizeSessionAuthority(sessionOptions, now, this.engine);
    const configSnapshot = {
      ...this.baseConfig,
      sessionGrid: sessionAuthority.sessionGridIdentity,
    };
    const configHash = analyticsSha256(configSnapshot);
    if (!cutoffReached(now)) {
      const error = new RangeError(
        `Daily analytics cannot run before ${DAILY_ANALYTICS_CUTOFF_UTC} UTC`,
      );
      error.code = "analytics_cutoff_not_reached";
      throw error;
    }
    const ids = [...this.equityInstrumentIds, MOVEMENT_BENCHMARK_INSTRUMENT_ID];

    let batch;
    try {
      batch = await this.historyService.getHistoryBatch(ids, { ...HISTORY_REQUEST });
    } catch (error) {
      const computedAt = toDate(this.clock(), "clock").toISOString();
      const upstreamCode = normalizedErrorCode(error);
      const runId = runIdentity(
        configHash,
        {
          instrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
          status: "failed",
          reasonCodes: [REASON_CODES.BATCH_FAILED],
          upstreamCode,
        },
        this.equityInstrumentIds.map((instrumentId) => ({
          instrumentId,
          status: "failed",
          reasonCodes: [REASON_CODES.BATCH_FAILED],
          upstreamCode,
        })),
        sessionAuthority,
      );
      return this.finalizeSummary(rejectedBatchSummary({
        runId,
        configHash,
        computedAt,
        sessionAuthority,
        equityInstrumentIds: this.equityInstrumentIds,
        upstreamCode,
        inputManifest: runInputManifest(
          { status: "failed" },
          [],
          sessionAuthority,
        ),
      }), startedAt, configSnapshot);
    }

    const index = indexBatchData(batch);
    const preparedBenchmark = prepareExpectedSeries({
      instrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
      index,
      engine: this.engine,
      role: "benchmark",
      sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
      completedSessionDate: sessionAuthority.completedSessionDate,
    });
    const validatedAssets = this.equityInstrumentIds.map((instrumentId) => (
      prepareExpectedSeries({
        instrumentId,
        index,
        engine: this.engine,
        role: "asset",
        sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
        completedSessionDate: sessionAuthority.completedSessionDate,
      })
    ));
    const computedAt = toDate(this.clock(), "clock").toISOString();
    const benchmark = applyFetchedAtCutoff(preparedBenchmark, computedAt);
    const preparedAssets = validatedAssets.map((prepared) => (
      applyFetchedAtCutoff(prepared, computedAt)
    ));
    const runId = runIdentity(
      configHash,
      benchmark,
      preparedAssets,
      sessionAuthority,
    );
    const inputManifest = runInputManifest(
      benchmark,
      preparedAssets,
      sessionAuthority,
    );
    const unresolvedSeries = new Set();

    if (benchmark.status === "ready") {
      try {
        await persistHistoryInput(
          this.analyticsStore,
          benchmark.series,
          benchmark.seriesHash,
          sessionAuthority,
        );
      } catch {
        return this.finalizeSummary(benchmarkFailureSummary({
          runId,
          configHash,
          computedAt,
          sessionAuthority,
          equityInstrumentIds: this.equityInstrumentIds,
          inputManifest: runInputManifest(
            { status: "failed" },
            [],
            sessionAuthority,
          ),
          benchmark: {
            ...benchmark,
            status: "failed",
            reasonCodes: [REASON_CODES.PERSISTENCE_FAILED],
            upstreamCode: null,
          },
          status: "failed",
          resultReasonCodes: [REASON_CODES.PERSISTENCE_FAILED],
        }), startedAt, configSnapshot);
      }
    }

    if (benchmark.status === "ready") {
      for (const prepared of preparedAssets) {
        if (prepared.status !== "ready") continue;
        try {
          await persistHistoryInput(
            this.analyticsStore,
            prepared.series,
            prepared.seriesHash,
            sessionAuthority,
          );
        } catch {
          unresolvedSeries.add(prepared.instrumentId);
        }
      }
    }
    const persistedInputManifest = {
      ...inputManifest,
      assets: inputManifest.assets.filter(({ instrumentId }) => (
        !unresolvedSeries.has(instrumentId)
      )),
    };

    if (benchmark.status !== "ready"
      || benchmark.series.instrumentId !== MOVEMENT_BENCHMARK_INSTRUMENT_ID
      || benchmark.series.assetClass !== "etf") {
      const failedBenchmark = benchmark.status === "ready"
        ? {
          ...benchmark,
          status: "failed",
          reasonCodes: [REASON_CODES.INVALID_HISTORY],
          upstreamCode: null,
        }
        : benchmark;
      return this.finalizeSummary(benchmarkFailureSummary({
        runId,
        configHash,
        computedAt,
        sessionAuthority,
        equityInstrumentIds: this.equityInstrumentIds,
        benchmark: failedBenchmark,
        inputManifest: persistedInputManifest,
      }), startedAt, configSnapshot);
    }

    const observedBenchmarkSessionDate = latestSeriesSessionDate(benchmark.series);
    if (observedBenchmarkSessionDate !== sessionAuthority.completedSessionDate) {
      return this.finalizeSummary(benchmarkFailureSummary({
        runId,
        configHash,
        computedAt,
        sessionAuthority,
        equityInstrumentIds: this.equityInstrumentIds,
        inputManifest: persistedInputManifest,
        benchmark: {
          ...benchmark,
          status: "failed",
          reasonCodes: [REASON_CODES.BENCHMARK_SESSION_MISMATCH],
          upstreamCode: null,
          observedSessionDate: observedBenchmarkSessionDate,
        },
      }), startedAt, configSnapshot);
    }

    const results = [];
    for (const prepared of preparedAssets) {
      if (prepared.status !== "ready") {
        results.push(resultFailure(
          prepared.instrumentId,
          prepared.reasonCodes,
          prepared.upstreamCode,
        ));
        continue;
      }

      const inputHash = analyticsInputHash({
        assetSeriesHash: prepared.seriesHash,
        benchmarkSeriesHash: benchmark.seriesHash,
        sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
        purpose: "movement_assessment",
        informationSetEnd: sessionAuthority.completedSessionDate,
      });
      if (unresolvedSeries.has(prepared.instrumentId)) {
        results.push({
          instrumentId: prepared.instrumentId,
          status: "failed",
          reasonCodes: [REASON_CODES.PERSISTENCE_FAILED],
          failedRecords: ["historyInput"],
          inputHash,
        });
        continue;
      }

      let assessment;
      try {
        assessment = this.engine.assessMovement({
          assetSeries: prepared.series,
          benchmarkSeries: benchmark.series,
          sessionGrid: sessionAuthority.sessionGrid,
        });
      } catch (error) {
        results.push(resultFailure(
          prepared.instrumentId,
          [REASON_CODES.CALCULATION_FAILED],
          normalizedErrorCode(error),
        ));
        continue;
      }

      let prospectiveForecast = null;
      if (assessment.status === "available") {
        if (assessment.sessionDate !== sessionAuthority.completedSessionDate) {
          results.push(resultFailure(
            prepared.instrumentId,
            [REASON_CODES.CALCULATION_FAILED],
          ));
          continue;
        }
        try {
          prospectiveForecast = deriveProspectiveForecast(
            assessment,
            sessionAuthority.completedSessionDate,
          );
        } catch (error) {
          results.push(resultFailure(
            prepared.instrumentId,
            [REASON_CODES.CALCULATION_FAILED],
            normalizedErrorCode(error),
          ));
          continue;
        }
      }

      const persistenceFailures = [];

      if (assessment.status === "available") {
        const backfillInputHash = analyticsInputHash({
          assetSeriesHash: prepared.seriesHash,
          benchmarkSeriesHash: benchmark.seriesHash,
          sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
          purpose: "volatility_forecast_backfill",
          informationSetEnd: assessment.forecast.informationSetEnd,
        });
        const liveInputHash = analyticsInputHash({
          assetSeriesHash: prepared.seriesHash,
          benchmarkSeriesHash: benchmark.seriesHash,
          sessionGridHash: sessionAuthority.sessionGridIdentity.inputHash,
          purpose: "volatility_forecast_live",
          informationSetEnd: sessionAuthority.completedSessionDate,
        });
        try {
          await this.analyticsStore.appendForecast({
            runId,
            targetSessionDate: sessionAuthority.completedSessionDate,
            informationSetEnd: assessment.forecast.informationSetEnd,
            recordedAt: computedAt,
            origin: "backfill",
            inputHash: backfillInputHash,
            configHash,
            forecast: assessment.forecast,
          });
        } catch {
          persistenceFailures.push("backfillForecast");
        }
        try {
          await this.analyticsStore.appendForecast({
            runId,
            targetSessionDate: sessionAuthority.nextSessionDate,
            informationSetEnd: prospectiveForecast.informationSetEnd,
            recordedAt: computedAt,
            origin: "live",
            inputHash: liveInputHash,
            configHash,
            forecast: prospectiveForecast,
          });
        } catch {
          persistenceFailures.push("liveForecast");
        }
      }

      if (!persistenceFailures.length) {
        try {
          await this.analyticsStore.appendAssessment({
            runId,
            computedAt,
            inputHash,
            configHash,
            assessment,
          });
        } catch {
          persistenceFailures.push("assessment");
        }
      }

      if (persistenceFailures.length) {
        results.push({
          instrumentId: prepared.instrumentId,
          status: "failed",
          reasonCodes: [REASON_CODES.PERSISTENCE_FAILED],
          failedRecords: persistenceFailures,
          inputHash,
        });
        continue;
      }

      results.push({
        instrumentId: prepared.instrumentId,
        status: assessment.status,
        ...(assessment.sessionDate ? { sessionDate: assessment.sessionDate } : {}),
        reasonCodes: [...assessment.quality.reasonCodes],
        inputHash,
      });
    }

    return this.finalizeSummary({
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      runnerVersion: DAILY_ANALYTICS_RUNNER_VERSION,
      runId,
      configHash,
      computedAt,
      ...sessionIdentity(sessionAuthority),
      inputManifest: persistedInputManifest,
      status: completedStatus(results),
      benchmark: {
        instrumentId: MOVEMENT_BENCHMARK_INSTRUMENT_ID,
        status: "available",
        observedSessionDate: observedBenchmarkSessionDate,
        inputHash: benchmark.seriesHash,
        reasonCodes: [],
      },
      counts: countResults(results),
      results,
    }, startedAt, configSnapshot);
  }

  async finalizeSummary(summary, startedAt, configSnapshot) {
    const completedAt = toDate(this.clock(), "clock").toISOString();
    const failureSummary = failureSummaryFromRun(summary);
    const attemptId = analyticsSha256({
      runId: summary.runId,
      startedAt,
      completedAt,
      status: summary.status,
      counts: summary.counts,
      inputManifest: summary.inputManifest,
      failureSummary,
    });
    const attempt = await this.analyticsStore.appendRunAttempt({
      attemptId,
      runId: summary.runId,
      expectedCompletedSessionDate: summary.completedSessionDate,
      expectedNextSessionDate: summary.nextSessionDate,
      startedAt,
      completedAt,
      configHash: summary.configHash,
      configSnapshot,
      status: summary.status,
      counts: summary.counts,
      inputManifest: summary.inputManifest,
      failureSummary,
    });
    return {
      ...summary,
      attemptId: attempt.attemptId,
      completedAt: attempt.completedAt,
    };
  }
}
