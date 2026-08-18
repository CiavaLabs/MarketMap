import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import {
  isSnapshotExpired,
  normalizeSnapshotRecord,
} from "./snapshotRecord.js";

const DEFAULT_TABLE = "market_data_cache";
const OWNED_POOL_CLOSES = new WeakMap();

export function closeOwnedPool(pool) {
  if (typeof pool?.end !== "function") return Promise.resolve();
  let closePromise = OWNED_POOL_CLOSES.get(pool);
  if (!closePromise) {
    closePromise = Promise.resolve().then(() => pool.end());
    OWNED_POOL_CLOSES.set(pool, closePromise);
  }
  return closePromise;
}

function selectRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

function parsePayload(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function rowValue(row, camel, snake) {
  return row[camel] ?? row[snake];
}

function rowToRecord(row) {
  return normalizeSnapshotRecord({
    cacheKey: rowValue(row, "cacheKey", "cache_key"),
    instrumentId: rowValue(row, "instrumentId", "instrument_id"),
    resourceType: rowValue(row, "resourceType", "resource_type"),
    provider: row.provider,
    payload: parsePayload(rowValue(row, "payload", "payload_json")),
    sourceAsOf: rowValue(row, "sourceAsOf", "source_as_of"),
    fetchedAt: rowValue(row, "fetchedAt", "fetched_at"),
    freshUntil: rowValue(row, "freshUntil", "fresh_until"),
    staleUntil: rowValue(row, "staleUntil", "stale_until"),
    schemaVersion: Number(rowValue(row, "schemaVersion", "schema_version")),
    payloadHash: rowValue(row, "payloadHash", "payload_hash"),
    lastSuccessAt: rowValue(row, "lastSuccessAt", "last_success_at"),
  });
}

function toDatabaseInstant(value) {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

export class MySQLSnapshotStore {
  constructor(poolOrOptions, options = {}) {
    const config = poolOrOptions?.pool
      ? poolOrOptions
      : { ...options, pool: poolOrOptions };
    const {
      pool,
      tableName = DEFAULT_TABLE,
      clock = () => Date.now(),
      ownsPool = false,
    } = config;

    if (!pool || (typeof pool.execute !== "function" && typeof pool.query !== "function")) {
      throw new TypeError("pool must expose execute(sql, params) or query(sql, params)");
    }
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
      throw new TypeError("tableName may contain only letters, digits, and underscores");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");

    this.pool = pool;
    this.tableName = tableName;
    this.clock = clock;
    this.ownsPool = ownsPool === true;
    this.closePromise = null;
    this.executeQuery = (pool.execute || pool.query).bind(pool);
  }

  async get(cacheKey, { allowExpired = false, now = this.clock() } = {}) {
    const result = await this.#execute(
      `SELECT cache_key, instrument_id, resource_type, provider, payload_json,
              CAST(source_as_of AS CHAR) AS source_as_of,
              CAST(fetched_at AS CHAR) AS fetched_at,
              CAST(fresh_until AS CHAR) AS fresh_until,
              CAST(stale_until AS CHAR) AS stale_until,
              schema_version, payload_hash,
              CAST(last_success_at AS CHAR) AS last_success_at
         FROM \`${this.tableName}\`
        WHERE cache_key = ?
        LIMIT 1`,
      [cacheKey],
      "get",
    );
    const row = selectRows(result)[0];
    if (!row) return null;

    const record = rowToRecord(row);
    return !allowExpired && isSnapshotExpired(record, now) ? null : record;
  }

  async set(record) {
    const normalized = normalizeSnapshotRecord(record);
    await this.#execute(
      `INSERT INTO \`${this.tableName}\` (
         cache_key, instrument_id, resource_type, provider, payload_json,
         source_as_of, fetched_at, fresh_until, stale_until,
         schema_version, payload_hash, last_success_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         instrument_id = VALUES(instrument_id),
         resource_type = VALUES(resource_type),
         provider = VALUES(provider),
         payload_json = VALUES(payload_json),
         source_as_of = VALUES(source_as_of),
         fetched_at = VALUES(fetched_at),
         fresh_until = VALUES(fresh_until),
         stale_until = VALUES(stale_until),
         schema_version = VALUES(schema_version),
         payload_hash = VALUES(payload_hash),
         last_success_at = VALUES(last_success_at)`,
      [
        normalized.cacheKey,
        normalized.instrumentId,
        normalized.resourceType,
        normalized.provider,
        JSON.stringify(normalized.payload),
        normalized.sourceAsOf ? toDatabaseInstant(normalized.sourceAsOf) : null,
        toDatabaseInstant(normalized.fetchedAt),
        toDatabaseInstant(normalized.freshUntil),
        toDatabaseInstant(normalized.staleUntil),
        normalized.schemaVersion,
        normalized.payloadHash,
        toDatabaseInstant(normalized.lastSuccessAt),
      ],
      "set",
    );
    return normalized;
  }

  async delete(cacheKey) {
    const result = await this.#execute(
      `DELETE FROM \`${this.tableName}\` WHERE cache_key = ?`,
      [cacheKey],
      "delete",
    );
    const header = Array.isArray(result) ? result[0] : result;
    return Number(header?.affectedRows || 0) > 0;
  }

  async pruneExpired({ before = this.clock() } = {}) {
    const result = await this.#execute(
      `DELETE FROM \`${this.tableName}\` WHERE stale_until < ?`,
      [toDatabaseInstant(before)],
      "pruneExpired",
    );
    const header = Array.isArray(result) ? result[0] : result;
    return Number(header?.affectedRows || 0);
  }

  close() {
    if (!this.closePromise) {
      this.closePromise = this.ownsPool
        ? closeOwnedPool(this.pool)
        : Promise.resolve();
    }
    return this.closePromise;
  }

  async #execute(sql, params, operation) {
    try {
      return await this.executeQuery(sql, params);
    } catch (cause) {
      throw new MarketDataError(
        ERROR_CODES.PERSISTENCE_UNAVAILABLE,
        "Snapshot persistence operation failed",
        { cause, details: { operation } },
      );
    }
  }
}
