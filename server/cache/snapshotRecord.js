import { SCHEMA_VERSION } from "../contracts/core/constants.js";

const REQUIRED_STRINGS = [
  "cacheKey",
  "instrumentId",
  "resourceType",
  "provider",
];

function normalizeDatabaseTimestamp(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

export function toIsoTimestamp(value, label) {
  const normalized = normalizeDatabaseTimestamp(value);
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

export function normalizeSnapshotRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Snapshot record must be an object");
  }

  for (const key of REQUIRED_STRINGS) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0) {
      throw new TypeError(`Snapshot ${key} must be a non-empty string`);
    }
  }
  if (!("payload" in record) || record.payload === undefined) {
    throw new TypeError("Snapshot payload is required");
  }

  const fetchedAt = toIsoTimestamp(record.fetchedAt, "fetchedAt");
  const freshUntil = toIsoTimestamp(record.freshUntil, "freshUntil");
  const staleUntil = toIsoTimestamp(record.staleUntil, "staleUntil");
  if (Date.parse(freshUntil) > Date.parse(staleUntil)) {
    throw new RangeError("freshUntil must not be after staleUntil");
  }

  const schemaVersion = record.schemaVersion ?? SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError("schemaVersion must be a positive integer");
  }

  return {
    cacheKey: record.cacheKey,
    instrumentId: record.instrumentId,
    resourceType: record.resourceType,
    provider: record.provider,
    payload: record.payload,
    sourceAsOf: record.sourceAsOf == null
      ? null
      : toIsoTimestamp(record.sourceAsOf, "sourceAsOf"),
    fetchedAt,
    freshUntil,
    staleUntil,
    schemaVersion,
    payloadHash: record.payloadHash == null ? null : String(record.payloadHash),
    lastSuccessAt: record.lastSuccessAt == null
      ? fetchedAt
      : toIsoTimestamp(record.lastSuccessAt, "lastSuccessAt"),
  };
}

export function isSnapshotExpired(record, now) {
  return Date.parse(record.staleUntil) < now;
}
