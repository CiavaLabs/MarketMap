import { describe, expect, it, vi } from "vitest";

import {
  deriveDevSessionAuthority,
  devMovementCohort,
  devRunInstant,
  runDevAnalytics,
  startDevAnalyticsBootstrap,
} from "../../server/devAnalytics.js";
import { validateSessionGrid } from "../../server/analytics/data/sessionGrid.js";
import { nyseCalendar } from "../../server/analytics/data/nyseCalendar.js";
import { InMemoryAnalyticsStore } from "../../server/analytics/persistence/InMemoryAnalyticsStore.js";
import { createMarketDataService } from "../../server/createMarketDataService.js";
import { STARTER_INSTRUMENTS } from "../../src/data/workspaces.js";
import { deterministicReturns, historyFromReturns } from "./analytics/fixtures.js";

function benchmarkSeries(returnCount = 8) {
  return historyFromReturns({
    instrumentId: "ARCX:SPY",
    assetClass: "etf",
    returns: deterministicReturns(returnCount, 0.0002),
    start: "2026-07-20T21:00:00.000Z",
    initialPrice: 400,
  });
}

function silentLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("local analytics cohort", () => {
  it("takes the equities of the cross-asset starter board and never the benchmark", () => {
    const cohort = devMovementCohort(STARTER_INSTRUMENTS);

    expect(cohort.length).toBeGreaterThan(0);
    expect(cohort).not.toContain("ARCX:SPY");
    const byId = new Map(STARTER_INSTRUMENTS.map((instrument) => [instrument.id, instrument]));
    expect(cohort.every((id) => byId.get(id)?.assetClass === "equity")).toBe(true);
  });

  it("composes a service the runner accepts", () => {
    expect(() => createMarketDataService({
      analyticsStore: new InMemoryAnalyticsStore(),
      analyticsConfig: { equityInstrumentIds: devMovementCohort(STARTER_INSTRUMENTS) },
    })).not.toThrow();
  });
});

describe("local analytics run instant", () => {
  it("keeps the real clock once the daily cutoff is reached", () => {
    const now = new Date("2026-07-29T22:41:07.000Z");
    expect(devRunInstant(now).toISOString()).toBe("2026-07-29T22:41:07.000Z");
  });

  it("moves an earlier run to the cutoff, never behind the real clock", () => {
    const now = new Date("2026-07-29T15:08:00.000Z");
    const instant = devRunInstant(now);
    expect(instant.toISOString()).toBe("2026-07-29T22:30:00.000Z");
    expect(instant.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("local session authority", () => {
  const AT_CUTOFF = new Date("2026-07-30T23:00:00.000Z");

  it("takes its grid from the exchange calendar, not from the benchmark", () => {
    const authority = deriveDevSessionAuthority(benchmarkSeries(), AT_CUTOFF);

    expect(validateSessionGrid(authority.sessionGrid).calendarId).toBe("US_EQUITIES_CORE");
    expect(authority.sessionGrid.source).toBe(nyseCalendar.source);
    expect(authority.sessionGrid.revision).toBe(nyseCalendar.revision);
    expect(authority.sessionGrid.timeZone).toBe("America/New_York");
  });

  it("names the completed session from the calendar and the clock, not from the data", () => {
    const authority = deriveDevSessionAuthority(benchmarkSeries(), AT_CUTOFF);
    expect(authority.completedSessionDate).toBe("2026-07-30");

    const overWeekend = deriveDevSessionAuthority(
      historyFromReturns({
        instrumentId: "ARCX:SPY",
        assetClass: "etf",
        returns: deterministicReturns(9, 0.0002),
        start: "2026-07-20T21:00:00.000Z",
        initialPrice: 400,
      }),
      new Date("2026-08-02T23:00:00.000Z"),
    );
    expect(overWeekend.completedSessionDate).toBe("2026-07-31");
  });

  it("does not count today's session as complete before its cutoff has passed", () => {
    const midSession = new Date("2026-07-31T15:00:00.000Z");
    expect(nyseCalendar.isSession("2026-07-31")).toBe(true);

    const authority = deriveDevSessionAuthority(benchmarkSeries(), midSession);
    expect(authority.completedSessionDate).toBe("2026-07-30");
    expect(authority.sessionGrid.sessionDates).not.toContain("2026-07-31");
  });

  it("opens the window past the day the run is recorded on, not past the session it assessed", () => {
    const midSession = new Date("2026-07-31T15:00:00.000Z");
    const authority = deriveDevSessionAuthority(benchmarkSeries(), midSession);
    const recordedDate = devRunInstant(midSession).toISOString().slice(0, 10);

    expect(recordedDate).toBe("2026-07-31");
    expect(authority.completedSessionDate).toBe("2026-07-30");
    expect(authority.nextSessionDate).toBe("2026-08-03");
    expect(authority.nextSessionDate > recordedDate).toBe(true);
  });

  it("refuses to run when the provider is missing the session the clock says is complete", () => {
    const stale = benchmarkSeries();
    expect(() => deriveDevSessionAuthority(stale, new Date("2026-08-05T23:00:00.000Z")))
      .toThrow(/listed session\(s\) that did not trade/);
  });

  it("satisfies both window rules the runner enforces", () => {
    const authority = deriveDevSessionAuthority(benchmarkSeries(), AT_CUTOFF);
    const recordedDate = devRunInstant(AT_CUTOFF).toISOString().slice(0, 10);

    expect(authority.sessionGrid.sessionDates.at(-1)).toBe(authority.completedSessionDate);
    expect(recordedDate >= authority.completedSessionDate).toBe(true);
    expect(authority.nextSessionDate > recordedDate).toBe(true);
    expect(nyseCalendar.isSession(authority.nextSessionDate)).toBe(true);
    expect(authority.sessionGrid.sessionDates).not.toContain(authority.nextSessionDate);
  });

  it("reconciles the calendar against the sessions the benchmark actually traded", () => {
    const authority = deriveDevSessionAuthority(benchmarkSeries(), AT_CUTOFF);
    expect(authority.reconciliation).toMatchObject({
      reconciled: true,
      reasonCode: null,
      from: "2026-07-20",
      to: "2026-07-30",
    });
  });

  it("refuses to run when the benchmark traded a session the calendar does not list", () => {
    const series = benchmarkSeries();
    const weekend = {
      ...series,
      bars: [...series.bars, { ...series.bars[0], timestamp: "2026-07-25T20:00:00.000Z" }],
    };
    expect(() => deriveDevSessionAuthority(weekend, AT_CUTOFF))
      .toThrow(/traded session\(s\) it does not list/);
  });

  it("steps over a weekend when opening the run window", () => {
    expect(deriveDevSessionAuthority(benchmarkSeries(), AT_CUTOFF))
      .toMatchObject({ completedSessionDate: "2026-07-30", nextSessionDate: "2026-07-31" });
  });

  it("steps over Independence Day when opening the run window", () => {
    const throughJuly2 = historyFromReturns({
      instrumentId: "ARCX:SPY",
      assetClass: "etf",
      returns: deterministicReturns(5, 0.0002),
      start: "2026-06-25T21:00:00.000Z",
      initialPrice: 400,
    });
    expect(nyseCalendar.isSession("2026-07-03")).toBe(false);
    expect(deriveDevSessionAuthority(throughJuly2, new Date("2026-07-02T23:00:00.000Z")))
      .toMatchObject({ completedSessionDate: "2026-07-02", nextSessionDate: "2026-07-06" });
  });

  it("leaves a holiday out of the grid rather than counting it as a missing session", () => {
    const throughJuly6 = historyFromReturns({
      instrumentId: "ARCX:SPY",
      assetClass: "etf",
      returns: deterministicReturns(6, 0.0002),
      start: "2026-06-25T21:00:00.000Z",
      initialPrice: 400,
    });
    const authority = deriveDevSessionAuthority(throughJuly6, new Date("2026-07-06T23:00:00.000Z"));

    expect(authority.sessionGrid.sessionDates).not.toContain("2026-07-03");
    expect(authority.sessionGrid.sessionDates).toContain("2026-07-02");
    expect(authority.sessionGrid.sessionDates).toContain("2026-07-06");
    expect(authority.reconciliation.reconciled).toBe(true);
  });

  it("refuses a benchmark series too short to describe a calendar", () => {
    expect(() => deriveDevSessionAuthority({ session: { timezone: "America/New_York" }, bars: [] }))
      .toThrow(TypeError);
  });
});

describe("local analytics run", () => {
  it("runs the daily runner over the derived authority", async () => {
    const series = benchmarkSeries();
    const market = {
      getHistoryBatch: vi.fn(async () => ({ data: [series], errors: [] })),
      runDailyAnalytics: vi.fn(async () => ({ status: "completed" })),
    };

    await runDevAnalytics(market, { now: new Date("2026-07-30T23:00:00.000Z") });

    expect(market.getHistoryBatch).toHaveBeenCalledWith(
      ["ARCX:SPY"],
      { range: "5y", interval: "1d", priceBasis: "provider_adjusted" },
    );
    expect(market.runDailyAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      completedSessionDate: "2026-07-30",
      nextSessionDate: "2026-07-31",
    }));
  });

  it("reports an unusable benchmark instead of running blind", async () => {
    const market = {
      getHistoryBatch: vi.fn(async () => ({ data: [], errors: [{ code: "upstream_unavailable" }] })),
      runDailyAnalytics: vi.fn(),
    };

    await expect(runDevAnalytics(market)).rejects.toThrow(/ARCX:SPY/);
    expect(market.runDailyAnalytics).not.toHaveBeenCalled();
  });

  it("waits before pulling history, so the board's first quotes go first", async () => {
    const market = {
      getHistoryBatch: vi.fn(async () => ({ data: [benchmarkSeries()], errors: [] })),
      runDailyAnalytics: vi.fn(async () => ({
        status: "completed",
        completedSessionDate: "2026-07-28",
        counts: { requested: 40, available: 40 },
      })),
    };

    const pending = startDevAnalyticsBootstrap({ market, log: silentLog(), delayMs: 40 });
    expect(market.getHistoryBatch).not.toHaveBeenCalled();

    await pending;
    expect(market.getHistoryBatch).toHaveBeenCalledOnce();
  });

  it("logs a failed bootstrap without rejecting", async () => {
    const log = silentLog();
    const market = {
      getHistoryBatch: vi.fn(async () => { throw new Error("provider down"); }),
      runDailyAnalytics: vi.fn(),
    };

    await expect(startDevAnalyticsBootstrap({ market, log, delayMs: 0 })).resolves.toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("warns when the run is recorded at the cutoff rather than now", async () => {
    const log = silentLog();
    const market = {
      getHistoryBatch: vi.fn(async () => ({ data: [benchmarkSeries()], errors: [] })),
      runDailyAnalytics: vi.fn(async () => ({
        status: "completed",
        completedSessionDate: "2026-07-30",
        counts: { requested: 40, available: 39 },
      })),
    };
    vi.useFakeTimers({ now: new Date("2026-07-30T15:00:00.000Z"), toFake: ["Date"] });

    const summary = await startDevAnalyticsBootstrap({ market, log, delayMs: 0 });

    expect(summary.status).toBe("completed");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("22:30 UTC cutoff"));
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining("39/40"));
    vi.useRealTimers();
  });
});
