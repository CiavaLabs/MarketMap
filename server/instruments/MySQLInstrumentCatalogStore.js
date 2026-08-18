import { closeOwnedPool } from "../cache/MySQLSnapshotStore.js";
import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import { normalizeCatalogRecord } from "./InstrumentCatalogStore.js";

const DEFAULT_TABLE = "market_instrument_catalog";

function selectRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

function parseDescriptor(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function rowValue(row, camel, snake) {
  return row[camel] ?? row[snake];
}

export class MySQLInstrumentCatalogStore {
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
    this.pool = pool;
    this.tableName = tableName;
    this.clock = clock;
    this.ownsPool = ownsPool === true;
    this.closePromise = null;
    this.executeQuery = (pool.execute || pool.query).bind(pool);
  }

  async get(instrumentId) {
    const result = await this.#execute(
      `SELECT instrument_id, descriptor_json, mapping_revision, verified_at, last_seen_at, status
         FROM \`${this.tableName}\`
        WHERE instrument_id = ?
        LIMIT 1`,
      [`${instrumentId}`.toUpperCase()],
      "get",
    );
    const row = selectRows(result)[0];
    if (!row) return null;
    return normalizeCatalogRecord({
      instrumentId: rowValue(row, "instrumentId", "instrument_id"),
      descriptor: parseDescriptor(rowValue(row, "descriptorJson", "descriptor_json")),
      mappingRevision: Number(rowValue(row, "mappingRevision", "mapping_revision")),
      verifiedAt: rowValue(row, "verifiedAt", "verified_at"),
      lastSeenAt: rowValue(row, "lastSeenAt", "last_seen_at"),
      status: row.status,
    });
  }

  async set(record) {
    const normalized = normalizeCatalogRecord({ lastSeenAt: this.clock(), ...record });
    await this.#execute(
      `INSERT INTO \`${this.tableName}\`
         (instrument_id, descriptor_json, mapping_revision, verified_at, last_seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         descriptor_json = VALUES(descriptor_json),
         mapping_revision = VALUES(mapping_revision),
         verified_at = VALUES(verified_at),
         last_seen_at = VALUES(last_seen_at),
         status = VALUES(status)`,
      [
        normalized.instrumentId,
        JSON.stringify(normalized.descriptor),
        normalized.mappingRevision,
        normalized.verifiedAt ? new Date(normalized.verifiedAt) : null,
        new Date(normalized.lastSeenAt),
        normalized.status,
      ],
      "set",
    );
    return normalized;
  }

  async delete(instrumentId) {
    await this.#execute(
      `DELETE FROM \`${this.tableName}\` WHERE instrument_id = ?`,
      [`${instrumentId}`.toUpperCase()],
      "delete",
    );
    return true;
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
    } catch (error) {
      throw new MarketDataError(
        ERROR_CODES.PERSISTENCE_UNAVAILABLE,
        `Instrument catalog ${operation} failed`,
        { cause: error, retryable: true },
      );
    }
  }
}
