import { analyticsSha256 } from "../canonicalDigest.js";
import { isSessionDate, isValidTimeZone } from "./sessionDate.js";
import { validateSessionGrid } from "./sessionGrid.js";

const DAY_MS = 86_400_000;
const RULE_ENGINE_VERSION = 1;
const CALENDAR_ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/u;
const DAYS_IN_MONTH = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

export const HOLIDAY_RULE_KINDS = Object.freeze([
  "fixedDate",
  "nthWeekday",
  "lastWeekday",
  "relativeToEaster",
]);

export const OBSERVANCES = Object.freeze([
  "none",
  "nearestWeekday",
  "sundayToMonday",
]);

function utcDay(year, month, day) {
  return Date.UTC(year, month - 1, day);
}

function sessionDateOf(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}

function weekdayOf(instant) {
  return new Date(instant).getUTCDay();
}

function instantOf(sessionDate) {
  return Date.parse(`${sessionDate}T00:00:00.000Z`);
}

function nthWeekdayOf(year, month, weekday, nth) {
  const first = utcDay(year, month, 1);
  const offset = (weekday - weekdayOf(first) + 7) % 7;
  const instant = first + (offset + (nth - 1) * 7) * DAY_MS;
  return new Date(instant).getUTCMonth() === month - 1 ? instant : null;
}

function lastWeekdayOf(year, month, weekday) {
  const last = utcDay(year, month + 1, 1) - DAY_MS;
  return last - ((weekdayOf(last) - weekday + 7) % 7) * DAY_MS;
}

function easterSundayOf(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDay(year, month, day);
}

function applyObservance(instant, observance) {
  const weekday = weekdayOf(instant);
  if (observance === "nearestWeekday") {
    if (weekday === 6) return instant - DAY_MS;
    if (weekday === 0) return instant + DAY_MS;
    return instant;
  }
  if (observance === "sundayToMonday") {
    return weekday === 0 ? instant + DAY_MS : instant;
  }
  return instant;
}

function fixedDateInstant(year, month, day) {
  const instant = utcDay(year, month, day);
  const date = new Date(instant);
  const exists = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  return exists ? instant : null;
}

function ruleInstant(rule, year) {
  const offset = (rule.offsetDays ?? 0) * DAY_MS;
  if (rule.kind === "fixedDate") {
    const base = fixedDateInstant(year, rule.month, rule.day);
    return base === null ? null : applyObservance(base + offset, rule.observance);
  }
  if (rule.kind === "nthWeekday") {
    const base = nthWeekdayOf(year, rule.month, rule.weekday, rule.nth);
    return base === null ? null : base + offset;
  }
  if (rule.kind === "lastWeekday") return lastWeekdayOf(year, rule.month, rule.weekday) + offset;
  return easterSundayOf(year) + offset;
}

function ruleAppliesIn(rule, year) {
  if (Number.isInteger(rule.effectiveFrom) && year < rule.effectiveFrom) return false;
  return !(Number.isInteger(rule.effectiveUntil) && year > rule.effectiveUntil);
}

function normalizeRule(rule, label) {
  if (!rule || typeof rule !== "object") throw new TypeError(`${label} must be an object`);
  const { kind, name } = rule;
  if (!HOLIDAY_RULE_KINDS.includes(kind)) {
    throw new TypeError(`${label}.kind must be one of ${HOLIDAY_RULE_KINDS.join(", ")}`);
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError(`${label}.name must be a non-empty string`);
  }
  const normalized = { kind, name: name.trim() };
  if (kind === "fixedDate") {
    if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) {
      throw new TypeError(`${label}.month must be a month number`);
    }
    if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > DAYS_IN_MONTH[rule.month - 1]) {
      throw new TypeError(`${label}.day must be a day that month can have`);
    }
    if (!OBSERVANCES.includes(rule.observance)) {
      throw new TypeError(`${label}.observance must be one of ${OBSERVANCES.join(", ")}`);
    }
    normalized.month = rule.month;
    normalized.day = rule.day;
    normalized.observance = rule.observance;
  } else if (kind === "nthWeekday") {
    if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) {
      throw new TypeError(`${label}.month must be a month number`);
    }
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      throw new TypeError(`${label}.weekday must be a weekday number`);
    }
    if (!Number.isInteger(rule.nth) || rule.nth < 1 || rule.nth > 5) {
      throw new TypeError(`${label}.nth must be between one and five`);
    }
    normalized.month = rule.month;
    normalized.weekday = rule.weekday;
    normalized.nth = rule.nth;
  } else if (kind === "lastWeekday") {
    if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) {
      throw new TypeError(`${label}.month must be a month number`);
    }
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      throw new TypeError(`${label}.weekday must be a weekday number`);
    }
    normalized.month = rule.month;
    normalized.weekday = rule.weekday;
  }
  if (kind === "relativeToEaster") {
    if (!Number.isInteger(rule.offsetDays)) {
      throw new TypeError(`${label}.offsetDays must be an integer`);
    }
    normalized.offsetDays = rule.offsetDays;
  } else if (rule.offsetDays !== undefined) {
    if (!Number.isInteger(rule.offsetDays)) {
      throw new TypeError(`${label}.offsetDays must be an integer`);
    }
    normalized.offsetDays = rule.offsetDays;
  }
  if (rule.effectiveFrom !== undefined) {
    if (!Number.isInteger(rule.effectiveFrom)) {
      throw new TypeError(`${label}.effectiveFrom must be a year`);
    }
    normalized.effectiveFrom = rule.effectiveFrom;
  }
  if (rule.effectiveUntil !== undefined) {
    if (!Number.isInteger(rule.effectiveUntil)) {
      throw new TypeError(`${label}.effectiveUntil must be a year`);
    }
    normalized.effectiveUntil = rule.effectiveUntil;
  }
  return Object.freeze(normalized);
}

function normalizeClosure(closure, label) {
  if (!closure || typeof closure !== "object") throw new TypeError(`${label} must be an object`);
  if (!isSessionDate(closure.date)) throw new TypeError(`${label}.date must be a session date`);
  if (typeof closure.reason !== "string" || !closure.reason.trim()) {
    throw new TypeError(`${label}.reason must be a non-empty string`);
  }
  return Object.freeze({ date: closure.date, reason: closure.reason.trim() });
}

function normalizeWeekdays(marketWeekdays) {
  if (!Array.isArray(marketWeekdays) || !marketWeekdays.length) {
    throw new TypeError("marketWeekdays must list at least one weekday");
  }
  const weekdays = [...new Set(marketWeekdays)].sort((left, right) => left - right);
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new TypeError("marketWeekdays must contain weekday numbers between zero and six");
  }
  return Object.freeze(weekdays);
}

function requireSessionDateRange(from, to, describedFrom, calendarId) {
  if (!isSessionDate(from) || !isSessionDate(to)) {
    throw new TypeError("from and to must be session dates");
  }
  if (from > to) throw new RangeError("from must not be after to");
  if (describedFrom && from < describedFrom) {
    throw new RangeError(
      `${calendarId} describes sessions from ${describedFrom} onwards. Its rules are the exchange's `
      + `current ones and were never checked against ${from}, so it will not answer for that date.`,
    );
  }
}

export function createExchangeCalendar({
  calendarId,
  timeZone,
  source,
  marketWeekdays,
  holidayRules = [],
  earlyCloseRules = [],
  adHocClosures = [],
  describedFrom = null,
} = {}) {
  if (typeof calendarId !== "string" || !CALENDAR_ID_PATTERN.test(calendarId)) {
    throw new TypeError("calendarId must match the session grid identifier format");
  }
  if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) {
    throw new TypeError("timeZone must be a valid IANA timezone");
  }
  if (typeof source !== "string" || !source.trim()) {
    throw new TypeError("source must be a non-empty string");
  }

  if (describedFrom !== null && !isSessionDate(describedFrom)) {
    throw new TypeError("describedFrom must be a session date");
  }
  const weekdays = normalizeWeekdays(marketWeekdays);
  const rules = Object.freeze(
    holidayRules.map((rule, index) => normalizeRule(rule, `holidayRules[${index}]`)),
  );
  const earlyCloses = Object.freeze(
    earlyCloseRules.map((rule, index) => normalizeRule(rule, `earlyCloseRules[${index}]`)),
  );
  const closures = Object.freeze(
    adHocClosures.map((closure, index) => normalizeClosure(closure, `adHocClosures[${index}]`)),
  );
  const closureDates = new Set(closures.map(({ date }) => date));
  if (closureDates.size !== closures.length) {
    throw new TypeError("adHocClosures must not repeat a date");
  }

  const definition = Object.freeze({
    ruleEngineVersion: RULE_ENGINE_VERSION,
    calendarId,
    timeZone,
    source,
    marketWeekdays: weekdays,
    holidayRules: rules,
    earlyCloseRules: earlyCloses,
    adHocClosures: closures,
    describedFrom,
  });
  const revision = analyticsSha256(definition);
  const holidayCache = new Map();

  function requireDescribed(sessionDate) {
    if (describedFrom && sessionDate < describedFrom) {
      throw new RangeError(
        `${calendarId} describes sessions from ${describedFrom} onwards. Its rules are the exchange's `
        + `current ones and were never checked against ${sessionDate}, so it will not answer for that date.`,
      );
    }
  }

  function computeHolidays(year) {
    if (!holidayCache.has(year)) {
      const dates = new Map();
      for (const nominalYear of [year - 1, year, year + 1]) {
        for (const rule of rules) {
          if (!ruleAppliesIn(rule, nominalYear)) continue;
          const instant = ruleInstant(rule, nominalYear);
          if (instant === null) continue;
          if (!weekdays.includes(weekdayOf(instant))) continue;
          const sessionDate = sessionDateOf(instant);
          if (Number(sessionDate.slice(0, 4)) !== year) continue;
          dates.set(sessionDate, rule.name);
        }
      }
      holidayCache.set(year, [...dates].sort(([left], [right]) => left.localeCompare(right)));
    }
    return holidayCache.get(year);
  }

  function holidaysIn(year) {
    requireDescribed(`${year}-12-31`);
    return new Map(computeHolidays(year).filter(([date]) => !describedFrom || date >= describedFrom));
  }

  function isSession(sessionDate) {
    if (!isSessionDate(sessionDate)) return false;
    requireDescribed(sessionDate);
    const instant = instantOf(sessionDate);
    if (!weekdays.includes(weekdayOf(instant))) return false;
    if (closureDates.has(sessionDate)) return false;
    return !computeHolidays(Number(sessionDate.slice(0, 4)))
      .some(([date]) => date === sessionDate);
  }

  function sessionDatesBetween(from, to) {
    requireSessionDateRange(from, to, describedFrom, calendarId);
    const dates = [];
    for (let instant = instantOf(from); instant <= instantOf(to); instant += DAY_MS) {
      const sessionDate = sessionDateOf(instant);
      if (isSession(sessionDate)) dates.push(sessionDate);
    }
    return dates;
  }

  function earlyClosesBetween(from, to) {
    requireSessionDateRange(from, to, describedFrom, calendarId);
    const found = [];
    const firstYear = Number(from.slice(0, 4)) - 1;
    const lastYear = Number(to.slice(0, 4)) + 1;
    for (let year = firstYear; year <= lastYear; year += 1) {
      for (const rule of earlyCloses) {
        if (!ruleAppliesIn(rule, year)) continue;
        const instant = ruleInstant(rule, year);
        if (instant === null) continue;
        const sessionDate = sessionDateOf(instant);
        if (sessionDate < from || sessionDate > to || !isSession(sessionDate)) continue;
        found.push({ sessionDate, name: rule.name });
      }
    }
    return found.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  }

  function sessionGridFor({ from, to } = {}) {
    const sessionDates = sessionDatesBetween(from, to);
    if (sessionDates.length < 2) {
      throw new RangeError("A session grid needs at least two sessions in its window");
    }
    return Object.freeze({
      calendarId,
      source,
      revision,
      timeZone,
      sessionDates: Object.freeze(sessionDates),
    });
  }

  return Object.freeze({
    calendarId,
    timeZone,
    source,
    revision,
    definition,
    marketWeekdays: weekdays,
    describedFrom,
    adHocClosures: definition.adHocClosures,
    holidaysIn,
    isSession,
    sessionDatesBetween,
    earlyClosesBetween,
    sessionGridFor,
  });
}

export function reconcileSessionGrid({ sessionGrid, observedSessionDates } = {}) {
  const grid = validateSessionGrid(sessionGrid);
  if (!Array.isArray(observedSessionDates)) {
    throw new TypeError("observedSessionDates must be an array");
  }
  const malformed = observedSessionDates.filter((date) => !isSessionDate(date));
  if (malformed.length) {
    throw new TypeError(
      `observedSessionDates contains ${malformed.length} value(s) that are not session dates`,
    );
  }
  const observed = [...new Set(observedSessionDates)].sort();
  if (!observed.length) {
    return Object.freeze({
      reconciled: false,
      reasonCode: "no_observed_sessions",
      from: null,
      to: null,
      expectedSessionCount: 0,
      observedSessionCount: 0,
      missingFromCalendar: Object.freeze([]),
      absentFromMarket: Object.freeze([]),
    });
  }

  const gridDates = grid.sessionDates;
  const from = observed[0];
  const to = gridDates.at(-1);
  if (from > to) {
    return Object.freeze({
      reconciled: false,
      reasonCode: "no_overlap_with_session_grid",
      from,
      to,
      expectedSessionCount: 0,
      observedSessionCount: 0,
      missingFromCalendar: Object.freeze([]),
      absentFromMarket: Object.freeze([]),
    });
  }
  const expected = gridDates.filter((date) => date >= from && date <= to);
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const inWindow = observed.filter((date) => date >= from && date <= to);
  const missingFromCalendar = inWindow.filter((date) => !expectedSet.has(date));
  const absentFromMarket = expected.filter((date) => !observedSet.has(date));
  const reconciled = !missingFromCalendar.length && !absentFromMarket.length;

  return Object.freeze({
    reconciled,
    reasonCode: reconciled ? null : "session_grid_disagrees_with_market",
    from,
    to,
    expectedSessionCount: expected.length,
    observedSessionCount: inWindow.length,
    missingFromCalendar: Object.freeze(missingFromCalendar),
    absentFromMarket: Object.freeze(absentFromMarket),
  });
}
