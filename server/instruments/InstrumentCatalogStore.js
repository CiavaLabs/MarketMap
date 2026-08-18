import { validateInstrumentDescriptor } from "../contracts/market/instrument.js";

export function toIsoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

export function normalizeCatalogRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Catalog record must be an object");
  }
  const descriptor = validateInstrumentDescriptor(record.descriptor);
  const instrumentId = record.instrumentId || descriptor.id;
  if (instrumentId !== descriptor.id) {
    throw new TypeError("Catalog record instrumentId must match its descriptor");
  }
  const mappingRevision = Number(record.mappingRevision ?? 1);
  if (!Number.isInteger(mappingRevision) || mappingRevision < 1) {
    throw new TypeError("mappingRevision must be a positive integer");
  }
  return {
    instrumentId,
    descriptor,
    mappingRevision,
    verifiedAt: record.verifiedAt == null ? null : toIsoTimestamp(record.verifiedAt, "verifiedAt"),
    lastSeenAt: toIsoTimestamp(record.lastSeenAt ?? Date.now(), "lastSeenAt"),
    status: descriptor.status,
  };
}

export class InMemoryInstrumentCatalogStore {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.records = new Map();
    this.closePromise = null;
  }

  async get(instrumentId) {
    const record = this.records.get(`${instrumentId}`.toUpperCase());
    return record ? structuredClone(record) : null;
  }

  async set(record) {
    const normalized = normalizeCatalogRecord({
      lastSeenAt: this.clock(),
      ...record,
    });
    this.records.set(normalized.instrumentId, normalized);
    return normalized;
  }

  async delete(instrumentId) {
    return this.records.delete(`${instrumentId}`.toUpperCase());
  }

  get size() {
    return this.records.size;
  }

  close() {
    if (!this.closePromise) this.closePromise = Promise.resolve();
    return this.closePromise;
  }
}
