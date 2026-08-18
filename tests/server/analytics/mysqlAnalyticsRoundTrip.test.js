import { describe, expect, it, vi } from "vitest";

import { MySQLAnalyticsStore } from "../../../server/analytics/persistence/MySQLAnalyticsStore.js";
import {
  HASH,
  OBSERVATION,
  analyticsRecords,
  digest,
  historyInput,
  historyManifest,
  runAttempt,
} from "./persistenceFixtures.js";

const CONDITION = /(\w+) (?:(=|<=|>=|<|>) \?|IN \(([\s?,]*)\))/gu;

function whereClause(text) {
  const start = text.indexOf(" WHERE ");
  if (start < 0) return "";
  const rest = text.slice(start + 7);
  const end = [" ORDER BY ", " LIMIT ", " FOR UPDATE", ") AS "]
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return end === undefined ? rest : rest.slice(0, end);
}

function matches(row, text, params) {
  let cursor = 0;
  for (const [, column, operator, list] of whereClause(text).matchAll(CONDITION)) {
    if (list !== undefined) {
      const count = list.split("?").length - 1;
      const wanted = params.slice(cursor, cursor + count);
      cursor += count;
      if (!wanted.includes(row[column])) return false;
      continue;
    }
    const value = params[cursor];
    cursor += 1;
    const left = row[column];
    if (operator === "=" && left !== value) return false;
    if (operator === "<=" && !(left <= value)) return false;
    if (operator === ">=" && !(left >= value)) return false;
    if (operator === "<" && !(left < value)) return false;
    if (operator === ">" && !(left > value)) return false;
  }
  return true;
}

function ordered(rows, text) {
  const clause = /ORDER BY (.+?)(?: LIMIT| FOR UPDATE|$)/u.exec(text);
  if (!clause) return rows;
  const keys = clause[1].split(",").map((entry) => {
    const [column, direction = "ASC"] = entry.trim().split(/\s+/u);
    return { column, sign: direction.toUpperCase() === "DESC" ? -1 : 1 };
  });
  return [...rows].sort((left, right) => {
    for (const { column, sign } of keys) {
      if (left[column] === right[column]) continue;
      return (left[column] < right[column] ? -1 : 1) * sign;
    }
    return 0;
  });
}

function fakeDatabase() {
  const tables = new Map();
  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const statements = [];
  let failNextInsert = null;

  const execute = vi.fn(async (sql, params = []) => {
    const text = sql.replace(/\s+/gu, " ").trim();
    statements.push(text);
    const name = /(?:FROM|INTO) `([A-Za-z0-9_]+)`/u.exec(text)?.[1];

    if (text.startsWith("INSERT")) {
      if (failNextInsert) {
        const error = failNextInsert;
        failNextInsert = null;
        throw error;
      }
      const columns = /\( ([^)]*) \) VALUES/u.exec(text)[1]
        .split(",")
        .map((column) => column.trim());
      for (let index = 0; index < params.length; index += columns.length) {
        const row = {};
        columns.forEach((column, offset) => { row[column] = params[index + offset]; });
        rowsOf(name).push(row);
      }
      return [{ affectedRows: params.length / columns.length }, []];
    }

    let rows = rowsOf(name).filter((row) => matches(row, text, params));
    if (text.includes("ROW_NUMBER")) {
      const latest = new Map();
      for (const row of rows) {
        const current = latest.get(row.session_date);
        const newer = !current
          || row.observed_at > current.observed_at
          || (row.observed_at === current.observed_at && row.revision > current.revision);
        if (newer) latest.set(row.session_date, row);
      }
      rows = [...latest.values()].sort((left, right) => (
        left.session_date < right.session_date ? -1 : 1
      ));
    } else {
      rows = ordered(rows, text);
    }
    const limit = /LIMIT (\d+)/u.exec(text);
    if (limit) rows = rows.slice(0, Number(limit[1]));
    return [rows.map((row) => ({ ...row })), []];
  });

  const connection = {
    execute,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };

  return {
    pool: { execute, getConnection: vi.fn(async () => connection) },
    connection,
    statements,
    rowsOf,
    failInsertWith: (error) => { failNextInsert = error; },
  };
}

const newStore = () => {
  const database = fakeDatabase();
  return { database, store: new MySQLAnalyticsStore(database.pool) };
};

const lyingStore = (row) => new MySQLAnalyticsStore({
  execute: vi.fn(async () => [[row], []]),
  getConnection: vi.fn(),
});

async function persistedRow(table, append) {
  const { database, store } = newStore();
  await append(store);
  return database.rowsOf(table)[0];
}

describe("MySQL daily observations", () => {
  it("round-trips an observation through its own columns", async () => {
    const { store } = newStore();
    const stored = await store.appendDailyObservation(OBSERVATION);

    expect(stored).toEqual({ ...OBSERVATION, revision: 1 });
    expect(await store.getDailyObservation({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
      inputHash: OBSERVATION.inputHash,
    })).toEqual(stored);
    expect(await store.listDailyObservations({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
    })).toEqual([stored]);
  });

  it("reports a missing observation as null", async () => {
    const { store } = newStore();
    expect(await store.getDailyObservation({
      instrumentId: "XNAS:AAPL",
      sessionDate: "2026-07-27",
      inputHash: HASH.observationA,
    })).toBeNull();
    expect(await store.listDailyObservations({
      instrumentId: "XNAS:AAPL",
      sessionDate: "2026-07-27",
    })).toEqual([]);
  });

  it("appends a new revision only when the payload changes", async () => {
    const { store } = newStore();
    const first = await store.appendDailyObservation(OBSERVATION);
    const replay = await store.appendDailyObservation(OBSERVATION);
    const revised = await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-28T06:00:00.000Z",
      inputHash: HASH.observationB,
      bar: { ...OBSERVATION.bar, providerClose: 215.5 },
    });

    expect(replay).toEqual(first);
    expect(revised.revision).toBe(2);
    const all = await store.listDailyObservations({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
    });
    expect(all.map(({ revision }) => revision)).toEqual([1, 2]);
  });

  it("rejects a replayed event whose content changed", async () => {
    const { store } = newStore();
    await store.appendDailyObservation(OBSERVATION);
    await expect(store.appendDailyObservation({
      ...OBSERVATION,
      bar: { ...OBSERVATION.bar, providerClose: 999 },
    })).rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("returns the latest revision per session as of a cutoff", async () => {
    const { store } = newStore();
    await store.appendDailyObservation(OBSERVATION);
    await store.appendDailyObservation({
      ...OBSERVATION,
      observedAt: "2026-07-29T00:05:00.000Z",
      inputHash: HASH.observationB,
      bar: { ...OBSERVATION.bar, providerClose: 220 },
    });
    await store.appendDailyObservation({
      ...OBSERVATION,
      sessionDate: "2026-07-24",
      inputHash: HASH.observationC,
    });

    const early = await store.listDailyObservationsAsOf({
      instrumentId: OBSERVATION.instrumentId,
      throughObservedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(early.map(({ sessionDate, revision }) => [sessionDate, revision]))
      .toEqual([["2026-07-24", 1], ["2026-07-27", 1]]);

    const late = await store.listDailyObservationsAsOf({
      instrumentId: OBSERVATION.instrumentId,
      throughObservedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(late.find(({ sessionDate }) => sessionDate === "2026-07-27").revision).toBe(2);
  });

  it("rejects a row the index should never have returned", async () => {
    const row = await persistedRow(
      "market_daily_bar_observation",
      (store) => store.appendDailyObservation(OBSERVATION),
    );
    const store = lyingStore(row);

    await expect(store.listDailyObservations({
      instrumentId: "XNAS:MSFT",
      sessionDate: OBSERVATION.sessionDate,
    })).rejects.toThrow(/does not match its indexed query/u);
    await expect(store.getDailyObservation({
      instrumentId: "XNAS:MSFT",
      sessionDate: OBSERVATION.sessionDate,
      inputHash: OBSERVATION.inputHash,
    })).rejects.toThrow(/does not match its indexed query/u);
    await expect(store.listDailyObservationsAsOf({
      instrumentId: "XNAS:MSFT",
      throughObservedAt: "2026-07-30T00:00:00.000Z",
    })).rejects.toThrow(/does not match its indexed query/u);
  });
});

describe("MySQL forecasts and assessments", () => {
  it("round-trips a forecast and lists it by target session", async () => {
    const { store } = newStore();
    const { forecast } = analyticsRecords();
    const stored = await store.appendForecast(forecast);

    expect(stored).toEqual(forecast);
    expect(await store.getForecast({
      runId: forecast.runId,
      instrumentId: forecast.forecast.instrumentId,
      targetSessionDate: forecast.targetSessionDate,
      informationSetEnd: forecast.informationSetEnd,
      origin: forecast.origin,
      inputHash: forecast.inputHash,
      configHash: forecast.configHash,
    })).toEqual(forecast);
    expect(await store.listForecasts({
      instrumentId: forecast.forecast.instrumentId,
      targetSessionDate: forecast.targetSessionDate,
    })).toEqual([forecast]);
  });

  it("treats a replayed forecast identity as a read", async () => {
    const { database, store } = newStore();
    const { forecast } = analyticsRecords();
    await store.appendForecast(forecast);
    const replay = await store.appendForecast(forecast);

    expect(replay).toEqual(forecast);
    expect(database.rowsOf("market_volatility_forecast")).toHaveLength(1);
  });

  it("rejects a forecast identity carrying different content", async () => {
    const { store } = newStore();
    const { forecast } = analyticsRecords();
    await store.appendForecast(forecast);
    await expect(store.appendForecast({
      ...forecast,
      forecast: {
        ...forecast.forecast,
        variance: forecast.forecast.variance * 4,
        dailyVolatility: forecast.forecast.dailyVolatility * 2,
      },
    })).rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("reports a missing forecast as null and an empty list", async () => {
    const { store } = newStore();
    const { forecast } = analyticsRecords();
    expect(await store.getForecast({
      runId: forecast.runId,
      instrumentId: forecast.forecast.instrumentId,
      targetSessionDate: forecast.targetSessionDate,
      informationSetEnd: forecast.informationSetEnd,
      origin: forecast.origin,
      inputHash: forecast.inputHash,
      configHash: forecast.configHash,
    })).toBeNull();
    expect(await store.listForecasts({
      instrumentId: "XNAS:AAPL",
      targetSessionDate: forecast.targetSessionDate,
    })).toEqual([]);
  });

  it("round-trips an assessment by run, by latest and by listing", async () => {
    const { store } = newStore();
    const { assessment } = analyticsRecords();
    const stored = await store.appendAssessment(assessment);

    expect(stored).toEqual(assessment);
    expect(await store.getAssessment({
      runId: assessment.runId,
      instrumentId: assessment.assessment.instrumentId,
    })).toEqual(assessment);
    expect(await store.getLatestAssessment(assessment.assessment.instrumentId))
      .toEqual(assessment);
    expect(await store.listAssessments(assessment.runId)).toEqual([assessment]);
  });

  it("treats a replayed assessment run as a read and rejects a changed one", async () => {
    const { database, store } = newStore();
    const { assessment } = analyticsRecords();
    await store.appendAssessment(assessment);
    expect(await store.appendAssessment(assessment)).toEqual(assessment);
    expect(database.rowsOf("market_movement_assessment")).toHaveLength(1);

    await expect(store.appendAssessment({
      ...assessment,
      inputHash: digest("9"),
    })).rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("reports a missing assessment as null and an empty list", async () => {
    const { store } = newStore();
    expect(await store.getAssessment({ runId: HASH.run, instrumentId: "XNAS:AAPL" }))
      .toBeNull();
    expect(await store.listAssessments(HASH.run)).toEqual([]);
  });

  it("rejects an assessment row the index should never have returned", async () => {
    const { assessment } = analyticsRecords();
    const row = await persistedRow(
      "market_movement_assessment",
      (store) => store.appendAssessment(assessment),
    );
    const store = lyingStore(row);

    await expect(store.listAssessments(digest("8")))
      .rejects.toThrow(/does not match its indexed query/u);
    await expect(store.getAssessment({
      runId: digest("8"),
      instrumentId: assessment.assessment.instrumentId,
    })).rejects.toThrow(/does not match its indexed query/u);
  });

  it("rejects a forecast row the index should never have returned", async () => {
    const { forecast } = analyticsRecords();
    const row = await persistedRow(
      "market_volatility_forecast",
      (store) => store.appendForecast(forecast),
    );
    const store = lyingStore(row);

    await expect(store.listForecasts({
      instrumentId: "XNAS:MSFT",
      targetSessionDate: forecast.targetSessionDate,
    })).rejects.toThrow(/does not match its indexed query/u);
    await expect(store.getForecast({
      runId: digest("8"),
      instrumentId: forecast.forecast.instrumentId,
      targetSessionDate: forecast.targetSessionDate,
      informationSetEnd: forecast.informationSetEnd,
      origin: forecast.origin,
      inputHash: forecast.inputHash,
      configHash: forecast.configHash,
    })).rejects.toThrow(/does not match its indexed query/u);
  });
});

describe("MySQL history manifests", () => {
  it("round-trips a manifest through its twenty-seven columns", async () => {
    const { store } = newStore();
    const manifest = historyManifest();
    const stored = await store.appendHistoryManifest(manifest);

    expect(stored).toEqual(manifest);
    expect(await store.getHistoryManifest(manifest.seriesHash)).toEqual(manifest);
  });

  it("treats a replayed series hash as a read and rejects a changed one", async () => {
    const { database, store } = newStore();
    const manifest = historyManifest();
    await store.appendHistoryManifest(manifest);
    expect(await store.appendHistoryManifest(manifest)).toEqual(manifest);
    expect(database.rowsOf("market_history_series_manifest")).toHaveLength(1);

    await expect(store.appendHistoryManifest({ ...manifest, provider: "finnhub" }))
      .rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("reports a missing manifest as null", async () => {
    const { store } = newStore();
    expect(await store.getHistoryManifest(digest("f"))).toBeNull();
    expect(await store.getHistoryInput(digest("f"))).toBeNull();
  });

  it("ingests a manifest with its observations and reads them back together", async () => {
    const { store } = newStore();
    const input = historyInput();
    const stored = await store.appendHistoryInput(input);

    expect(stored.manifest).toEqual(input.manifest);
    expect(stored.observations.map(({ sessionDate }) => sessionDate))
      .toEqual(input.manifest.sessionDates);
    expect(stored.observations.every(({ revision }) => revision === 1)).toBe(true);

    const readBack = await store.getHistoryInput(input.manifest.seriesHash);
    expect(readBack.manifest).toEqual(input.manifest);
    expect(readBack.observations.map(({ inputHash }) => inputHash))
      .toEqual(input.manifest.barInputHashes);
  });

  it("replays a history input without inserting a second manifest", async () => {
    const { database, store } = newStore();
    const input = historyInput();
    await store.appendHistoryInput(input);
    const replay = await store.appendHistoryInput(input);

    expect(replay.manifest).toEqual(input.manifest);
    expect(database.rowsOf("market_history_series_manifest")).toHaveLength(1);
    expect(database.rowsOf("market_daily_bar_observation")).toHaveLength(3);
  });

  it("rejects a history input whose manifest contradicts the persisted one", async () => {
    const { database, store } = newStore();
    const input = historyInput();
    await store.appendHistoryInput(input);
    database.rowsOf("market_history_series_manifest")[0].provider = "finnhub";

    await expect(store.appendHistoryInput(input))
      .rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("rejects an observation row that escaped its query", async () => {
    const { database, store } = newStore();
    const input = historyInput();
    await store.appendHistoryInput(input);
    database.rowsOf("market_daily_bar_observation")[0].session_date = "2026-07-13";

    await expect(store.getHistoryInput(input.manifest.seriesHash))
      .rejects.toThrow(/observation 0 is missing/u);
  });
});

describe("MySQL run attempts", () => {
  it("round-trips a run attempt and lists it by run", async () => {
    const { store } = newStore();
    const attempt = runAttempt();
    const stored = await store.appendRunAttempt(attempt);

    expect(stored).toEqual(attempt);
    expect(await store.getRunAttempt(attempt.attemptId)).toEqual(attempt);
    expect(await store.listRunAttempts(attempt.runId)).toEqual([attempt]);
  });

  it("treats a replayed attempt as a read and rejects a changed one", async () => {
    const { database, store } = newStore();
    const attempt = runAttempt();
    await store.appendRunAttempt(attempt);
    expect(await store.appendRunAttempt(attempt)).toEqual(attempt);
    expect(database.rowsOf("market_analytics_run_attempt")).toHaveLength(1);

    await expect(store.appendRunAttempt({ ...attempt, status: "failed" }))
      .rejects.toThrow(/identity collides with different persisted content/u);
  });

  it("reports a missing attempt as null and an empty list", async () => {
    const { store } = newStore();
    expect(await store.getRunAttempt(digest("e"))).toBeNull();
    expect(await store.listRunAttempts(digest("e"))).toEqual([]);
  });

  it("rejects an attempt row the index should never have returned", async () => {
    const row = await persistedRow(
      "market_analytics_run_attempt",
      (store) => store.appendRunAttempt(runAttempt()),
    );
    const store = lyingStore(row);

    await expect(store.listRunAttempts(digest("7")))
      .rejects.toThrow(/does not match its indexed query/u);
    await expect(store.getRunAttempt(digest("7")))
      .rejects.toThrow(/does not match its indexed query/u);
  });
});

describe("MySQL append transactions", () => {
  it("commits on success and releases the connection", async () => {
    const { database, store } = newStore();
    await store.appendDailyObservation(OBSERVATION);

    expect(database.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(database.connection.commit).toHaveBeenCalledOnce();
    expect(database.connection.rollback).not.toHaveBeenCalled();
    expect(database.connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back and wraps an unexpected database failure", async () => {
    const { database, store } = newStore();
    const cause = new Error("disk full");
    database.failInsertWith(cause);

    await expect(store.appendDailyObservation(OBSERVATION)).rejects.toMatchObject({
      code: "persistence_unavailable",
      details: { operation: "appendDailyObservation" },
    });
    expect(database.connection.rollback).toHaveBeenCalledOnce();
    expect(database.connection.commit).not.toHaveBeenCalled();
  });

  it("retries a duplicate-key race once and then reads the winning row", async () => {
    const { database, store } = newStore();
    const duplicate = Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
    database.failInsertWith(duplicate);

    const stored = await store.appendDailyObservation(OBSERVATION);
    expect(stored).toEqual({ ...OBSERVATION, revision: 1 });
    expect(database.connection.beginTransaction).toHaveBeenCalledTimes(2);
    expect(database.connection.rollback).toHaveBeenCalledOnce();
  });

  it("gives up when a duplicate-key race repeats", async () => {
    const database = fakeDatabase();
    const duplicate = Object.assign(new Error("duplicate"), { errno: 1062 });
    database.pool.execute.mockImplementation(async (sql) => {
      if (sql.trimStart().startsWith("SELECT")) return [[], []];
      throw duplicate;
    });
    const store = new MySQLAnalyticsStore(database.pool);

    await expect(store.appendDailyObservation(OBSERVATION)).rejects.toMatchObject({
      code: "persistence_unavailable",
    });
    expect(database.connection.beginTransaction).toHaveBeenCalledTimes(2);
  });

  it("survives a rollback that itself fails", async () => {
    const { database, store } = newStore();
    database.connection.rollback.mockRejectedValue(new Error("connection lost"));
    database.failInsertWith(new Error("write failed"));

    await expect(store.appendDailyObservation(OBSERVATION))
      .rejects.toMatchObject({ code: "persistence_unavailable" });
    expect(database.connection.release).toHaveBeenCalledOnce();
  });

  it("rejects a connection without a query method", async () => {
    const pool = {
      execute: vi.fn(),
      getConnection: vi.fn(async () => ({
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
      })),
    };
    const store = new MySQLAnalyticsStore(pool);
    await expect(store.appendDailyObservation(OBSERVATION))
      .rejects.toThrow(/must expose execute\(sql, params\) or query/u);
  });

  it("rejects a connection without transaction methods", async () => {
    const pool = {
      execute: vi.fn(),
      getConnection: vi.fn(async () => ({ execute: vi.fn() })),
    };
    const store = new MySQLAnalyticsStore(pool);
    await expect(store.appendDailyObservation(OBSERVATION))
      .rejects.toThrow(/must expose transaction methods/u);
  });

  it("wraps a read failure with the operation that caused it", async () => {
    const store = new MySQLAnalyticsStore({
      execute: vi.fn(async () => { throw new Error("gone"); }),
      getConnection: vi.fn(),
    });
    await expect(store.getRunAttempt(HASH.attempt)).rejects.toMatchObject({
      code: "persistence_unavailable",
      details: { operation: "getRunAttempt" },
    });
  });
});

describe("MySQL store configuration", () => {
  it("accepts custom table names and uses them in its SQL", async () => {
    const database = fakeDatabase();
    const store = new MySQLAnalyticsStore({
      pool: database.pool,
      observationTableName: "custom_bars",
    });
    await store.appendDailyObservation(OBSERVATION);

    expect(database.rowsOf("custom_bars")).toHaveLength(1);
    expect(store.observationTableName).toBe("custom_bars");
  });

  it.each([
    "forecastTableName",
    "assessmentTableName",
    "manifestTableName",
    "runAttemptTableName",
  ])("rejects an unsafe %s", (option) => {
    expect(() => new MySQLAnalyticsStore({
      pool: { execute: vi.fn(), getConnection: vi.fn() },
      [option]: "t; DROP TABLE users",
    })).toThrow(new RegExp(option, "u"));
  });

  it("accepts a pool that only exposes query()", async () => {
    const database = fakeDatabase();
    const store = new MySQLAnalyticsStore({
      query: database.pool.execute,
      getConnection: database.pool.getConnection,
    });
    await store.appendDailyObservation(OBSERVATION);
    expect(await store.listDailyObservations({
      instrumentId: OBSERVATION.instrumentId,
      sessionDate: OBSERVATION.sessionDate,
    })).toHaveLength(1);
  });

  it("refuses a pool with no way to run SQL", () => {
    expect(() => new MySQLAnalyticsStore({ getConnection: vi.fn() }))
      .toThrow(/execute\(sql, params\) or query/u);
  });
});
