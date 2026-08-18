import { describe, expect, it } from "vitest";
import {
  createExchangeCalendar,
  reconcileSessionGrid,
} from "../../../server/analytics/data/exchangeCalendar.js";
import { nyseCalendar } from "../../../server/analytics/data/nyseCalendar.js";
import { validateSessionGrid } from "../../../server/analytics/data/sessionGrid.js";

const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];

function calendar(overrides = {}) {
  return createExchangeCalendar({
    calendarId: "TEST_CALENDAR",
    timeZone: "America/New_York",
    source: "test",
    marketWeekdays: MONDAY_TO_FRIDAY,
    holidayRules: [],
    ...overrides,
  });
}

describe("exchange calendar definition", () => {
  it("refuses a definition it cannot honour", () => {
    expect(() => calendar({ calendarId: "lower case" })).toThrow(TypeError);
    expect(() => calendar({ timeZone: "Mars/Olympus" })).toThrow(TypeError);
    expect(() => calendar({ source: "  " })).toThrow(TypeError);
    expect(() => calendar({ marketWeekdays: [] })).toThrow(TypeError);
    expect(() => calendar({ marketWeekdays: [7] })).toThrow(TypeError);
    expect(() => calendar({ holidayRules: [{ kind: "solstice", name: "x" }] })).toThrow(TypeError);
    expect(() => calendar({ holidayRules: [{ kind: "fixedDate", name: "x", month: 13, day: 1, observance: "none" }] }))
      .toThrow(TypeError);
    expect(() => calendar({ holidayRules: [{ kind: "fixedDate", name: "x", month: 1, day: 1, observance: "maybe" }] }))
      .toThrow(TypeError);
    expect(() => calendar({ adHocClosures: [{ date: "not-a-date", reason: "x" }] })).toThrow(TypeError);
    expect(() => calendar({ adHocClosures: [{ date: "2026-01-05", reason: "" }] })).toThrow(TypeError);
  });

  it("refuses two unscheduled closures on one date", () => {
    expect(() => calendar({
      adHocClosures: [
        { date: "2026-01-05", reason: "first" },
        { date: "2026-01-05", reason: "second" },
      ],
    })).toThrow(TypeError);
  });

  it("versions the rules it evaluates, so a changed evaluator cannot keep the old revision", () => {
    expect(calendar().definition.ruleEngineVersion).toBe(1);
  });

  it("derives a revision from the definition, so an edited rule cannot keep the old one", () => {
    const first = calendar({ holidayRules: [{ name: "A", kind: "nthWeekday", month: 1, weekday: 1, nth: 3 }] });
    const same = calendar({ holidayRules: [{ name: "A", kind: "nthWeekday", month: 1, weekday: 1, nth: 3 }] });
    const edited = calendar({ holidayRules: [{ name: "A", kind: "nthWeekday", month: 1, weekday: 1, nth: 2 }] });
    expect(first.revision).toBe(same.revision);
    expect(edited.revision).not.toBe(first.revision);
    expect(first.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("holiday rules", () => {
  it("places an nth weekday and a last weekday", () => {
    const rules = calendar({
      holidayRules: [
        { name: "Third Monday", kind: "nthWeekday", month: 1, weekday: 1, nth: 3 },
        { name: "Last Monday", kind: "lastWeekday", month: 5, weekday: 1 },
      ],
    });
    expect([...rules.holidaysIn(2026).keys()]).toEqual(["2026-01-19", "2026-05-25"]);
  });

  it("moves a fixed date off the weekend only as its observance allows", () => {
    const nearest = calendar({
      holidayRules: [{ name: "Fixed", kind: "fixedDate", month: 7, day: 4, observance: "nearestWeekday" }],
    });
    expect([...nearest.holidaysIn(2026).keys()]).toEqual(["2026-07-03"]);
    expect([...nearest.holidaysIn(2027).keys()]).toEqual(["2027-07-05"]);

    const sundayOnly = calendar({
      holidayRules: [{ name: "Fixed", kind: "fixedDate", month: 1, day: 1, observance: "sundayToMonday" }],
    });
    expect([...sundayOnly.holidaysIn(2028).keys()]).toEqual([]);
    expect([...sundayOnly.holidaysIn(2023).keys()]).toEqual(["2023-01-02"]);

    const never = calendar({
      holidayRules: [{ name: "Fixed", kind: "fixedDate", month: 12, day: 25, observance: "none" }],
    });
    expect([...never.holidaysIn(2027).keys()]).toEqual([]);
  });

  it("computes a date relative to Easter", () => {
    const easter = calendar({
      holidayRules: [{ name: "Good Friday", kind: "relativeToEaster", offsetDays: -2 }],
    });
    expect([...easter.holidaysIn(2025).keys()]).toEqual(["2025-04-18"]);
    expect([...easter.holidaysIn(2026).keys()]).toEqual(["2026-04-03"]);
    expect([...easter.holidaysIn(2027).keys()]).toEqual(["2027-03-26"]);
    expect([...easter.holidaysIn(2028).keys()]).toEqual(["2028-04-14"]);
  });

  it("honours the years a rule is effective for", () => {
    const scoped = calendar({
      holidayRules: [
        { name: "Later", kind: "fixedDate", month: 6, day: 19, observance: "nearestWeekday", effectiveFrom: 2022 },
        { name: "Earlier", kind: "nthWeekday", month: 3, weekday: 1, nth: 1, effectiveUntil: 2020 },
      ],
    });
    expect([...scoped.holidaysIn(2019).keys()]).toEqual(["2019-03-04"]);
    expect([...scoped.holidaysIn(2021).keys()]).toEqual([]);
    expect([...scoped.holidaysIn(2023).keys()]).toEqual(["2023-06-19"]);
  });
});

describe("sessions", () => {
  it("skips weekends, holidays and unscheduled closures alike", () => {
    const mixed = calendar({
      holidayRules: [{ name: "Fixed", kind: "fixedDate", month: 3, day: 4, observance: "none" }],
      adHocClosures: [{ date: "2026-03-05", reason: "probe" }],
    });
    expect(mixed.sessionDatesBetween("2026-03-01", "2026-03-08"))
      .toEqual(["2026-03-02", "2026-03-03", "2026-03-06"]);
    expect(mixed.isSession("2026-03-04")).toBe(false);
    expect(mixed.isSession("2026-03-05")).toBe(false);
    expect(mixed.isSession("2026-03-07")).toBe(false);
    expect(mixed.isSession("nonsense")).toBe(false);
  });

  it("serves a market whose week is not Monday to Friday", () => {
    const telAvivShaped = calendar({
      marketWeekdays: [0, 1, 2, 3, 4],
      timeZone: "Asia/Jerusalem",
    });
    expect(telAvivShaped.sessionDatesBetween("2026-03-01", "2026-03-07"))
      .toEqual(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
  });

  it("drops a holiday that falls outside the market week rather than shifting it", () => {
    const sundayMarket = calendar({
      marketWeekdays: [0, 1, 2, 3, 4],
      holidayRules: [{ name: "Saturday only", kind: "fixedDate", month: 3, day: 7, observance: "none" }],
    });
    expect([...sundayMarket.holidaysIn(2026).keys()]).toEqual([]);
  });

  it("closes a Sunday the market actually trades", () => {
    const sundayMarket = calendar({
      marketWeekdays: [0, 1, 2, 3, 4],
      holidayRules: [{ name: "Sunday holiday", kind: "fixedDate", month: 3, day: 1, observance: "none" }],
    });
    expect([...sundayMarket.holidaysIn(2026).keys()]).toEqual(["2026-03-01"]);
    expect(sundayMarket.isSession("2026-03-01")).toBe(false);
  });

  it("files an observed holiday under the year it lands in, not the year of its rule", () => {
    const crossing = calendar({
      holidayRules: [{ name: "New Year", kind: "fixedDate", month: 1, day: 1, observance: "nearestWeekday" }],
    });
    expect([...crossing.holidaysIn(2021).keys()]).toContain("2021-12-31");
    expect([...crossing.holidaysIn(2022).keys()]).not.toContain("2021-12-31");
    expect(crossing.isSession("2021-12-31")).toBe(false);
  });

  it("shifts a rule by its offset, which is how one holiday names another's neighbour", () => {
    const dayAfter = calendar({
      holidayRules: [
        { name: "Fourth Thursday", kind: "nthWeekday", month: 11, weekday: 4, nth: 4 },
        { name: "The day after it", kind: "nthWeekday", month: 11, weekday: 4, nth: 4, offsetDays: 1 },
      ],
    });
    expect([...dayAfter.holidaysIn(2024).keys()]).toEqual(["2024-11-28", "2024-11-29"]);
    expect([...dayAfter.holidaysIn(2026).keys()]).toEqual(["2026-11-26", "2026-11-27"]);
  });

  it("refuses a date the month cannot have, rather than rolling it into the next one", () => {
    expect(() => calendar({
      holidayRules: [{ name: "Impossible", kind: "fixedDate", month: 2, day: 31, observance: "none" }],
    })).toThrow(TypeError);

    const leapOnly = calendar({
      holidayRules: [{ name: "Leap day", kind: "fixedDate", month: 2, day: 29, observance: "none" }],
    });
    expect([...leapOnly.holidaysIn(2024).keys()]).toEqual(["2024-02-29"]);
    expect([...leapOnly.holidaysIn(2026).keys()]).toEqual([]);
  });

  it("hands out a holiday map a caller cannot use to change the calendar", () => {
    const fixed = calendar({
      holidayRules: [{ name: "Third Monday", kind: "nthWeekday", month: 1, weekday: 1, nth: 3 }],
    });
    fixed.holidaysIn(2026).clear();
    fixed.holidaysIn(2026).set("2026-06-01", "invented");
    expect([...fixed.holidaysIn(2026).keys()]).toEqual(["2026-01-19"]);
    expect(fixed.isSession("2026-01-19")).toBe(false);
    expect(fixed.isSession("2026-06-01")).toBe(true);
  });

  it("declines the years its rules were never checked against", () => {
    const bounded = calendar({ describedFrom: "2000-01-03" });
    expect(() => bounded.sessionDatesBetween("1969-01-01", "1969-12-31")).toThrow(RangeError);
    expect(() => bounded.earlyClosesBetween("1969-01-01", "1969-12-31")).toThrow(RangeError);
    expect(() => bounded.isSession("1999-12-31")).toThrow(RangeError);
    expect(() => bounded.isSession("1999-12-25")).toThrow(RangeError);
    expect(() => bounded.holidaysIn(1999)).toThrow(RangeError);
    expect(bounded.sessionDatesBetween("2000-01-03", "2000-01-07")).toHaveLength(5);
    expect(() => calendar({ describedFrom: "nonsense" })).toThrow(TypeError);
  });

  it("keeps a fifth weekday that the month does not have out of the next one", () => {
    const fifthMonday = calendar({
      holidayRules: [{ name: "Fifth Monday", kind: "nthWeekday", month: 2, weekday: 1, nth: 5 }],
    });
    expect([...fifthMonday.holidaysIn(2026).keys()]).toEqual([]);
    expect([...fifthMonday.holidaysIn(2027).keys()]).toEqual([]);
    expect([...fifthMonday.holidaysIn(2016).keys()]).toEqual(["2016-02-29"]);
  });

  it("hands out a definition a caller cannot edit", () => {
    const fixed = calendar({
      holidayRules: [{ name: "Third Monday", kind: "nthWeekday", month: 1, weekday: 1, nth: 3 }],
      earlyCloseRules: [{ name: "Eve", kind: "fixedDate", month: 12, day: 24, observance: "none" }],
      adHocClosures: [{ date: "2026-06-01", reason: "probe" }],
    });
    expect(() => fixed.definition.holidayRules.push({})).toThrow(TypeError);
    expect(() => fixed.definition.earlyCloseRules.pop()).toThrow(TypeError);
    expect(() => fixed.definition.adHocClosures.pop()).toThrow(TypeError);
    expect([...fixed.holidaysIn(2031).keys()]).toEqual(["2031-01-20"]);
  });

  it("reports an early close an offset carried into the next year", () => {
    const crossing = calendar({
      earlyCloseRules: [{ name: "Boxing eve", kind: "fixedDate", month: 12, day: 31, observance: "none", offsetDays: 1 }],
    });
    expect(crossing.earlyClosesBetween("2027-01-01", "2027-01-31"))
      .toEqual([{ sessionDate: "2027-01-01", name: "Boxing eve" }]);
  });

  it("refuses a range it cannot walk", () => {
    const plain = calendar();
    expect(() => plain.sessionDatesBetween("2026-03-08", "2026-03-01")).toThrow(RangeError);
    expect(() => plain.sessionDatesBetween("nope", "2026-03-01")).toThrow(TypeError);
    expect(() => plain.sessionGridFor({ from: "2026-03-07", to: "2026-03-08" })).toThrow(RangeError);
  });

  it("reports early closes without letting them remove a session", () => {
    const early = calendar({
      earlyCloseRules: [{ name: "Half day", kind: "fixedDate", month: 12, day: 24, observance: "none" }],
    });
    expect(early.earlyClosesBetween("2026-01-01", "2026-12-31"))
      .toEqual([{ sessionDate: "2026-12-24", name: "Half day" }]);
    expect(early.isSession("2026-12-24")).toBe(true);
  });
});

describe("the grid a calendar produces", () => {
  it("satisfies the session grid contract the runner validates", () => {
    const grid = nyseCalendar.sessionGridFor({ from: "2025-01-02", to: "2026-08-10" });
    expect(() => validateSessionGrid(grid)).not.toThrow();
    expect(grid.calendarId).toBe("US_EQUITIES_CORE");
    expect(grid.timeZone).toBe("America/New_York");
    expect(grid.source).toBe("nyse_published_rules");
    expect(grid.revision).toBe(nyseCalendar.revision);
  });
});

describe("NYSE", () => {
  it("counts the sessions each year actually had", () => {
    expect(nyseCalendar.sessionDatesBetween("2021-01-01", "2021-12-31")).toHaveLength(252);
    expect(nyseCalendar.sessionDatesBetween("2022-01-01", "2022-12-31")).toHaveLength(251);
    expect(nyseCalendar.sessionDatesBetween("2023-01-01", "2023-12-31")).toHaveLength(250);
    expect(nyseCalendar.sessionDatesBetween("2024-01-01", "2024-12-31")).toHaveLength(252);
    expect(nyseCalendar.sessionDatesBetween("2025-01-01", "2025-12-31")).toHaveLength(250);
  });

  it("began observing Martin Luther King Jr. Day in 1998", () => {
    expect(nyseCalendar.isSession("1997-01-20")).toBe(true);
    expect(nyseCalendar.isSession("1998-01-19")).toBe(false);
  });

  it("began observing Juneteenth in 2022", () => {
    expect(nyseCalendar.isSession("2021-06-18")).toBe(true);
    expect(nyseCalendar.isSession("2022-06-20")).toBe(false);
  });

  it("does not recover a New Year that falls on a Saturday", () => {
    expect([...nyseCalendar.holidaysIn(2028).keys()]).toHaveLength(9);
    expect(nyseCalendar.isSession("2027-12-31")).toBe(true);
    expect(nyseCalendar.isSession("2028-01-03")).toBe(true);
  });

  it("closes early the day after Thanksgiving, whichever Friday that is", () => {
    for (const [year, expected] of [
      [2024, ["2024-07-03", "2024-11-29", "2024-12-24"]],
      [2025, ["2025-07-03", "2025-11-28", "2025-12-24"]],
      [2026, ["2026-11-27", "2026-12-24"]],
      [2027, ["2027-11-26"]],
    ]) {
      const closes = nyseCalendar.earlyClosesBetween(`${year}-01-01`, `${year}-12-31`);
      expect(closes.map(({ sessionDate }) => sessionDate), String(year)).toEqual(expected);
      for (const { sessionDate } of closes) {
        expect(nyseCalendar.isSession(sessionDate), sessionDate).toBe(true);
      }
    }
  });

  it("declines the years its rules were never checked against, however it is asked", () => {
    expect(() => nyseCalendar.sessionDatesBetween("1969-01-01", "1969-12-31")).toThrow(RangeError);
    expect(() => nyseCalendar.earlyClosesBetween("1969-01-01", "1969-12-31")).toThrow(RangeError);
    expect(() => nyseCalendar.isSession("1969-05-26")).toThrow(RangeError);
    expect(() => nyseCalendar.isSession("1969-05-25")).toThrow(RangeError);
    expect(() => nyseCalendar.holidaysIn(1969)).toThrow(RangeError);
    expect(nyseCalendar.describedFrom).toBe("1993-02-01");
    expect(nyseCalendar.isSession("1994-04-27")).toBe(false);
  });

  it("leaves the undescribed part of its first year out of the holidays it lists", () => {
    expect([...nyseCalendar.holidaysIn(1993).keys()][0]).toBe("1993-02-15");
    expect([...nyseCalendar.holidaysIn(1994).keys()]).not.toHaveLength(0);
  });

  it("closes for every unscheduled closure on record", () => {
    for (const { date } of nyseCalendar.adHocClosures) {
      expect(nyseCalendar.isSession(date), date).toBe(false);
    }
    expect(nyseCalendar.adHocClosures.map(({ date }) => date)).toEqual([
      "1994-04-27",
      "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14",
      "2004-06-11",
      "2007-01-02",
      "2012-10-29", "2012-10-30",
      "2018-12-05",
      "2025-01-09",
    ]);
  });
});

describe("reconciling a grid against the market", () => {
  const gridOf = (sessionDates) => ({
    calendarId: "TEST_CALENDAR",
    source: "test",
    revision: "sha256:0",
    timeZone: "America/New_York",
    sessionDates,
  });
  const grid = gridOf(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]);

  it("agrees when the market traded exactly the listed sessions", () => {
    const result = reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: grid.sessionDates });
    expect(result.reconciled).toBe(true);
    expect(result.reasonCode).toBeNull();
    expect(result.expectedSessionCount).toBe(5);
  });

  it("names a session the market traded inside the window and the calendar does not list", () => {
    const withHole = gridOf(grid.sessionDates.filter((date) => date !== "2026-03-04"));
    const result = reconcileSessionGrid({
      sessionGrid: withHole,
      observedSessionDates: grid.sessionDates,
    });
    expect(result.reconciled).toBe(false);
    expect(result.reasonCode).toBe("session_grid_disagrees_with_market");
    expect(result.missingFromCalendar).toEqual(["2026-03-04"]);
  });

  it("names a listed session the market did not trade", () => {
    const result = reconcileSessionGrid({
      sessionGrid: grid,
      observedSessionDates: grid.sessionDates.filter((date) => date !== "2026-03-04"),
    });
    expect(result.reconciled).toBe(false);
    expect(result.absentFromMarket).toEqual(["2026-03-04"]);
  });

  it("starts where the observations start and judges through to the end of the grid", () => {
    const leadingOnly = reconcileSessionGrid({
      sessionGrid: gridOf(["2026-02-02", ...grid.sessionDates]),
      observedSessionDates: grid.sessionDates,
    });
    expect(leadingOnly.reconciled).toBe(true);
    expect(leadingOnly.from).toBe("2026-03-02");

    const trailing = reconcileSessionGrid({
      sessionGrid: gridOf([...grid.sessionDates, "2026-03-09"]),
      observedSessionDates: grid.sessionDates,
    });
    expect(trailing.reconciled).toBe(false);
    expect(trailing.absentFromMarket).toEqual(["2026-03-09"]);
    expect(trailing.to).toBe("2026-03-09");
  });

  it("judges through the end of the grid, not only to where the data reaches", () => {
    const result = reconcileSessionGrid({
      sessionGrid: grid,
      observedSessionDates: grid.sessionDates.slice(0, -1),
    });
    expect(result.reconciled).toBe(false);
    expect(result.absentFromMarket).toEqual(["2026-03-06"]);
    expect(result.to).toBe("2026-03-06");
  });

  it("ignores an observation past the end of the grid, which is not what it judges", () => {
    const result = reconcileSessionGrid({
      sessionGrid: grid,
      observedSessionDates: [...grid.sessionDates, "2026-03-09"],
    });
    expect(result.reconciled).toBe(true);
    expect(result.to).toBe("2026-03-06");
  });

  it("refuses an observation that is not a session date instead of dropping it", () => {
    expect(() => reconcileSessionGrid({
      sessionGrid: grid,
      observedSessionDates: ["2026-03-02", "not-a-date"],
    })).toThrow(TypeError);
  });

  it("names a session the market traded before the grid's first, rather than dropping it", () => {
    const result = reconcileSessionGrid({
      sessionGrid: gridOf(["2026-03-02", "2026-03-03"]),
      observedSessionDates: ["2026-02-28", "2026-03-02", "2026-03-03"],
    });
    expect(result.reconciled).toBe(false);
    expect(result.missingFromCalendar).toEqual(["2026-02-28"]);
    expect(result.from).toBe("2026-02-28");
  });

  it("refuses a window where the grid and the market do not overlap at all", () => {
    const result = reconcileSessionGrid({
      sessionGrid: gridOf(["2026-03-02", "2026-03-03"]),
      observedSessionDates: ["2026-03-09"],
    });
    expect(result.reconciled).toBe(false);
    expect(result.reasonCode).toBe("no_overlap_with_session_grid");
  });

  it("reports the same shape whichever way it answers", () => {
    const shapes = [
      reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: grid.sessionDates }),
      reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: [] }),
      reconcileSessionGrid({ sessionGrid: gridOf(["2026-03-02", "2026-03-03"]), observedSessionDates: ["2026-03-09"] }),
      reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: ["2026-03-07"] }),
    ];
    for (const shape of shapes) {
      expect(Object.keys(shape).sort()).toEqual(Object.keys(shapes[0]).sort());
      expect(typeof shape.expectedSessionCount).toBe("number");
      expect(typeof shape.observedSessionCount).toBe("number");
    }
  });

  it("refuses to reconcile against nothing", () => {
    expect(reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: [] }).reasonCode)
      .toBe("no_observed_sessions");
    expect(() => reconcileSessionGrid({ sessionGrid: null, observedSessionDates: [] })).toThrow(TypeError);
    expect(() => reconcileSessionGrid({ sessionGrid: gridOf([]), observedSessionDates: ["2026-03-02"] }))
      .toThrow(TypeError);
    expect(() => reconcileSessionGrid({
      sessionGrid: gridOf(["2026-03-03", "2026-03-02"]),
      observedSessionDates: ["2026-03-02"],
    })).toThrow(TypeError);
    expect(() => reconcileSessionGrid({
      sessionGrid: gridOf(["nonsense", "2026-03-03"]),
      observedSessionDates: ["2026-03-03"],
    })).toThrow(TypeError);
    expect(() => reconcileSessionGrid({ sessionGrid: grid, observedSessionDates: null })).toThrow(TypeError);
  });
});
