import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import { InMemorySnapshotStore } from "../../server/cache/InMemorySnapshotStore.js";
import { MySQLSnapshotStore } from "../../server/cache/MySQLSnapshotStore.js";

const record = {
  cacheKey: "quote:XNAS:AAPL",
  instrumentId: "XNAS:AAPL",
  resourceType: "quote",
  provider: "yahoo",
  payload: { price: 225.5 },
  sourceAsOf: "2026-07-13T18:45:00.000Z",
  fetchedAt: "2026-07-13T18:45:01.000Z",
  freshUntil: "2026-07-13T18:45:31.000Z",
  staleUntil: "2026-07-14T18:45:01.000Z",
  schemaVersion: 1,
  payloadHash: "sha256:abc",
  lastSuccessAt: "2026-07-13T18:45:01.000Z",
};

describe("InMemorySnapshotStore", () => {
  it("stores isolated snapshots and enforces their stale boundary", async () => {
    let now = Date.parse("2026-07-13T19:00:00Z");
    const store = new InMemorySnapshotStore({ clock: () => now });
    const saved = await store.set(record);
    saved.payload.price = 1;

    expect(await store.get(record.cacheKey)).toMatchObject({ payload: { price: 225.5 } });
    now = Date.parse("2026-07-14T18:45:01.001Z");
    expect(await store.get(record.cacheKey)).toBeNull();
    expect(await store.get(record.cacheKey, { allowExpired: true })).toMatchObject({
      cacheKey: record.cacheKey,
    });
    expect(await store.pruneExpired()).toBe(1);
  });

  it("evicts the least recently used record once it reaches its cap", async () => {
    const now = Date.parse("2026-07-13T19:00:00Z");
    const store = new InMemorySnapshotStore({ clock: () => now, maxEntries: 2 });
    const at = (cacheKey) => ({ ...record, cacheKey });

    await store.set(at("quote:A"));
    await store.set(at("quote:B"));
    await store.get("quote:A");
    await store.set(at("quote:C"));

    expect(store.size).toBe(2);
    expect(await store.get("quote:B")).toBeNull();
    expect(await store.get("quote:A")).toMatchObject({ cacheKey: "quote:A" });
    expect(await store.get("quote:C")).toMatchObject({ cacheKey: "quote:C" });
  });

  it("rejects a cap that cannot hold a record", () => {
    expect(() => new InMemorySnapshotStore({ maxEntries: 0 }))
      .toThrow("maxEntries must be a positive integer");
  });

  it("rejects an inverted fresh/stale window", async () => {
    await expect(new InMemorySnapshotStore().set({
      ...record,
      freshUntil: "2026-07-15T00:00:00Z",
    })).rejects.toThrow("freshUntil must not be after staleUntil");
  });

  it("closes idempotently", async () => {
    const store = new InMemorySnapshotStore();
    const first = store.close();
    const second = store.close();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});

describe("MySQLSnapshotStore", () => {
  it("binds instants as UTC wall clock so the connection timezone cannot shift them", async () => {
    const bound = [];
    const stored = new Map();
    const pool = {
      execute: vi.fn(async (sql, params) => {
        if (sql.includes("INSERT")) {
          bound.push(params);
          stored.set(params[0], params);
          return [{ affectedRows: 1 }, []];
        }
        const params0 = stored.get(params[0]);
        if (!params0) return [[], []];
        return [[{
          cache_key: params0[0],
          instrument_id: params0[1],
          resource_type: params0[2],
          provider: params0[3],
          payload_json: params0[4],
          source_as_of: params0[5],
          fetched_at: params0[6],
          fresh_until: params0[7],
          stale_until: params0[8],
          schema_version: params0[9],
          payload_hash: params0[10],
          last_success_at: params0[11],
        }], []];
      }),
    };
    const store = new MySQLSnapshotStore({ pool, clock: () => Date.parse(record.fetchedAt) });

    await store.set(record);
    const [params] = bound;
    expect(params[6]).toBe(record.fetchedAt.replace("T", " ").replace("Z", ""));
    expect(params.every((value) => !(value instanceof Date))).toBe(true);

    const roundTripped = await store.get(record.cacheKey, { allowExpired: true });
    expect(roundTripped.fetchedAt).toBe(record.fetchedAt);
    expect(roundTripped.freshUntil).toBe(record.freshUntil);
    expect(roundTripped.staleUntil).toBe(record.staleUntil);
  });

  it("reads the instant columns as characters rather than driver dates", async () => {
    const pool = { execute: vi.fn(async () => [[], []]) };
    const store = new MySQLSnapshotStore({ pool });
    await store.get("quote:XNAS:AAPL");
    const [sql] = pool.execute.mock.calls[0];
    for (const column of ["fetched_at", "fresh_until", "stale_until", "last_success_at", "source_as_of"]) {
      expect(sql).toContain(`CAST(${column} AS CHAR) AS ${column}`);
    }
  });

  it("uses an injected generic pool for parameterized upserts and reads", async () => {
    const row = {
      cache_key: record.cacheKey,
      instrument_id: record.instrumentId,
      resource_type: record.resourceType,
      provider: record.provider,
      payload_json: JSON.stringify(record.payload),
      source_as_of: new Date(record.sourceAsOf),
      fetched_at: new Date(record.fetchedAt),
      fresh_until: new Date(record.freshUntil),
      stale_until: new Date(record.staleUntil),
      schema_version: record.schemaVersion,
      payload_hash: record.payloadHash,
      last_success_at: new Date(record.lastSuccessAt),
    };
    const pool = {
      execute: vi.fn(async (sql) => sql.includes("SELECT")
        ? [[row], []]
        : [{ affectedRows: 1 }, []]),
    };
    const store = new MySQLSnapshotStore({
      pool,
      clock: () => Date.parse("2026-07-13T19:00:00Z"),
    });

    await expect(store.set(record)).resolves.toMatchObject({ cacheKey: record.cacheKey });
    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(insertSql).toContain("ON DUPLICATE KEY UPDATE");
    expect(insertParams[0]).toBe(record.cacheKey);
    expect(insertParams[4]).toBe(JSON.stringify(record.payload));

    await expect(store.get(record.cacheKey)).resolves.toEqual(record);
    const [selectSql, selectParams] = pool.execute.mock.calls[1];
    expect(selectSql).toContain("WHERE cache_key = ?");
    expect(selectParams).toEqual([record.cacheKey]);
  });

  it("supports query-only pools and wraps database failures", async () => {
    const cause = new Error("connection refused");
    const pool = { query: vi.fn(async () => { throw cause; }) };
    const store = new MySQLSnapshotStore(pool);

    await expect(store.get(record.cacheKey)).rejects.toMatchObject({
      code: ERROR_CODES.PERSISTENCE_UNAVAILABLE,
      cause,
      details: { operation: "get" },
    });
  });

  it("rejects unsafe table identifiers before issuing SQL", () => {
    expect(() => new MySQLSnapshotStore({
      pool: { execute: vi.fn() },
      tableName: "cache; DROP TABLE users",
    })).toThrow("tableName");
  });

  it("does not end an injected pool without explicit ownership", async () => {
    const pool = { execute: vi.fn(), end: vi.fn() };
    const store = new MySQLSnapshotStore({ pool });

    await store.close();
    await store.close();

    expect(pool.end).not.toHaveBeenCalled();
  });

  it("ends an explicitly owned pool once", async () => {
    const pool = { execute: vi.fn(), end: vi.fn(async () => {}) };
    const store = new MySQLSnapshotStore({ pool, ownsPool: true });
    const first = store.close();
    const second = store.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
