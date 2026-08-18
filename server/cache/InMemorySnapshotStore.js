import { clonePlain } from "../../shared/clonePlain.js";
import {
  isSnapshotExpired,
  normalizeSnapshotRecord,
} from "./snapshotRecord.js";

const defaultClone = clonePlain;

const DEFAULT_MAX_ENTRIES = 1_000;

export class InMemorySnapshotStore {
  constructor({ clock = () => Date.now(), clone = defaultClone, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof clone !== "function") throw new TypeError("clone must be a function");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    this.clock = clock;
    this.clone = clone;
    this.maxEntries = maxEntries;
    this.records = new Map();
    this.closePromise = null;
  }

  get size() {
    return this.records.size;
  }

  async get(cacheKey, { allowExpired = false, now = this.clock() } = {}) {
    const record = this.records.get(cacheKey);
    if (!record || (!allowExpired && isSnapshotExpired(record, now))) return null;
    this.records.delete(cacheKey);
    this.records.set(cacheKey, record);
    return this.clone(record);
  }

  async set(record) {
    const normalized = normalizeSnapshotRecord(record);
    const stored = this.clone(normalized);
    this.records.delete(stored.cacheKey);
    this.records.set(stored.cacheKey, stored);
    this.#evictOverflow();
    return this.clone(stored);
  }

  async delete(cacheKey) {
    return this.records.delete(cacheKey);
  }

  async pruneExpired({ before = this.clock() } = {}) {
    let removed = 0;
    for (const [cacheKey, record] of this.records) {
      if (isSnapshotExpired(record, before)) {
        this.records.delete(cacheKey);
        removed += 1;
      }
    }
    return removed;
  }

  async clear() {
    this.records.clear();
  }

  close() {
    if (!this.closePromise) this.closePromise = Promise.resolve();
    return this.closePromise;
  }

  #evictOverflow() {
    while (this.records.size > this.maxEntries) {
      this.records.delete(this.records.keys().next().value);
    }
  }
}
