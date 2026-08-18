import { isDeepStrictEqual } from "node:util";

import { clonePlain } from "../../../shared/clonePlain.js";
import { CANONICAL_INSTRUMENT_ID_PATTERN } from "../../contracts/core/constants.js";
import {
  ADJUSTMENT_STATUSES,
  MARKET_ASSET_CLASSES,
  CONTINUITY_KINDS,
  PRICE_BASES,
  SESSION_MODELS,
  SURFACE_QUALITIES,
} from "../../contracts/market/constants.js";
import { validateDataQuality } from "../../contracts/market/dataQuality.js";
import {
  validateMovementAssessment,
  validateVolatilityForecast,
} from "../contracts/validators.js";
import { sessionDateFromTimestamp } from "../data/sessionDate.js";
import { analyticsSha256 } from "../canonicalDigest.js";
import {
  dailyObservationInputHash,
  historySeriesHash,
  historySeriesProjectionFromInput,
} from "../historyDigests.js";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;
const DATABASE_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?$/u;
const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FORECAST_ORIGINS = Object.freeze(["live", "backfill"]);
const RUN_ATTEMPT_STATUSES = Object.freeze([
  "completed",
  "completed_with_failures",
  "benchmark_unavailable",
  "batch_failed",
  "failed",
]);
const ADJUSTMENT_STATUS_BY_BASIS = Object.freeze({
  raw: Object.freeze(["none", "unknown"]),
  provider_adjusted: Object.freeze(["provider_defined"]),
  split_adjusted: Object.freeze(["split_adjusted"]),
});

export const HISTORY_CUTOFF_PREDICATE = "observed_at_lte";
export const HISTORY_REVISION_SELECTION =
  "explicit_manifest_bar_input_hashes";
export const HISTORY_SESSION_MEMBERSHIP = "ordered_manifest_bars";

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label}.${key} is not supported`);
  }
}

function requireFiniteOrNull(value, label) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`${label} must be a finite number or null`);
  }
  return value;
}

function requireInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function assertJsonValue(value, path, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain NaN or Infinity`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain circular references`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} must not contain sparse arrays`);
      assertJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function normalizeDatabaseTimestamp(value) {
  if (typeof value === "string" && DATABASE_TIMESTAMP_PATTERN.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

export function toAnalyticsIsoTimestamp(value, label) {
  const normalized = normalizeDatabaseTimestamp(value);
  if (!(normalized instanceof Date)
    && (typeof normalized !== "string" || !ISO_TIMESTAMP_PATTERN.test(normalized))) {
    throw new TypeError(`${label} must be a complete ISO-8601 timestamp`);
  }
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  if (typeof normalized === "string") {
    normalizeSessionDate(normalized.slice(0, 10), label);
    const offset = normalized.match(/([+-])(\d{2}):(\d{2})$/u);
    if (offset && Number(offset[2]) === 14 && offset[3] !== "00") {
      throw new TypeError(`${label} must use a valid UTC offset`);
    }
  }
  return date.toISOString();
}

export function normalizeSessionDate(value, label = "sessionDate") {
  if (value instanceof Date && !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid YYYY-MM-DD session date`);
  }
  const candidate = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof candidate !== "string" || !SESSION_DATE_PATTERN.test(candidate)) {
    throw new TypeError(`${label} must be a valid YYYY-MM-DD session date`);
  }
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    throw new TypeError(`${label} must be a valid YYYY-MM-DD session date`);
  }
  return candidate;
}

export function normalizeInstrumentId(value, label = "instrumentId") {
  if (typeof value !== "string"
    || value.length > 191
    || !CANONICAL_INSTRUMENT_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical instrument ID`);
  }
  return value;
}

export function normalizeNonEmptyString(value, label, { maximumLength = Infinity } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new TypeError(`${label} must not exceed ${maximumLength} characters`);
  }
  return normalized;
}

export function normalizeDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical sha256 digest`);
  }
  return value;
}

export function normalizeForecastOrigin(value) {
  if (!FORECAST_ORIGINS.includes(value)) {
    throw new TypeError("origin must be live or backfill");
  }
  return value;
}

export function normalizeDailyObservationInput(record) {
  requirePlainObject(record, "Daily observation");
  assertAllowedKeys(record, [
    "instrumentId",
    "sessionDate",
    "revision",
    "observedAt",
    "provider",
    "inputHash",
    "bar",
  ], "Daily observation");
  requirePlainObject(record.bar, "Daily observation.bar");
  assertAllowedKeys(record.bar, [
    "providerClose",
    "providerAdjustedClose",
    "providerVolume",
  ], "Daily observation.bar");

  if (typeof record.bar.providerClose !== "number"
    || !Number.isFinite(record.bar.providerClose)) {
    throw new TypeError("Daily observation.bar.providerClose must be a finite number");
  }
  const providerAdjustedClose = requireFiniteOrNull(
    record.bar.providerAdjustedClose,
    "Daily observation.bar.providerAdjustedClose",
  );
  const providerVolume = requireFiniteOrNull(
    record.bar.providerVolume,
    "Daily observation.bar.providerVolume",
  );
  if (providerVolume !== null && providerVolume < 0) {
    throw new RangeError("Daily observation.bar.providerVolume must be non-negative");
  }

  return {
    instrumentId: normalizeInstrumentId(record.instrumentId),
    sessionDate: normalizeSessionDate(record.sessionDate),
    observedAt: toAnalyticsIsoTimestamp(record.observedAt, "observedAt"),
    provider: normalizeNonEmptyString(record.provider, "provider", { maximumLength: 64 }),
    inputHash: normalizeDigest(record.inputHash, "inputHash"),
    bar: {
      providerClose: record.bar.providerClose,
      providerAdjustedClose,
      providerVolume,
    },
  };
}

export function createDailyObservationRecord(record, revision) {
  const normalized = normalizeDailyObservationInput(record);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TypeError("revision must be a positive integer");
  }
  return {
    instrumentId: normalized.instrumentId,
    sessionDate: normalized.sessionDate,
    revision,
    observedAt: normalized.observedAt,
    provider: normalized.provider,
    inputHash: normalized.inputHash,
    bar: normalized.bar,
  };
}

export function normalizeDailyObservationRecord(record) {
  return createDailyObservationRecord(record, record?.revision);
}

export function normalizeForecastRecord(record) {
  requirePlainObject(record, "Forecast record");
  assertAllowedKeys(record, [
    "runId",
    "targetSessionDate",
    "informationSetEnd",
    "recordedAt",
    "origin",
    "inputHash",
    "configHash",
    "forecast",
  ], "Forecast record");

  const targetSessionDate = normalizeSessionDate(
    record.targetSessionDate,
    "targetSessionDate",
  );
  const informationSetEnd = normalizeSessionDate(
    record.informationSetEnd,
    "informationSetEnd",
  );
  if (informationSetEnd >= targetSessionDate) {
    throw new RangeError("informationSetEnd must precede targetSessionDate");
  }
  assertJsonValue(record.forecast, "forecast");
  const forecast = clonePlain(record.forecast);
  requirePlainObject(forecast, "forecast");
  assertAllowedKeys(forecast, [
    "instrumentId",
    "originSessionDate",
    "horizonSessions",
    "informationSetEnd",
    "variance",
    "dailyVolatility",
    "model",
  ], "forecast");
  validateVolatilityForecast(forecast);
  if (forecast.informationSetEnd !== informationSetEnd) {
    throw new TypeError("Forecast informationSetEnd must match its wrapper");
  }

  const recordedAt = toAnalyticsIsoTimestamp(record.recordedAt, "recordedAt");
  const origin = normalizeForecastOrigin(record.origin);
  const recordedDate = recordedAt.slice(0, 10);
  if ((origin === "live" && recordedDate >= targetSessionDate)
    || (origin === "backfill" && recordedDate < targetSessionDate)) {
    throw new RangeError(
      "Forecast origin is inconsistent with recordedAt and targetSessionDate",
    );
  }

  return {
    runId: normalizeDigest(record.runId, "runId"),
    targetSessionDate,
    informationSetEnd,
    recordedAt,
    origin,
    inputHash: normalizeDigest(record.inputHash, "inputHash"),
    configHash: normalizeDigest(record.configHash, "configHash"),
    forecast,
  };
}

export function normalizeAssessmentRecord(record) {
  requirePlainObject(record, "Assessment record");
  assertAllowedKeys(record, [
    "runId",
    "computedAt",
    "inputHash",
    "configHash",
    "assessment",
  ], "Assessment record");

  assertJsonValue(record.assessment, "assessment");
  const assessment = clonePlain(record.assessment);
  validateMovementAssessment(assessment);

  return {
    runId: normalizeDigest(record.runId, "runId"),
    computedAt: toAnalyticsIsoTimestamp(record.computedAt, "computedAt"),
    inputHash: normalizeDigest(record.inputHash, "inputHash"),
    configHash: normalizeDigest(record.configHash, "configHash"),
    assessment,
  };
}

function normalizeAdjustment(value) {
  requirePlainObject(value, "History manifest.adjustment");
  assertAllowedKeys(value, [
    "status",
    "includesSplits",
    "includesDistributions",
    "formulaVersion",
  ], "History manifest.adjustment");
  if (!ADJUSTMENT_STATUSES.includes(value.status)) {
    throw new TypeError("History manifest.adjustment.status is unsupported");
  }
  for (const key of ["includesSplits", "includesDistributions"]) {
    if (typeof value[key] !== "boolean" && value[key] !== "unknown") {
      throw new TypeError(`History manifest.adjustment.${key} must be boolean or unknown`);
    }
  }
  const formulaVersion = value.formulaVersion === null
    ? null
    : normalizeNonEmptyString(
      value.formulaVersion,
      "History manifest.adjustment.formulaVersion",
      { maximumLength: 191 },
    );
  return {
    status: value.status,
    includesSplits: value.includesSplits,
    includesDistributions: value.includesDistributions,
    formulaVersion,
  };
}

function normalizeManifestSession(value) {
  requirePlainObject(value, "History manifest.session");
  assertAllowedKeys(value, ["model", "timezone"], "History manifest.session");
  if (!SESSION_MODELS.includes(value.model)) {
    throw new TypeError("History manifest.session.model is unsupported");
  }
  const timezone = normalizeNonEmptyString(
    value.timezone,
    "History manifest.session.timezone",
    { maximumLength: 191 },
  );
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("History manifest.session.timezone must be a valid IANA timezone");
  }
  return { model: value.model, timezone };
}

function normalizeContinuity(value) {
  requirePlainObject(value, "History manifest.continuity");
  if (!CONTINUITY_KINDS.includes(value.kind)) {
    throw new TypeError("History manifest.continuity.kind is unsupported");
  }
  if (value.kind === "single_instrument") {
    assertAllowedKeys(value, ["kind", "rollover"], "History manifest.continuity");
    if (value.rollover !== null) {
      throw new TypeError("Single-instrument continuity rollover must be null");
    }
    return { kind: value.kind, rollover: null };
  }

  assertAllowedKeys(value, [
    "kind",
    "activeContract",
    "expirationDate",
    "rollover",
    "backAdjustment",
    "comparableAcrossRollover",
  ], "History manifest.continuity");
  const expirationDate = value.expirationDate === null
    ? null
    : toAnalyticsIsoTimestamp(
      value.expirationDate,
      "History manifest.continuity.expirationDate",
    );
  if (value.rollover !== "provider_managed"
    || !["none", "unknown"].includes(value.backAdjustment)
    || value.comparableAcrossRollover !== false) {
    throw new TypeError("History manifest continuity semantics are invalid");
  }
  return {
    kind: value.kind,
    activeContract: normalizeNonEmptyString(
      value.activeContract,
      "History manifest.continuity.activeContract",
      { maximumLength: 191 },
    ),
    expirationDate,
    rollover: value.rollover,
    backAdjustment: value.backAdjustment,
    comparableAcrossRollover: false,
  };
}

function normalizeManifestDataQuality(value, barCount) {
  requirePlainObject(value, "History manifest.dataQuality");
  assertAllowedKeys(value, [
    "status",
    "issues",
    "rowCount",
    "droppedRows",
    "missingAdjustedCloseRows",
  ], "History manifest.dataQuality");
  assertJsonValue(value, "History manifest.dataQuality");
  const dataQuality = clonePlain(value);
  validateDataQuality(dataQuality);
  if (dataQuality.rowCount !== barCount) {
    throw new TypeError("History manifest.dataQuality.rowCount must equal barCount");
  }
  return dataQuality;
}

function normalizeSessionDates(value, barCount, firstSessionDate, lastSessionDate) {
  if (!Array.isArray(value)) {
    throw new TypeError("History manifest.sessionDates must be an array");
  }
  if (value.length !== barCount) {
    throw new TypeError("History manifest.sessionDates length must equal barCount");
  }
  const sessionDates = value.map((entry, index) => (
    normalizeSessionDate(entry, `History manifest.sessionDates[${index}]`)
  ));
  for (let index = 1; index < sessionDates.length; index += 1) {
    if (sessionDates[index - 1] > sessionDates[index]) {
      throw new TypeError("History manifest.sessionDates must be non-decreasing");
    }
  }
  if (sessionDates[0] !== firstSessionDate
    || sessionDates.at(-1) !== lastSessionDate) {
    throw new TypeError("History manifest first/last session must match sessionDates");
  }
  return sessionDates;
}

function normalizeBarInputHashes(value, barCount) {
  if (!Array.isArray(value) || value.length !== barCount) {
    throw new TypeError("History manifest.barInputHashes length must equal barCount");
  }
  return value.map((entry, index) => normalizeDigest(
    entry,
    `History manifest.barInputHashes[${index}]`,
  ));
}

function normalizeOrderedSessionDates(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const dates = value.map((entry, index) => (
    normalizeSessionDate(entry, `${label}[${index}]`)
  ));
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index - 1] >= dates[index]) {
      throw new TypeError(`${label} must be unique and strictly ascending`);
    }
  }
  return dates;
}

function normalizeBarTimestamps(value, sessionDates, timezone) {
  if (!Array.isArray(value) || value.length !== sessionDates.length) {
    throw new TypeError("History manifest.barTimestamps length must equal barCount");
  }
  const timestamps = value.map((entry, index) => (
    toAnalyticsIsoTimestamp(entry, `History manifest.barTimestamps[${index}]`)
  ));
  for (let index = 0; index < timestamps.length; index += 1) {
    if (index > 0 && timestamps[index - 1] >= timestamps[index]) {
      throw new TypeError("History manifest.barTimestamps must be strictly ascending");
    }
    if (sessionDateFromTimestamp(timestamps[index], timezone) !== sessionDates[index]) {
      throw new TypeError(
        "History manifest.barTimestamps must map to the declared sessionDates",
      );
    }
  }
  return timestamps;
}

function normalizeSessionGrid(value) {
  requirePlainObject(value, "History manifest.sessionGrid");
  assertAllowedKeys(value, [
    "gridHash",
    "calendarId",
    "source",
    "revision",
    "timeZone",
    "sessionDates",
  ], "History manifest.sessionGrid");
  const timeZone = normalizeNonEmptyString(
    value.timeZone,
    "History manifest.sessionGrid.timeZone",
    { maximumLength: 191 },
  );
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new TypeError("History manifest.sessionGrid.timeZone must be a valid IANA timezone");
  }
  const sessionDates = normalizeOrderedSessionDates(
    value.sessionDates,
    "History manifest.sessionGrid.sessionDates",
  );
  const grid = {
    calendarId: normalizeNonEmptyString(
      value.calendarId,
      "History manifest.sessionGrid.calendarId",
      { maximumLength: 191 },
    ),
    source: normalizeNonEmptyString(
      value.source,
      "History manifest.sessionGrid.source",
      { maximumLength: 191 },
    ),
    revision: normalizeNonEmptyString(
      value.revision,
      "History manifest.sessionGrid.revision",
      { maximumLength: 191 },
    ),
    timeZone,
    sessionDates,
  };
  const gridHash = normalizeDigest(
    value.gridHash,
    "History manifest.sessionGrid.gridHash",
  );
  if (analyticsSha256(grid) !== gridHash) {
    throw new TypeError("History manifest.sessionGrid.gridHash does not match its content");
  }
  return { gridHash, ...grid };
}

function normalizeFetchCutoff(value, observedAt) {
  requirePlainObject(value, "History manifest.fetchCutoff");
  assertAllowedKeys(value, [
    "throughObservedAt",
    "predicate",
    "revisionSelection",
    "sessionMembership",
  ], "History manifest.fetchCutoff");
  const throughObservedAt = toAnalyticsIsoTimestamp(
    value.throughObservedAt,
    "History manifest.fetchCutoff.throughObservedAt",
  );
  if (throughObservedAt !== observedAt) {
    throw new TypeError(
      "History manifest.fetchCutoff.throughObservedAt must equal observedAt",
    );
  }
  if (value.predicate !== HISTORY_CUTOFF_PREDICATE
    || value.revisionSelection !== HISTORY_REVISION_SELECTION
    || value.sessionMembership !== HISTORY_SESSION_MEMBERSHIP) {
    throw new TypeError("History manifest.fetchCutoff semantics are unsupported");
  }
  return {
    throughObservedAt,
    predicate: HISTORY_CUTOFF_PREDICATE,
    revisionSelection: HISTORY_REVISION_SELECTION,
    sessionMembership: HISTORY_SESSION_MEMBERSHIP,
  };
}

export function normalizeHistoryManifestRecord(record) {
  requirePlainObject(record, "History manifest");
  assertAllowedKeys(record, [
    "seriesHash",
    "instrumentId",
    "assetClass",
    "range",
    "interval",
    "observedAt",
    "provider",
    "providerSymbol",
    "fallback",
    "originalSource",
    "priceBasis",
    "requestedPriceBasis",
    "adjustment",
    "continuity",
    "session",
    "quality",
    "dataQuality",
    "sourceAsOf",
    "firstSessionDate",
    "lastSessionDate",
    "barCount",
    "sessionDates",
    "barTimestamps",
    "barInputHashes",
    "sessionGrid",
    "fetchCutoff",
  ], "History manifest");

  const observedAt = toAnalyticsIsoTimestamp(record.observedAt, "observedAt");
  if (!PRICE_BASES.includes(record.priceBasis)
    || !PRICE_BASES.includes(record.requestedPriceBasis)) {
    throw new TypeError("History manifest price bases are unsupported");
  }
  if (record.priceBasis !== record.requestedPriceBasis) {
    throw new TypeError("History manifest priceBasis must satisfy requestedPriceBasis");
  }
  const adjustment = normalizeAdjustment(record.adjustment);
  if (!ADJUSTMENT_STATUS_BY_BASIS[record.priceBasis].includes(adjustment.status)) {
    throw new TypeError("History manifest adjustment status does not match priceBasis");
  }
  if (!SURFACE_QUALITIES.includes(record.quality)) {
    throw new TypeError("History manifest.quality is unsupported");
  }
  const barCount = requireInteger(record.barCount, "History manifest.barCount", { minimum: 1 });
  const firstSessionDate = normalizeSessionDate(
    record.firstSessionDate,
    "History manifest.firstSessionDate",
  );
  const lastSessionDate = normalizeSessionDate(
    record.lastSessionDate,
    "History manifest.lastSessionDate",
  );
  if (firstSessionDate > lastSessionDate) {
    throw new RangeError("History manifest firstSessionDate must not follow lastSessionDate");
  }
  if (!MARKET_ASSET_CLASSES.includes(record.assetClass)) {
    throw new TypeError("History manifest.assetClass is unsupported");
  }
  if (typeof record.fallback !== "boolean") {
    throw new TypeError("History manifest.fallback must be boolean");
  }
  const originalSource = record.originalSource === null
    ? null
    : normalizeNonEmptyString(
      record.originalSource,
      "History manifest.originalSource",
      { maximumLength: 64 },
    );
  const session = normalizeManifestSession(record.session);
  const sessionDates = normalizeSessionDates(
    record.sessionDates,
    barCount,
    firstSessionDate,
    lastSessionDate,
  );

  return {
    seriesHash: normalizeDigest(record.seriesHash, "seriesHash"),
    instrumentId: normalizeInstrumentId(record.instrumentId),
    assetClass: record.assetClass,
    range: normalizeNonEmptyString(record.range, "range", { maximumLength: 32 }),
    interval: normalizeNonEmptyString(record.interval, "interval", { maximumLength: 32 }),
    observedAt,
    provider: normalizeNonEmptyString(record.provider, "provider", { maximumLength: 64 }),
    providerSymbol: normalizeNonEmptyString(
      record.providerSymbol,
      "providerSymbol",
      { maximumLength: 191 },
    ),
    fallback: record.fallback,
    originalSource,
    priceBasis: record.priceBasis,
    requestedPriceBasis: record.requestedPriceBasis,
    adjustment,
    continuity: normalizeContinuity(record.continuity),
    session,
    quality: record.quality,
    dataQuality: normalizeManifestDataQuality(record.dataQuality, barCount),
    sourceAsOf: toAnalyticsIsoTimestamp(record.sourceAsOf, "sourceAsOf"),
    firstSessionDate,
    lastSessionDate,
    barCount,
    sessionDates,
    barTimestamps: normalizeBarTimestamps(
      record.barTimestamps,
      sessionDates,
      session.timezone,
    ),
    barInputHashes: normalizeBarInputHashes(record.barInputHashes, barCount),
    sessionGrid: normalizeSessionGrid(record.sessionGrid),
    fetchCutoff: normalizeFetchCutoff(record.fetchCutoff, observedAt),
  };
}

export function normalizeHistoryInputRecord(value) {
  requirePlainObject(value, "History input");
  assertAllowedKeys(value, ["observations", "manifest"], "History input");
  if (!Array.isArray(value.observations)) {
    throw new TypeError("History input.observations must be an array");
  }
  const manifest = normalizeHistoryManifestRecord(value.manifest);
  const observations = value.observations.map((entry, index) => {
    const observation = Object.hasOwn(entry, "revision")
      ? normalizeDailyObservationRecord(entry)
      : normalizeDailyObservationInput(entry);
    if (observation.instrumentId !== manifest.instrumentId
      || observation.sessionDate !== manifest.sessionDates[index]
      || observation.inputHash !== manifest.barInputHashes[index]
      || observation.observedAt > manifest.fetchCutoff.throughObservedAt
      || observation.provider !== manifest.provider) {
      throw new TypeError(
        `History input.observations[${index}] does not match the manifest`,
      );
    }
    return observation;
  });
  if (observations.length !== manifest.barCount) {
    throw new TypeError("History input observations length must equal manifest.barCount");
  }
  for (let index = 0; index < observations.length; index += 1) {
    const computedHash = dailyObservationInputHash({
      manifest,
      observation: observations[index],
      barTimestamp: manifest.barTimestamps[index],
    });
    if (computedHash !== observations[index].inputHash) {
      throw new TypeError(
        `History input.observations[${index}].inputHash does not match its content`,
      );
    }
  }
  const normalizedSeries = historySeriesProjectionFromInput({
    manifest,
    observations,
  });
  if (historySeriesHash(normalizedSeries, manifest.sessionGrid.gridHash)
    !== manifest.seriesHash) {
    throw new TypeError("History manifest.seriesHash does not match its content and grid");
  }
  return { observations, manifest };
}

function normalizeHistorySelection(value) {
  requirePlainObject(value, "Run attempt.inputManifest.historySelection");
  assertAllowedKeys(value, [
    "range",
    "interval",
    "priceBasis",
    "predicate",
    "revisionSelection",
    "sessionMembership",
  ], "Run attempt.inputManifest.historySelection");
  if (!PRICE_BASES.includes(value.priceBasis)
    || value.predicate !== HISTORY_CUTOFF_PREDICATE
    || value.revisionSelection !== HISTORY_REVISION_SELECTION
    || value.sessionMembership !== HISTORY_SESSION_MEMBERSHIP) {
    throw new TypeError("Run attempt history selection semantics are unsupported");
  }
  return {
    range: normalizeNonEmptyString(value.range, "historySelection.range", {
      maximumLength: 32,
    }),
    interval: normalizeNonEmptyString(value.interval, "historySelection.interval", {
      maximumLength: 32,
    }),
    priceBasis: value.priceBasis,
    predicate: HISTORY_CUTOFF_PREDICATE,
    revisionSelection: HISTORY_REVISION_SELECTION,
    sessionMembership: HISTORY_SESSION_MEMBERSHIP,
  };
}

function normalizeRunInputManifest(value) {
  requirePlainObject(value, "Run attempt.inputManifest");
  assertAllowedKeys(
    value,
    [
      "sessionGridHash",
      "sessionSentinel",
      "missingReturnPolicy",
      "historySelection",
      "assets",
    ],
    "Run attempt.inputManifest",
  );
  let sessionSentinel = null;
  if (value.sessionSentinel !== null) {
    requirePlainObject(
      value.sessionSentinel,
      "Run attempt.inputManifest.sessionSentinel",
    );
    assertAllowedKeys(
      value.sessionSentinel,
      ["instrumentId", "seriesHash"],
      "Run attempt.inputManifest.sessionSentinel",
    );
    sessionSentinel = {
      instrumentId: normalizeInstrumentId(value.sessionSentinel.instrumentId),
      seriesHash: normalizeDigest(
        value.sessionSentinel.seriesHash,
        "Run attempt.inputManifest.sessionSentinel.seriesHash",
      ),
    };
  }
  if (!Array.isArray(value.assets)) {
    throw new TypeError("Run attempt.inputManifest.assets must be an array");
  }
  const assets = value.assets.map((entry, index) => {
    requirePlainObject(entry, `Run attempt.inputManifest.assets[${index}]`);
    assertAllowedKeys(
      entry,
      ["instrumentId", "assetSeriesHash", "assessmentInputHash"],
      `Run attempt.inputManifest.assets[${index}]`,
    );
    return {
      instrumentId: normalizeInstrumentId(entry.instrumentId),
      assetSeriesHash: normalizeDigest(
        entry.assetSeriesHash,
        `Run attempt.inputManifest.assets[${index}].assetSeriesHash`,
      ),
      assessmentInputHash: normalizeDigest(
        entry.assessmentInputHash,
        `Run attempt.inputManifest.assets[${index}].assessmentInputHash`,
      ),
    };
  });
  for (let index = 1; index < assets.length; index += 1) {
    if (assets[index - 1].instrumentId >= assets[index].instrumentId) {
      throw new TypeError(
        "Run attempt.inputManifest.assets must be unique and sorted by instrumentId",
      );
    }
  }
  if (sessionSentinel === null && assets.length > 0) {
    throw new TypeError("Run attempt assets require a session sentinel input");
  }
  return {
    sessionGridHash: normalizeDigest(
      value.sessionGridHash,
      "Run attempt.inputManifest.sessionGridHash",
    ),
    sessionSentinel,
    missingReturnPolicy: normalizeNonEmptyString(
      value.missingReturnPolicy,
      "Run attempt.inputManifest.missingReturnPolicy",
      { maximumLength: 191 },
    ),
    historySelection: normalizeHistorySelection(value.historySelection),
    assets,
  };
}

function normalizeAttemptCounts(value) {
  requirePlainObject(value, "Run attempt.counts");
  assertAllowedKeys(
    value,
    ["requested", "available", "unavailable", "failed"],
    "Run attempt.counts",
  );
  const counts = {};
  for (const key of ["requested", "available", "unavailable", "failed"]) {
    counts[key] = requireInteger(value[key], `Run attempt.counts.${key}`);
  }
  if (counts.available + counts.unavailable + counts.failed !== counts.requested) {
    throw new TypeError("Run attempt counts must add up to requested");
  }
  return counts;
}

export function normalizeRunAttemptRecord(record) {
  requirePlainObject(record, "Run attempt");
  assertAllowedKeys(record, [
    "attemptId",
    "runId",
    "expectedCompletedSessionDate",
    "expectedNextSessionDate",
    "startedAt",
    "completedAt",
    "configHash",
    "configSnapshot",
    "status",
    "counts",
    "inputManifest",
    "failureSummary",
  ], "Run attempt");

  const expectedCompletedSessionDate = normalizeSessionDate(
    record.expectedCompletedSessionDate,
    "expectedCompletedSessionDate",
  );
  const expectedNextSessionDate = normalizeSessionDate(
    record.expectedNextSessionDate,
    "expectedNextSessionDate",
  );
  if (expectedNextSessionDate <= expectedCompletedSessionDate) {
    throw new RangeError(
      "expectedNextSessionDate must follow expectedCompletedSessionDate",
    );
  }
  const startedAt = toAnalyticsIsoTimestamp(record.startedAt, "startedAt");
  const completedAt = toAnalyticsIsoTimestamp(record.completedAt, "completedAt");
  if (completedAt < startedAt) {
    throw new RangeError("completedAt must not precede startedAt");
  }
  if (!RUN_ATTEMPT_STATUSES.includes(record.status)) {
    throw new TypeError("Run attempt.status is unsupported");
  }
  const counts = normalizeAttemptCounts(record.counts);
  if (record.status === "completed" && counts.failed !== 0) {
    throw new TypeError("A completed run attempt cannot contain failed results");
  }
  if (record.status === "completed_with_failures" && counts.failed === 0) {
    throw new TypeError("A completed_with_failures attempt must contain a failure");
  }
  requirePlainObject(record.failureSummary, "Run attempt.failureSummary");
  assertJsonValue(record.failureSummary, "Run attempt.failureSummary");
  requirePlainObject(record.configSnapshot, "Run attempt.configSnapshot");
  assertJsonValue(record.configSnapshot, "Run attempt.configSnapshot");
  const configSnapshot = clonePlain(record.configSnapshot);
  const configHash = normalizeDigest(record.configHash, "configHash");
  if (analyticsSha256(configSnapshot) !== configHash) {
    throw new TypeError("Run attempt.configHash must match configSnapshot");
  }

  return {
    attemptId: normalizeDigest(record.attemptId, "attemptId"),
    runId: normalizeDigest(record.runId, "runId"),
    expectedCompletedSessionDate,
    expectedNextSessionDate,
    startedAt,
    completedAt,
    configHash,
    configSnapshot,
    status: record.status,
    counts,
    inputManifest: normalizeRunInputManifest(record.inputManifest),
    failureSummary: clonePlain(record.failureSummary),
  };
}

export function dailyObservationsEquivalent(left, right) {
  return left.instrumentId === right.instrumentId
    && left.sessionDate === right.sessionDate
    && left.inputHash === right.inputHash
    && left.provider === right.provider
    && isDeepStrictEqual(left.bar, right.bar);
}

export function forecastsEquivalent(left, right) {
  return left.runId === right.runId
    && left.targetSessionDate === right.targetSessionDate
    && left.informationSetEnd === right.informationSetEnd
    && left.origin === right.origin
    && left.inputHash === right.inputHash
    && left.configHash === right.configHash
    && isDeepStrictEqual(left.forecast, right.forecast);
}

export function assessmentsEquivalent(left, right) {
  return left.runId === right.runId
    && left.inputHash === right.inputHash
    && left.configHash === right.configHash
    && isDeepStrictEqual(left.assessment, right.assessment);
}

export function historyManifestsEquivalent(left, right) {
  return left.seriesHash === right.seriesHash
    && left.instrumentId === right.instrumentId
    && left.provider === right.provider
    && left.providerSymbol === right.providerSymbol
    && left.assetClass === right.assetClass
    && left.range === right.range
    && left.interval === right.interval
    && left.fallback === right.fallback
    && left.originalSource === right.originalSource
    && left.priceBasis === right.priceBasis
    && left.requestedPriceBasis === right.requestedPriceBasis
    && left.quality === right.quality
    && left.firstSessionDate === right.firstSessionDate
    && left.lastSessionDate === right.lastSessionDate
    && left.barCount === right.barCount
    && left.sourceAsOf === right.sourceAsOf
    && isDeepStrictEqual(left.adjustment, right.adjustment)
    && isDeepStrictEqual(left.continuity, right.continuity)
    && isDeepStrictEqual(left.session, right.session)
    && isDeepStrictEqual(left.dataQuality, right.dataQuality)
    && isDeepStrictEqual(left.sessionDates, right.sessionDates)
    && isDeepStrictEqual(left.barTimestamps, right.barTimestamps)
    && isDeepStrictEqual(left.barInputHashes, right.barInputHashes)
    && isDeepStrictEqual(left.sessionGrid, right.sessionGrid)
    && left.fetchCutoff.predicate === right.fetchCutoff.predicate
    && left.fetchCutoff.revisionSelection === right.fetchCutoff.revisionSelection
    && left.fetchCutoff.sessionMembership === right.fetchCutoff.sessionMembership;
}

export function runAttemptsEquivalent(left, right) {
  return isDeepStrictEqual(left, right);
}

export function cloneDailyObservationRecord(record) {
  return clonePlain(normalizeDailyObservationRecord(record));
}

export function cloneForecastRecord(record) {
  return clonePlain(normalizeForecastRecord(record));
}

export function cloneAssessmentRecord(record) {
  return clonePlain(normalizeAssessmentRecord(record));
}

export function cloneHistoryManifestRecord(record) {
  return clonePlain(normalizeHistoryManifestRecord(record));
}

export function cloneRunAttemptRecord(record) {
  return clonePlain(normalizeRunAttemptRecord(record));
}
