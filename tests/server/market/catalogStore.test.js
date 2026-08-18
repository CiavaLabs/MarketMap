import { describe, expect, it, vi } from "vitest";
import {
  InMemoryInstrumentCatalogStore,
  normalizeCatalogRecord,
} from "../../../server/instruments/InstrumentCatalogStore.js";
import { MySQLInstrumentCatalogStore } from "../../../server/instruments/MySQLInstrumentCatalogStore.js";
import { EQUITY_DESCRIPTOR } from "../fixtures/market/descriptors.js";

const CLOCK = () => Date.parse("2026-07-16T20:00:00.000Z");

describe("instrument catalog store", () => {
  it("normalizes records and rejects identity mismatches", () => {
    const record = normalizeCatalogRecord({
      descriptor: EQUITY_DESCRIPTOR,
      lastSeenAt: CLOCK(),
    });
    expect(record.instrumentId).toBe("XNAS:AAPL");
    expect(record.mappingRevision).toBe(1);
    expect(record.status).toBe("active");
    expect(() => normalizeCatalogRecord({
      instrumentId: "XNAS:MSFT",
      descriptor: EQUITY_DESCRIPTOR,
      lastSeenAt: CLOCK(),
    })).toThrowError(/must match its descriptor/);
  });

  it("round-trips descriptors in memory with cloning", async () => {
    const store = new InMemoryInstrumentCatalogStore({ clock: CLOCK });
    await store.set({ descriptor: EQUITY_DESCRIPTOR });
    const record = await store.get("xnas:aapl");
    expect(record.descriptor).toEqual(EQUITY_DESCRIPTOR);
    record.descriptor.name = "mutated";
    expect((await store.get("XNAS:AAPL")).descriptor.name).toBe("Apple Inc.");
    expect(await store.delete("XNAS:AAPL")).toBe(true);
    expect(await store.get("XNAS:AAPL")).toBeNull();
  });

  it("closes the in-memory adapter idempotently", async () => {
    const store = new InMemoryInstrumentCatalogStore({ clock: CLOCK });
    const first = store.close();
    const second = store.close();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it("persists and reads snake_case MySQL rows", async () => {
    const rows = new Map();
    const pool = {
      execute: vi.fn(async (sql, params) => {
        if (sql.startsWith("INSERT")) {
          rows.set(params[0], {
            instrument_id: params[0],
            descriptor_json: params[1],
            mapping_revision: params[2],
            verified_at: params[3],
            last_seen_at: params[4],
            status: params[5],
          });
          return [{}];
        }
        if (sql.startsWith("SELECT")) return [[rows.get(params[0])].filter(Boolean)];
        if (sql.startsWith("DELETE")) return [{ affectedRows: rows.delete(params[0]) ? 1 : 0 }];
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };
    const store = new MySQLInstrumentCatalogStore(pool, { clock: CLOCK });
    await store.set({ descriptor: EQUITY_DESCRIPTOR });
    const record = await store.get("XNAS:AAPL");
    expect(record.descriptor).toEqual(EQUITY_DESCRIPTOR);
    expect(record.lastSeenAt).toBe("2026-07-16T20:00:00.000Z");
    await store.delete("XNAS:AAPL");
    expect(await store.get("XNAS:AAPL")).toBeNull();
  });

  it("maps pool failures to persistence_unavailable", async () => {
    const store = new MySQLInstrumentCatalogStore({
      execute: vi.fn(async () => {
        throw new Error("connection lost");
      }),
    });
    await expect(store.get("XNAS:AAPL")).rejects.toMatchObject({
      code: "persistence_unavailable",
      retryable: true,
    });
  });

  it("does not end an injected pool unless ownership is explicit", async () => {
    const pool = { execute: vi.fn(), end: vi.fn() };
    const store = new MySQLInstrumentCatalogStore({ pool });

    await store.close();
    await store.close();

    expect(pool.end).not.toHaveBeenCalled();
  });

  it("ends an explicitly owned pool once", async () => {
    const pool = { execute: vi.fn(), end: vi.fn(async () => {}) };
    const store = new MySQLInstrumentCatalogStore({ pool, ownsPool: true });
    const first = store.close();
    const second = store.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
