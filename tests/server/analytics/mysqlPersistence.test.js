import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { computeMovementAssessment } from "../../../server/analytics/computeMovementAssessment.js";
import { MySQLAnalyticsStore } from "../../../server/analytics/persistence/MySQLAnalyticsStore.js";
import { movementFixture } from "./fixtures.js";

const digest = (character) => `sha256:${character.repeat(64)}`;

const OBSERVATION = Object.freeze({
  instrumentId: "XNAS:AAPL",
  sessionDate: "2026-07-27",
  observedAt: "2026-07-28T00:05:00.000Z",
  provider: "yahoo",
  inputHash: digest("a"),
  bar: Object.freeze({
    providerClose: 214.05,
    providerAdjustedClose: 213.82,
    providerVolume: 48_200_000,
  }),
});

function analyticsRecords() {
  const assessment = computeMovementAssessment(movementFixture());
  return {
    forecast: {
      runId: digest("2"),
      targetSessionDate: assessment.sessionDate,
      informationSetEnd: assessment.forecast.informationSetEnd,
      recordedAt: "2026-07-28T22:01:00.000Z",
      origin: "backfill",
      inputHash: digest("6"),
      configHash: digest("7"),
      forecast: assessment.forecast,
    },
    assessment: {
      runId: digest("2"),
      computedAt: "2026-07-28T22:02:00.000Z",
      inputHash: digest("5"),
      configHash: digest("7"),
      assessment,
    },
  };
}

function transactionalPool(execute) {
  return {
    execute,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  };
}

function observationRow(record, revision = 1) {
  return {
    instrument_id: record.instrumentId,
    session_date: record.sessionDate,
    revision,
    observed_at: new Date(record.observedAt),
    provider: record.provider,
    input_hash: record.inputHash,
    provider_close: record.bar.providerClose,
    provider_adjusted_close: record.bar.providerAdjustedClose,
    provider_volume: record.bar.providerVolume,
  };
}

describe("MySQLAnalyticsStore", () => {
  it("defines append-only tables and coherent idempotency keys", async () => {
    const sql = await readFile(new URL(
      "../../../server/analytics/persistence/migrations/001_create_market_analytics.sql",
      import.meta.url,
    ), "utf8");

    expect(sql.match(/CREATE TABLE IF NOT EXISTS/gu)).toHaveLength(5);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_daily_bar_observation");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_volatility_forecast");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_movement_assessment");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_history_series_manifest");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_analytics_run_attempt");
    expect(sql).toContain(
      "UNIQUE KEY uq_market_bar_revision (instrument_id, session_date, revision)",
    );
    expect(sql).toMatch(
      /UNIQUE KEY uq_market_bar_event \(\s*instrument_id,\s*session_date,\s*observed_at,\s*input_hash\s*\)/u,
    );
    expect(sql).toContain("UNIQUE KEY uq_market_forecast_identity");
    expect(sql).toContain(
      "UNIQUE KEY uq_market_assessment_run_instrument (run_id, instrument_id)",
    );
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\b|ON DUPLICATE/iu);
    expect(sql).not.toMatch(/\braw\b/iu);
  });

  it("persists observation revisions with parameterized INSERT/SELECT only", async () => {
    const rows = [];
    const pool = transactionalPool(vi.fn(async (sql, params) => {
      if (sql.trimStart().startsWith("SELECT")) {
        return [rows.filter((row) => (
          row.instrument_id === params[0] && row.session_date === params[1]
        )), []];
      }
      if (sql.trimStart().startsWith("INSERT")) {
        rows.push({
          instrument_id: params[0],
          session_date: params[1],
          revision: params[2],
          observed_at: params[3],
          provider: params[4],
          input_hash: params[5],
          provider_close: params[6],
          provider_adjusted_close: params[7],
          provider_volume: params[8],
        });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }));
    const store = new MySQLAnalyticsStore(pool);

    const first = await store.appendDailyObservation(OBSERVATION);
    const retry = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T00:10:00.000Z",
    });
    const second = await store.appendDailyObservation({
      ...OBSERVATION,
      inputHash: digest("b"),
      observedAt: "2026-07-28T00:15:00.000Z",
    });

    expect(first.revision).toBe(1);
    expect(retry).toEqual(first);
    expect(second.revision).toBe(2);
    const statements = pool.execute.mock.calls.map(([sql]) => sql.trimStart());
    expect(statements.every((sql) => /^(?:SELECT|INSERT)\b/u.test(sql))).toBe(true);
    expect(statements.join("\n")).not.toMatch(/ON DUPLICATE|(?:^|\n)\s*(?:UPDATE|DELETE)\b/iu);
    expect(pool.commit.mock.calls.length).toBe(pool.beginTransaction.mock.calls.length);
    expect(pool.rollback).not.toHaveBeenCalled();

    const insertCalls = pool.execute.mock.calls.filter(([sql]) => (
      sql.trimStart().startsWith("INSERT")
    ));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual([
      "XNAS:AAPL",
      "2026-07-27",
      1,
      "2026-07-28T00:05:00.000Z",
      "yahoo",
      digest("a"),
      214.05,
      213.82,
      48_200_000,
    ]);
  });

  it("serializes validated forecast and assessment payloads with exact identity parameters", async () => {
    const records = analyticsRecords();
    const pool = transactionalPool(vi.fn(async (sql) => (
      sql.trimStart().startsWith("SELECT")
        ? [[], []]
        : [{ affectedRows: 1 }, []]
    )));
    const store = new MySQLAnalyticsStore(pool);

    await store.appendForecast(records.forecast);
    await store.appendAssessment(records.assessment);

    const forecastInsert = pool.execute.mock.calls.find(([sql]) => (
      sql.includes("INSERT INTO `market_volatility_forecast`")
    ));
    expect(forecastInsert[1]).toEqual([
      records.forecast.runId,
      records.forecast.forecast.instrumentId,
      records.forecast.targetSessionDate,
      records.forecast.informationSetEnd,
      records.forecast.recordedAt,
      "backfill",
      records.forecast.inputHash,
      records.forecast.configHash,
      JSON.stringify(records.forecast.forecast),
    ]);

    const assessmentInsert = pool.execute.mock.calls.find(([sql]) => (
      sql.includes("INSERT INTO `market_movement_assessment`")
    ));
    expect(assessmentInsert[1]).toEqual([
      records.assessment.runId,
      records.assessment.assessment.instrumentId,
      records.assessment.assessment.sessionDate,
      records.assessment.computedAt,
      records.assessment.inputHash,
      records.assessment.configHash,
      JSON.stringify(records.assessment.assessment),
    ]);
    expect(pool.execute.mock.calls
      .map(([sql]) => sql)
      .join("\n")).not.toMatch(/ON DUPLICATE|(?:^|\n)\s*(?:UPDATE|DELETE)\b/iu);
  });

  it("reads the latest assessment per instrument with an ordered, parameterized query", async () => {
    const records = analyticsRecords();
    const row = {
      run_id: records.assessment.runId,
      instrument_id: records.assessment.assessment.instrumentId,
      session_date: records.assessment.assessment.sessionDate,
      computed_at: records.assessment.computedAt,
      input_hash: records.assessment.inputHash,
      config_hash: records.assessment.configHash,
      assessment_json: JSON.stringify(records.assessment.assessment),
    };
    const pool = transactionalPool(vi.fn(async () => [[row], []]));
    const store = new MySQLAnalyticsStore(pool);

    const latest = await store.getLatestAssessment("XNAS:AAPL");
    expect(latest).toEqual(records.assessment);

    const [sql, params] = pool.execute.mock.calls.at(-1);
    expect(sql).toMatch(/WHERE instrument_id = \?/u);
    expect(sql).toMatch(/ORDER BY session_date DESC, computed_at DESC, run_id DESC/u);
    expect(sql).not.toMatch(/IS NULL/u);
    expect(sql).toMatch(/LIMIT 1/u);
    expect(params).toEqual(["XNAS:AAPL"]);

    const mismatched = new MySQLAnalyticsStore(transactionalPool(vi.fn(async () => [[{
      ...row,
      instrument_id: "XNAS:MSFT",
    }], []])));
    await expect(mismatched.getLatestAssessment("XNAS:MSFT")).rejects.toThrow(
      /does not match its indexed column/u,
    );

    const empty = new MySQLAnalyticsStore(transactionalPool(vi.fn(async () => [[], []])));
    expect(await empty.getLatestAssessment("XNAS:AAPL")).toBeNull();
  });

  it("revalidates MySQL JSON rather than trusting persisted payloads", async () => {
    const records = analyticsRecords();
    const corrupted = structuredClone(records.forecast.forecast);
    corrupted.variance = "not-a-number";
    const pool = transactionalPool(vi.fn(async () => [[{
      run_id: records.forecast.runId,
      instrument_id: records.forecast.forecast.instrumentId,
      target_session_date: records.forecast.targetSessionDate,
      information_set_end: records.forecast.informationSetEnd,
      recorded_at: new Date(records.forecast.recordedAt),
      origin: records.forecast.origin,
      input_hash: records.forecast.inputHash,
      config_hash: records.forecast.configHash,
      forecast_json: JSON.stringify(corrupted),
    }], []]));
    const store = new MySQLAnalyticsStore(pool);

    await expect(store.getForecast({
      runId: records.forecast.runId,
      instrumentId: records.forecast.forecast.instrumentId,
      targetSessionDate: records.forecast.targetSessionDate,
      informationSetEnd: records.forecast.informationSetEnd,
      origin: records.forecast.origin,
      inputHash: records.forecast.inputHash,
      configHash: records.forecast.configHash,
    })).rejects.toMatchObject({ code: "schema_invalid" });
  });

  it("uses a transaction when the pool exposes a dedicated connection", async () => {
    const rows = [];
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async (sql, params) => {
        if (sql.trimStart().startsWith("SELECT")) return [rows, []];
        rows.push(observationRow(OBSERVATION, params[2]));
        return [{ affectedRows: 1 }, []];
      }),
    };
    const pool = {
      execute: vi.fn(),
      getConnection: vi.fn(async () => connection),
    };
    const store = new MySQLAnalyticsStore(pool);

    await store.appendDailyObservation(OBSERVATION);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it("refuses a pool without dedicated connections or transaction methods", () => {
    expect(() => new MySQLAnalyticsStore({ execute: vi.fn() }))
      .toThrow(/getConnection\(\) or beginTransaction/);
  });

  it("wraps database failures but not persisted-data validation failures", async () => {
    const cause = new Error("connection refused");
    const store = new MySQLAnalyticsStore({
      query: vi.fn(async () => {
        throw cause;
      }),
      getConnection: vi.fn(),
    });

    await expect(store.listDailyObservations({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
    })).rejects.toMatchObject({
      code: "persistence_unavailable",
      cause,
      details: { operation: "listDailyObservations" },
    });
  });

  it("rejects unsafe table identifiers before issuing SQL", () => {
    expect(() => new MySQLAnalyticsStore({
      pool: { execute: vi.fn(), getConnection: vi.fn() },
      observationTableName: "bars; DROP TABLE users",
    })).toThrow(/observationTableName/);
  });

  it("does not close borrowed pools and closes a shared owned pool once", async () => {
    const borrowed = { execute: vi.fn(), getConnection: vi.fn(), end: vi.fn() };
    const borrowedStore = new MySQLAnalyticsStore({ pool: borrowed });
    await borrowedStore.close();
    await borrowedStore.close();
    expect(borrowed.end).not.toHaveBeenCalled();

    const owned = { execute: vi.fn(), getConnection: vi.fn(), end: vi.fn(async () => {}) };
    const left = new MySQLAnalyticsStore({ pool: owned, ownsPool: true });
    const right = new MySQLAnalyticsStore({ pool: owned, ownsPool: true });
    const first = left.close();
    expect(left.close()).toBe(first);
    await Promise.all([first, right.close(), right.close()]);
    expect(owned.end).toHaveBeenCalledOnce();
  });
});
