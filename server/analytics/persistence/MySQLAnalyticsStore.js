import { closeOwnedPool } from "../../cache/MySQLSnapshotStore.js";
import { ERROR_CODES } from "../../contracts/core/constants.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import {
  assessmentsEquivalent,
  cloneAssessmentRecord,
  cloneDailyObservationRecord,
  cloneForecastRecord,
  cloneHistoryManifestRecord,
  cloneRunAttemptRecord,
  createDailyObservationRecord,
  dailyObservationsEquivalent,
  forecastsEquivalent,
  historyManifestsEquivalent,
  normalizeAssessmentRecord,
  normalizeDailyObservationRecord,
  normalizeDailyObservationInput,
  normalizeDigest,
  normalizeForecastRecord,
  normalizeForecastOrigin,
  normalizeHistoryInputRecord,
  normalizeHistoryManifestRecord,
  normalizeInstrumentId,
  normalizeRunAttemptRecord,
  normalizeSessionDate,
  runAttemptsEquivalent,
  toAnalyticsIsoTimestamp,
} from "./records.js";

const DEFAULT_TABLES = Object.freeze({
  observations: "market_daily_bar_observation",
  forecasts: "market_volatility_forecast",
  assessments: "market_movement_assessment",
  manifests: "market_history_series_manifest",
  runAttempts: "market_analytics_run_attempt",
});

function selectRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

function rowValue(row, camel, snake) {
  return row[camel] ?? row[snake];
}

function parseJson(value, label) {
  let parsed = value;
  if (Buffer.isBuffer(value)) parsed = value.toString("utf8");
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (cause) {
      throw new TypeError(`${label} contains invalid JSON`, { cause });
    }
  }
  return parsed;
}

function databaseBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return value;
}

function observationFromRow(row) {
  const providerClose = rowValue(row, "providerClose", "provider_close");
  const providerAdjustedClose = rowValue(
    row,
    "providerAdjustedClose",
    "provider_adjusted_close",
  );
  const providerVolume = rowValue(row, "providerVolume", "provider_volume");
  return normalizeDailyObservationRecord({
    instrumentId: rowValue(row, "instrumentId", "instrument_id"),
    sessionDate: rowValue(row, "sessionDate", "session_date"),
    revision: Number(row.revision),
    observedAt: rowValue(row, "observedAt", "observed_at"),
    provider: row.provider,
    inputHash: rowValue(row, "inputHash", "input_hash"),
    bar: {
      providerClose: providerClose == null ? providerClose : Number(providerClose),
      providerAdjustedClose: providerAdjustedClose == null
        ? providerAdjustedClose
        : Number(providerAdjustedClose),
      providerVolume: providerVolume == null ? providerVolume : Number(providerVolume),
    },
  });
}

function forecastFromRow(row) {
  const instrumentId = normalizeInstrumentId(
    rowValue(row, "instrumentId", "instrument_id"),
  );
  const record = normalizeForecastRecord({
    runId: rowValue(row, "runId", "run_id"),
    targetSessionDate: rowValue(row, "targetSessionDate", "target_session_date"),
    informationSetEnd: rowValue(row, "informationSetEnd", "information_set_end"),
    recordedAt: rowValue(row, "recordedAt", "recorded_at"),
    origin: row.origin,
    inputHash: rowValue(row, "inputHash", "input_hash"),
    configHash: rowValue(row, "configHash", "config_hash"),
    forecast: parseJson(rowValue(row, "forecast", "forecast_json"), "forecast_json"),
  });
  if (record.forecast.instrumentId !== instrumentId) {
    throw new TypeError("Forecast JSON instrumentId does not match its indexed column");
  }
  return record;
}

function assessmentFromRow(row) {
  const instrumentId = normalizeInstrumentId(
    rowValue(row, "instrumentId", "instrument_id"),
  );
  const indexedSessionDate = rowValue(row, "sessionDate", "session_date");
  const sessionDate = indexedSessionDate === null
    ? null
    : normalizeSessionDate(indexedSessionDate);
  const record = normalizeAssessmentRecord({
    runId: rowValue(row, "runId", "run_id"),
    computedAt: rowValue(row, "computedAt", "computed_at"),
    inputHash: rowValue(row, "inputHash", "input_hash"),
    configHash: rowValue(row, "configHash", "config_hash"),
    assessment: parseJson(
      rowValue(row, "assessment", "assessment_json"),
      "assessment_json",
    ),
  });
  if (record.assessment.instrumentId !== instrumentId) {
    throw new TypeError("Assessment JSON instrumentId does not match its indexed column");
  }
  if (record.assessment.sessionDate !== sessionDate) {
    throw new TypeError("Assessment JSON sessionDate does not match its indexed column");
  }
  return record;
}

function manifestFromRow(row) {
  const indexedGridHash = normalizeDigest(
    rowValue(row, "sessionGridHash", "session_grid_hash"),
    "sessionGridHash",
  );
  const record = normalizeHistoryManifestRecord({
    seriesHash: rowValue(row, "seriesHash", "series_hash"),
    instrumentId: rowValue(row, "instrumentId", "instrument_id"),
    assetClass: rowValue(row, "assetClass", "asset_class"),
    range: rowValue(row, "range", "history_range"),
    interval: rowValue(row, "interval", "history_interval"),
    observedAt: rowValue(row, "observedAt", "observed_at"),
    provider: row.provider,
    providerSymbol: rowValue(row, "providerSymbol", "provider_symbol"),
    fallback: databaseBoolean(row.fallback),
    originalSource: rowValue(row, "originalSource", "original_source"),
    priceBasis: rowValue(row, "priceBasis", "price_basis"),
    requestedPriceBasis: rowValue(
      row,
      "requestedPriceBasis",
      "requested_price_basis",
    ),
    adjustment: parseJson(
      rowValue(row, "adjustment", "adjustment_json"),
      "adjustment_json",
    ),
    continuity: parseJson(
      rowValue(row, "continuity", "continuity_json"),
      "continuity_json",
    ),
    session: parseJson(rowValue(row, "session", "session_json"), "session_json"),
    quality: row.quality,
    dataQuality: parseJson(
      rowValue(row, "dataQuality", "data_quality_json"),
      "data_quality_json",
    ),
    sourceAsOf: rowValue(row, "sourceAsOf", "source_as_of"),
    firstSessionDate: rowValue(row, "firstSessionDate", "first_session_date"),
    lastSessionDate: rowValue(row, "lastSessionDate", "last_session_date"),
    barCount: Number(rowValue(row, "barCount", "bar_count")),
    sessionDates: parseJson(
      rowValue(row, "sessionDates", "session_dates_json"),
      "session_dates_json",
    ),
    barTimestamps: parseJson(
      rowValue(row, "barTimestamps", "bar_timestamps_json"),
      "bar_timestamps_json",
    ),
    barInputHashes: parseJson(
      rowValue(row, "barInputHashes", "bar_input_hashes_json"),
      "bar_input_hashes_json",
    ),
    sessionGrid: parseJson(
      rowValue(row, "sessionGrid", "session_grid_json"),
      "session_grid_json",
    ),
    fetchCutoff: parseJson(
      rowValue(row, "fetchCutoff", "fetch_cutoff_json"),
      "fetch_cutoff_json",
    ),
  });
  if (record.sessionGrid.gridHash !== indexedGridHash) {
    throw new TypeError("History manifest grid hash does not match its indexed column");
  }
  return record;
}

function runAttemptFromRow(row) {
  const indexedGridHash = normalizeDigest(
    rowValue(row, "sessionGridHash", "session_grid_hash"),
    "sessionGridHash",
  );
  const record = normalizeRunAttemptRecord({
    attemptId: rowValue(row, "attemptId", "attempt_id"),
    runId: rowValue(row, "runId", "run_id"),
    expectedCompletedSessionDate: rowValue(
      row,
      "expectedCompletedSessionDate",
      "expected_completed_session_date",
    ),
    expectedNextSessionDate: rowValue(
      row,
      "expectedNextSessionDate",
      "expected_next_session_date",
    ),
    startedAt: rowValue(row, "startedAt", "started_at"),
    completedAt: rowValue(row, "completedAt", "completed_at"),
    configHash: rowValue(row, "configHash", "config_hash"),
    configSnapshot: parseJson(
      rowValue(row, "configSnapshot", "config_snapshot_json"),
      "config_snapshot_json",
    ),
    status: row.status,
    counts: {
      requested: Number(rowValue(row, "requestedCount", "requested_count")),
      available: Number(rowValue(row, "availableCount", "available_count")),
      unavailable: Number(rowValue(row, "unavailableCount", "unavailable_count")),
      failed: Number(rowValue(row, "failedCount", "failed_count")),
    },
    inputManifest: parseJson(
      rowValue(row, "inputManifest", "input_manifest_json"),
      "input_manifest_json",
    ),
    failureSummary: parseJson(
      rowValue(row, "failureSummary", "failure_summary_json"),
      "failure_summary_json",
    ),
  });
  if (record.inputManifest.sessionGridHash !== indexedGridHash) {
    throw new TypeError("Run attempt grid hash does not match its indexed column");
  }
  return record;
}

function assertTableName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]+$/u.test(value)) {
    throw new TypeError(`${label} may contain only letters, digits, and underscores`);
  }
  return value;
}

function assertMatchingRecord(existing, candidate, equivalent, label) {
  if (!equivalent(existing, candidate)) {
    throw new TypeError(`${label} identity collides with different persisted content`);
  }
}

function observationRecency(left, right) {
  const observedOrder = left.observedAt.localeCompare(right.observedAt);
  return observedOrder || (left.revision - right.revision);
}

function appendObservationRevision(revisions, candidate) {
  const sameEvent = revisions.find((entry) => (
    entry.observedAt === candidate.observedAt
    && entry.inputHash === candidate.inputHash
  ));
  if (sameEvent) {
    assertMatchingRecord(
      sameEvent,
      candidate,
      dailyObservationsEquivalent,
      "Daily observation",
    );
    return { record: sameEvent, inserted: false };
  }
  const priorState = revisions
    .filter((entry) => entry.observedAt <= candidate.observedAt)
    .sort(observationRecency)
    .at(-1);
  if (priorState?.inputHash === candidate.inputHash) {
    assertMatchingRecord(
      priorState,
      candidate,
      dailyObservationsEquivalent,
      "Daily observation",
    );
    return { record: priorState, inserted: false };
  }

  const record = createDailyObservationRecord(
    candidate,
    Math.max(0, ...revisions.map(({ revision }) => revision)) + 1,
  );
  revisions.push(record);
  return { record, inserted: true };
}

function manifestInsertParameters(candidate) {
  return [
    candidate.seriesHash,
    candidate.instrumentId,
    candidate.assetClass,
    candidate.range,
    candidate.interval,
    candidate.observedAt,
    candidate.provider,
    candidate.providerSymbol,
    candidate.fallback,
    candidate.originalSource,
    candidate.priceBasis,
    candidate.requestedPriceBasis,
    JSON.stringify(candidate.adjustment),
    JSON.stringify(candidate.continuity),
    JSON.stringify(candidate.session),
    candidate.quality,
    JSON.stringify(candidate.dataQuality),
    candidate.sourceAsOf,
    candidate.firstSessionDate,
    candidate.lastSessionDate,
    candidate.barCount,
    JSON.stringify(candidate.sessionDates),
    JSON.stringify(candidate.barTimestamps),
    JSON.stringify(candidate.barInputHashes),
    candidate.sessionGrid.gridHash,
    JSON.stringify(candidate.sessionGrid),
    JSON.stringify(candidate.fetchCutoff),
  ];
}

function isDuplicateKeyError(error) {
  let candidate = error;
  while (candidate) {
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
    candidate = candidate.cause;
  }
  return false;
}

export class MySQLAnalyticsStore {
  constructor(poolOrOptions, options = {}) {
    const config = poolOrOptions?.pool
      ? poolOrOptions
      : { ...options, pool: poolOrOptions };
    const {
      pool,
      observationTableName = DEFAULT_TABLES.observations,
      forecastTableName = DEFAULT_TABLES.forecasts,
      assessmentTableName = DEFAULT_TABLES.assessments,
      manifestTableName = DEFAULT_TABLES.manifests,
      runAttemptTableName = DEFAULT_TABLES.runAttempts,
      ownsPool = false,
    } = config;

    if (!pool || (typeof pool.execute !== "function" && typeof pool.query !== "function")) {
      throw new TypeError("pool must expose execute(sql, params) or query(sql, params)");
    }
    const hasDedicatedConnection = typeof pool.getConnection === "function";
    const isTransactionalConnection = typeof pool.beginTransaction === "function"
      && typeof pool.commit === "function"
      && typeof pool.rollback === "function";
    if (!hasDedicatedConnection && !isTransactionalConnection) {
      throw new TypeError(
        "pool must expose getConnection() or beginTransaction/commit/rollback",
      );
    }

    this.pool = pool;
    this.observationTableName = assertTableName(
      observationTableName,
      "observationTableName",
    );
    this.forecastTableName = assertTableName(forecastTableName, "forecastTableName");
    this.assessmentTableName = assertTableName(
      assessmentTableName,
      "assessmentTableName",
    );
    this.manifestTableName = assertTableName(manifestTableName, "manifestTableName");
    this.runAttemptTableName = assertTableName(
      runAttemptTableName,
      "runAttemptTableName",
    );
    this.ownsPool = ownsPool === true;
    this.closePromise = null;
    this.executeQuery = (pool.execute || pool.query).bind(pool);
  }

  async appendDailyObservation(record) {
    const candidate = normalizeDailyObservationInput(record);
    return this.#runAppend("appendDailyObservation", async (execute) => {
      const result = await execute(
        `SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
                observed_at, provider, input_hash, provider_close,
                provider_adjusted_close, provider_volume
           FROM \`${this.observationTableName}\`
          WHERE instrument_id = ? AND session_date = ?
          ORDER BY revision ASC
          FOR UPDATE`,
        [candidate.instrumentId, candidate.sessionDate],
      );
      const revisions = selectRows(result).map(observationFromRow);
      const { record: stored, inserted } = appendObservationRevision(
        revisions,
        candidate,
      );
      if (!inserted) return cloneDailyObservationRecord(stored);
      await execute(
        `INSERT INTO \`${this.observationTableName}\` (
           instrument_id, session_date, revision, observed_at, provider, input_hash,
           provider_close, provider_adjusted_close, provider_volume
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stored.instrumentId,
          stored.sessionDate,
          stored.revision,
          stored.observedAt,
          stored.provider,
          stored.inputHash,
          stored.bar.providerClose,
          stored.bar.providerAdjustedClose,
          stored.bar.providerVolume,
        ],
      );
      return cloneDailyObservationRecord(stored);
    });
  }

  async appendHistoryInput(value) {
    const { observations, manifest } = normalizeHistoryInputRecord(value);
    return this.#runAppend("appendHistoryInput", async (execute) => {
      const sessionDates = [...new Set(observations.map(({ sessionDate }) => sessionDate))];
      const datePlaceholders = sessionDates.map(() => "?").join(", ");
      const observationResult = await execute(
        `SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
                observed_at, provider, input_hash, provider_close,
                provider_adjusted_close, provider_volume
           FROM \`${this.observationTableName}\`
          WHERE instrument_id = ? AND session_date IN (${datePlaceholders})
          ORDER BY session_date ASC, revision ASC
          FOR UPDATE`,
        [manifest.instrumentId, ...sessionDates],
      );
      const requestedDates = new Set(sessionDates);
      const revisionsByDate = new Map(sessionDates.map((date) => [date, []]));
      for (const row of selectRows(observationResult)) {
        const record = observationFromRow(row);
        if (record.instrumentId !== manifest.instrumentId
          || !requestedDates.has(record.sessionDate)) {
          throw new TypeError("History input observation row does not match its query");
        }
        revisionsByDate.get(record.sessionDate).push(record);
      }

      const inserted = [];
      const storedObservations = observations.map((candidate) => {
        const revisions = revisionsByDate.get(candidate.sessionDate);
        const planned = appendObservationRevision(revisions, candidate);
        if (planned.inserted) inserted.push(planned.record);
        return cloneDailyObservationRecord(planned.record);
      });

      const manifestResult = await execute(
        `SELECT series_hash, instrument_id, asset_class, history_range, history_interval,
                observed_at, provider, provider_symbol, fallback, original_source,
                price_basis, requested_price_basis, adjustment_json, continuity_json,
                session_json, quality, data_quality_json, source_as_of,
                CAST(first_session_date AS CHAR) AS first_session_date,
                CAST(last_session_date AS CHAR) AS last_session_date,
                bar_count, session_dates_json, bar_timestamps_json,
                bar_input_hashes_json, session_grid_hash, session_grid_json,
                fetch_cutoff_json
           FROM \`${this.manifestTableName}\`
          WHERE series_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [manifest.seriesHash],
      );
      const persistedManifestRow = selectRows(manifestResult)[0];
      const persistedManifest = persistedManifestRow
        ? manifestFromRow(persistedManifestRow)
        : null;
      if (persistedManifest) {
        assertMatchingRecord(
          persistedManifest,
          manifest,
          historyManifestsEquivalent,
          "History manifest",
        );
      }

      if (inserted.length > 0) {
        const placeholders = inserted
          .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .join(", ");
        await execute(
          `INSERT INTO \`${this.observationTableName}\` (
             instrument_id, session_date, revision, observed_at, provider, input_hash,
             provider_close, provider_adjusted_close, provider_volume
           ) VALUES ${placeholders}`,
          inserted.flatMap((record) => [
            record.instrumentId,
            record.sessionDate,
            record.revision,
            record.observedAt,
            record.provider,
            record.inputHash,
            record.bar.providerClose,
            record.bar.providerAdjustedClose,
            record.bar.providerVolume,
          ]),
        );
      }
      if (!persistedManifest) {
        await execute(
          `INSERT INTO \`${this.manifestTableName}\` (
             series_hash, instrument_id, asset_class, history_range, history_interval,
             observed_at, provider, provider_symbol, fallback, original_source,
             price_basis, requested_price_basis, adjustment_json, continuity_json,
             session_json, quality, data_quality_json, source_as_of,
             first_session_date, last_session_date, bar_count, session_dates_json,
             bar_timestamps_json, bar_input_hashes_json, session_grid_hash,
             session_grid_json, fetch_cutoff_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          manifestInsertParameters(manifest),
        );
      }
      return {
        observations: storedObservations,
        manifest: cloneHistoryManifestRecord(persistedManifest || manifest),
      };
    });
  }

  async getDailyObservation({ instrumentId, sessionDate, inputHash }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(sessionDate);
    const hash = normalizeDigest(inputHash, "inputHash");
    const result = await this.#execute(
      `SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
              observed_at, provider, input_hash, provider_close,
              provider_adjusted_close, provider_volume
         FROM \`${this.observationTableName}\`
        WHERE instrument_id = ? AND session_date = ? AND input_hash = ?
        ORDER BY observed_at DESC, revision DESC
        LIMIT 1`,
      [id, date, hash],
      "getDailyObservation",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    const record = observationFromRow(row);
    if (record.instrumentId !== id
      || record.sessionDate !== date
      || record.inputHash !== hash) {
      throw new TypeError("Daily observation row does not match its indexed query");
    }
    return cloneDailyObservationRecord(record);
  }

  async listDailyObservations({ instrumentId, sessionDate }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(sessionDate);
    const result = await this.#execute(
      `SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
              observed_at, provider, input_hash, provider_close,
              provider_adjusted_close, provider_volume
         FROM \`${this.observationTableName}\`
        WHERE instrument_id = ? AND session_date = ?
        ORDER BY revision ASC`,
      [id, date],
      "listDailyObservations",
    );
    return selectRows(result).map((row) => {
      const record = observationFromRow(row);
      if (record.instrumentId !== id || record.sessionDate !== date) {
        throw new TypeError("Daily observation row does not match its indexed query");
      }
      return cloneDailyObservationRecord(record);
    });
  }

  async listDailyObservationsAsOf({ instrumentId, throughObservedAt }) {
    const id = normalizeInstrumentId(instrumentId);
    const cutoff = toAnalyticsIsoTimestamp(throughObservedAt, "throughObservedAt");
    const result = await this.#execute(
      `SELECT instrument_id, session_date, revision, observed_at, provider, input_hash,
              provider_close, provider_adjusted_close, provider_volume
         FROM (
           SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
                  observed_at, provider, input_hash, provider_close,
                  provider_adjusted_close, provider_volume,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_date
                    ORDER BY observed_at DESC, revision DESC
                  ) AS observation_rank
             FROM \`${this.observationTableName}\`
            WHERE instrument_id = ? AND observed_at <= ?
         ) AS ranked_observations
        WHERE observation_rank = 1
        ORDER BY session_date ASC`,
      [id, cutoff],
      "listDailyObservationsAsOf",
    );
    return selectRows(result).map((row) => {
      const record = observationFromRow(row);
      if (record.instrumentId !== id || record.observedAt > cutoff) {
        throw new TypeError("As-of observation row does not match its indexed query");
      }
      return cloneDailyObservationRecord(record);
    });
  }

  async appendForecast(record) {
    const candidate = normalizeForecastRecord(record);
    return this.#runAppend("appendForecast", async (execute) => {
      const instrumentId = candidate.forecast.instrumentId;
      const identity = [
        candidate.runId,
        instrumentId,
        candidate.targetSessionDate,
        candidate.informationSetEnd,
        candidate.origin,
        candidate.inputHash,
        candidate.configHash,
      ];
      const result = await execute(
        `SELECT run_id, instrument_id,
                CAST(target_session_date AS CHAR) AS target_session_date,
                CAST(information_set_end AS CHAR) AS information_set_end,
                recorded_at, origin, input_hash, config_hash, forecast_json
           FROM \`${this.forecastTableName}\`
          WHERE run_id = ? AND instrument_id = ? AND target_session_date = ?
            AND information_set_end = ? AND origin = ?
            AND input_hash = ? AND config_hash = ?
          LIMIT 1
          FOR UPDATE`,
        identity,
      );
      const row = selectRows(result)[0];
      if (row) {
        const existing = forecastFromRow(row);
        assertMatchingRecord(existing, candidate, forecastsEquivalent, "Forecast");
        return cloneForecastRecord(existing);
      }

      await execute(
        `INSERT INTO \`${this.forecastTableName}\` (
           run_id, instrument_id, target_session_date, information_set_end,
           recorded_at, origin, input_hash, config_hash, forecast_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.runId,
          instrumentId,
          candidate.targetSessionDate,
          candidate.informationSetEnd,
          candidate.recordedAt,
          candidate.origin,
          candidate.inputHash,
          candidate.configHash,
          JSON.stringify(candidate.forecast),
        ],
      );
      return cloneForecastRecord(candidate);
    });
  }

  async getForecast({
    runId,
    instrumentId,
    targetSessionDate,
    informationSetEnd,
    origin,
    inputHash,
    configHash,
  }) {
    const identity = [
      normalizeDigest(runId, "runId"),
      normalizeInstrumentId(instrumentId),
      normalizeSessionDate(targetSessionDate, "targetSessionDate"),
      normalizeSessionDate(informationSetEnd, "informationSetEnd"),
      normalizeForecastOrigin(origin),
      normalizeDigest(inputHash, "inputHash"),
      normalizeDigest(configHash, "configHash"),
    ];
    const result = await this.#execute(
      `SELECT run_id, instrument_id,
              CAST(target_session_date AS CHAR) AS target_session_date,
              CAST(information_set_end AS CHAR) AS information_set_end,
              recorded_at, origin, input_hash, config_hash, forecast_json
         FROM \`${this.forecastTableName}\`
        WHERE run_id = ? AND instrument_id = ? AND target_session_date = ?
          AND information_set_end = ? AND origin = ?
          AND input_hash = ? AND config_hash = ?
        LIMIT 1`,
      identity,
      "getForecast",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    const record = forecastFromRow(row);
    if (record.runId !== identity[0] || record.forecast.instrumentId !== identity[1]) {
      throw new TypeError("Forecast row does not match its indexed query");
    }
    return cloneForecastRecord(record);
  }

  async listForecasts({ instrumentId, targetSessionDate }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(targetSessionDate, "targetSessionDate");
    const result = await this.#execute(
      `SELECT run_id, instrument_id,
              CAST(target_session_date AS CHAR) AS target_session_date,
              CAST(information_set_end AS CHAR) AS information_set_end,
              recorded_at, origin, input_hash, config_hash, forecast_json
         FROM \`${this.forecastTableName}\`
        WHERE instrument_id = ? AND target_session_date = ?
        ORDER BY recorded_at ASC`,
      [id, date],
      "listForecasts",
    );
    return selectRows(result).map((row) => {
      const record = forecastFromRow(row);
      if (record.forecast.instrumentId !== id || record.targetSessionDate !== date) {
        throw new TypeError("Forecast row does not match its indexed query");
      }
      return cloneForecastRecord(record);
    });
  }

  async appendAssessment(record) {
    const candidate = normalizeAssessmentRecord(record);
    return this.#runAppend("appendAssessment", async (execute) => {
      const instrumentId = candidate.assessment.instrumentId;
      const result = await execute(
        `SELECT run_id, instrument_id, CAST(session_date AS CHAR) AS session_date,
                computed_at, input_hash, config_hash, assessment_json
           FROM \`${this.assessmentTableName}\`
          WHERE run_id = ? AND instrument_id = ?
          LIMIT 1
          FOR UPDATE`,
        [candidate.runId, instrumentId],
      );
      const row = selectRows(result)[0];
      if (row) {
        const existing = assessmentFromRow(row);
        assertMatchingRecord(existing, candidate, assessmentsEquivalent, "Assessment");
        return cloneAssessmentRecord(existing);
      }

      await execute(
        `INSERT INTO \`${this.assessmentTableName}\` (
           run_id, instrument_id, session_date, computed_at,
           input_hash, config_hash, assessment_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.runId,
          instrumentId,
          candidate.assessment.sessionDate,
          candidate.computedAt,
          candidate.inputHash,
          candidate.configHash,
          JSON.stringify(candidate.assessment),
        ],
      );
      return cloneAssessmentRecord(candidate);
    });
  }

  async getAssessment({ runId, instrumentId }) {
    const normalizedRunId = normalizeDigest(runId, "runId");
    const id = normalizeInstrumentId(instrumentId);
    const result = await this.#execute(
      `SELECT run_id, instrument_id, CAST(session_date AS CHAR) AS session_date,
              computed_at, input_hash, config_hash, assessment_json
         FROM \`${this.assessmentTableName}\`
        WHERE run_id = ? AND instrument_id = ?
        LIMIT 1`,
      [normalizedRunId, id],
      "getAssessment",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    const record = assessmentFromRow(row);
    if (record.runId !== normalizedRunId || record.assessment.instrumentId !== id) {
      throw new TypeError("Assessment row does not match its indexed query");
    }
    return cloneAssessmentRecord(record);
  }

  async getLatestAssessment(instrumentId) {
    const id = normalizeInstrumentId(instrumentId);
    const result = await this.#execute(
      `SELECT run_id, instrument_id, CAST(session_date AS CHAR) AS session_date,
              computed_at, input_hash, config_hash, assessment_json
         FROM \`${this.assessmentTableName}\`
        WHERE instrument_id = ?
        ORDER BY session_date DESC, computed_at DESC, run_id DESC
        LIMIT 1`,
      [id],
      "getLatestAssessment",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    return cloneAssessmentRecord(assessmentFromRow(row));
  }

  async listAssessments(runId) {
    const normalizedRunId = normalizeDigest(runId, "runId");
    const result = await this.#execute(
      `SELECT run_id, instrument_id, CAST(session_date AS CHAR) AS session_date,
              computed_at, input_hash, config_hash, assessment_json
         FROM \`${this.assessmentTableName}\`
        WHERE run_id = ?
        ORDER BY instrument_id ASC`,
      [normalizedRunId],
      "listAssessments",
    );
    return selectRows(result).map((row) => {
      const record = assessmentFromRow(row);
      if (record.runId !== normalizedRunId) {
        throw new TypeError("Assessment row does not match its indexed query");
      }
      return cloneAssessmentRecord(record);
    });
  }

  async appendHistoryManifest(record) {
    const candidate = normalizeHistoryManifestRecord(record);
    return this.#runAppend("appendHistoryManifest", async (execute) => {
      const result = await execute(
        `SELECT series_hash, instrument_id, asset_class, history_range, history_interval,
                observed_at, provider, provider_symbol, fallback, original_source,
                price_basis, requested_price_basis, adjustment_json, continuity_json,
                session_json, quality, data_quality_json, source_as_of,
                CAST(first_session_date AS CHAR) AS first_session_date,
                CAST(last_session_date AS CHAR) AS last_session_date,
                bar_count, session_dates_json, bar_timestamps_json,
                bar_input_hashes_json, session_grid_hash, session_grid_json,
                fetch_cutoff_json
           FROM \`${this.manifestTableName}\`
          WHERE series_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [candidate.seriesHash],
      );
      const row = selectRows(result)[0];
      if (row) {
        const existing = manifestFromRow(row);
        assertMatchingRecord(
          existing,
          candidate,
          historyManifestsEquivalent,
          "History manifest",
        );
        return cloneHistoryManifestRecord(existing);
      }

      await execute(
        `INSERT INTO \`${this.manifestTableName}\` (
           series_hash, instrument_id, asset_class, history_range, history_interval,
           observed_at, provider, provider_symbol, fallback, original_source,
           price_basis, requested_price_basis, adjustment_json, continuity_json,
           session_json, quality, data_quality_json, source_as_of,
           first_session_date, last_session_date, bar_count, session_dates_json,
           bar_timestamps_json, bar_input_hashes_json, session_grid_hash,
           session_grid_json, fetch_cutoff_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        manifestInsertParameters(candidate),
      );
      return cloneHistoryManifestRecord(candidate);
    });
  }

  async getHistoryManifest(seriesHash) {
    const hash = normalizeDigest(seriesHash, "seriesHash");
    const result = await this.#execute(
      `SELECT series_hash, instrument_id, asset_class, history_range, history_interval,
              observed_at, provider, provider_symbol, fallback, original_source,
              price_basis, requested_price_basis, adjustment_json, continuity_json,
              session_json, quality, data_quality_json, source_as_of,
              CAST(first_session_date AS CHAR) AS first_session_date,
              CAST(last_session_date AS CHAR) AS last_session_date,
              bar_count, session_dates_json, bar_timestamps_json,
              bar_input_hashes_json, session_grid_hash, session_grid_json,
              fetch_cutoff_json
         FROM \`${this.manifestTableName}\`
        WHERE series_hash = ?
        LIMIT 1`,
      [hash],
      "getHistoryManifest",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    const record = manifestFromRow(row);
    if (record.seriesHash !== hash) {
      throw new TypeError("History manifest row does not match its indexed query");
    }
    return cloneHistoryManifestRecord(record);
  }

  async getHistoryInput(seriesHash) {
    const manifest = await this.getHistoryManifest(seriesHash);
    if (!manifest) return null;
    const sessionDates = [...new Set(manifest.sessionDates)];
    const placeholders = sessionDates.map(() => "?").join(", ");
    const result = await this.#execute(
      `SELECT instrument_id, CAST(session_date AS CHAR) AS session_date, revision,
              observed_at, provider, input_hash, provider_close,
              provider_adjusted_close, provider_volume
         FROM \`${this.observationTableName}\`
        WHERE instrument_id = ? AND session_date IN (${placeholders})
          AND observed_at <= ?
        ORDER BY observed_at DESC, revision DESC`,
      [
        manifest.instrumentId,
        ...sessionDates,
        manifest.fetchCutoff.throughObservedAt,
      ],
      "getHistoryInput",
    );
    const requestedDates = new Set(sessionDates);
    const byIdentity = new Map();
    for (const row of selectRows(result)) {
      const record = observationFromRow(row);
      if (record.instrumentId !== manifest.instrumentId
        || !requestedDates.has(record.sessionDate)
        || record.observedAt > manifest.fetchCutoff.throughObservedAt) {
        throw new TypeError("History input observation row does not match its query");
      }
      const key = JSON.stringify([record.sessionDate, record.inputHash]);
      if (!byIdentity.has(key)) byIdentity.set(key, record);
    }
    const observations = manifest.sessionDates.map((sessionDate, index) => {
      const key = JSON.stringify([sessionDate, manifest.barInputHashes[index]]);
      const record = byIdentity.get(key);
      if (!record) throw new TypeError(`History input observation ${index} is missing`);
      return record;
    });
    return normalizeHistoryInputRecord({ manifest, observations });
  }

  async appendRunAttempt(record) {
    const candidate = normalizeRunAttemptRecord(record);
    return this.#runAppend("appendRunAttempt", async (execute) => {
      const result = await execute(
        `SELECT attempt_id, run_id,
                CAST(expected_completed_session_date AS CHAR)
                  AS expected_completed_session_date,
                CAST(expected_next_session_date AS CHAR) AS expected_next_session_date,
                started_at, completed_at, config_hash, config_snapshot_json, status,
                requested_count, available_count, unavailable_count, failed_count,
                session_grid_hash, input_manifest_json, failure_summary_json
           FROM \`${this.runAttemptTableName}\`
          WHERE attempt_id = ?
          LIMIT 1
          FOR UPDATE`,
        [candidate.attemptId],
      );
      const row = selectRows(result)[0];
      if (row) {
        const existing = runAttemptFromRow(row);
        assertMatchingRecord(
          existing,
          candidate,
          runAttemptsEquivalent,
          "Run attempt",
        );
        return cloneRunAttemptRecord(existing);
      }

      await execute(
        `INSERT INTO \`${this.runAttemptTableName}\` (
           attempt_id, run_id, expected_completed_session_date,
           expected_next_session_date, started_at, completed_at, config_hash,
           config_snapshot_json, status, requested_count, available_count, unavailable_count,
           failed_count, session_grid_hash, input_manifest_json, failure_summary_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.attemptId,
          candidate.runId,
          candidate.expectedCompletedSessionDate,
          candidate.expectedNextSessionDate,
          candidate.startedAt,
          candidate.completedAt,
          candidate.configHash,
          JSON.stringify(candidate.configSnapshot),
          candidate.status,
          candidate.counts.requested,
          candidate.counts.available,
          candidate.counts.unavailable,
          candidate.counts.failed,
          candidate.inputManifest.sessionGridHash,
          JSON.stringify(candidate.inputManifest),
          JSON.stringify(candidate.failureSummary),
        ],
      );
      return cloneRunAttemptRecord(candidate);
    });
  }

  async getRunAttempt(attemptId) {
    const id = normalizeDigest(attemptId, "attemptId");
    const result = await this.#execute(
      `SELECT attempt_id, run_id,
              CAST(expected_completed_session_date AS CHAR)
                AS expected_completed_session_date,
              CAST(expected_next_session_date AS CHAR) AS expected_next_session_date,
              started_at, completed_at, config_hash, config_snapshot_json, status,
              requested_count, available_count, unavailable_count, failed_count,
              session_grid_hash, input_manifest_json, failure_summary_json
         FROM \`${this.runAttemptTableName}\`
        WHERE attempt_id = ?
        LIMIT 1`,
      [id],
      "getRunAttempt",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    const record = runAttemptFromRow(row);
    if (record.attemptId !== id) {
      throw new TypeError("Run attempt row does not match its indexed query");
    }
    return cloneRunAttemptRecord(record);
  }

  async listRunAttempts(runId) {
    const id = normalizeDigest(runId, "runId");
    const result = await this.#execute(
      `SELECT attempt_id, run_id,
              CAST(expected_completed_session_date AS CHAR)
                AS expected_completed_session_date,
              CAST(expected_next_session_date AS CHAR) AS expected_next_session_date,
              started_at, completed_at, config_hash, config_snapshot_json, status,
              requested_count, available_count, unavailable_count, failed_count,
              session_grid_hash, input_manifest_json, failure_summary_json
         FROM \`${this.runAttemptTableName}\`
        WHERE run_id = ?
        ORDER BY started_at ASC, attempt_id ASC`,
      [id],
      "listRunAttempts",
    );
    return selectRows(result).map((row) => {
      const record = runAttemptFromRow(row);
      if (record.runId !== id) {
        throw new TypeError("Run attempt row does not match its indexed query");
      }
      return cloneRunAttemptRecord(record);
    });
  }

  close() {
    if (!this.closePromise) {
      this.closePromise = this.ownsPool
        ? closeOwnedPool(this.pool)
        : Promise.resolve();
    }
    return this.closePromise;
  }

  async #runAppend(operation, callback) {
    const maximumAttempts = 2;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#runAppendOnce(operation, callback);
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt === maximumAttempts) throw error;
      }
    }
    throw new Error("Unreachable append retry state");
  }

  async #runAppendOnce(operation, callback) {
    let connection;
    let releaseConnection = false;
    try {
      if (typeof this.pool.getConnection === "function") {
        connection = await this.pool.getConnection();
        releaseConnection = true;
      } else {
        connection = this.pool;
      }
      const query = connection?.execute || connection?.query;
      if (typeof query !== "function") {
        throw new TypeError("pool connection must expose execute(sql, params) or query(sql, params)");
      }
      if (typeof connection.beginTransaction !== "function"
        || typeof connection.commit !== "function"
        || typeof connection.rollback !== "function") {
        throw new TypeError("pool connection must expose transaction methods");
      }
      await connection.beginTransaction();
      const execute = (sql, params) => this.#executeWith(
        query.bind(connection),
        sql,
        params,
        operation,
      );
      const result = await callback(execute);
      await connection.commit();
      return result;
    } catch (error) {
      if (connection && typeof connection.rollback === "function") {
        try {
          await connection.rollback();
        } catch {
        }
      }
      if (error instanceof MarketDataError || error instanceof TypeError || error instanceof RangeError) {
        throw error;
      }
      throw this.#persistenceError(error, operation);
    } finally {
      if (releaseConnection) connection?.release?.();
    }
  }

  async #execute(sql, params, operation) {
    return this.#executeWith(this.executeQuery, sql, params, operation);
  }

  async #executeWith(execute, sql, params, operation) {
    try {
      return await execute(sql, params);
    } catch (cause) {
      throw this.#persistenceError(cause, operation);
    }
  }

  #persistenceError(cause, operation) {
    return new MarketDataError(
      ERROR_CODES.PERSISTENCE_UNAVAILABLE,
      "Analytics persistence operation failed",
      { cause, details: { operation } },
    );
  }
}
