import { SESSION_DATE_PATTERN } from "../contracts/constants.js";

const SESSION_DATE_FORMATTERS = new Map();

function formatterFor(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) return null;
  if (SESSION_DATE_FORMATTERS.has(timeZone)) {
    return SESSION_DATE_FORMATTERS.get(timeZone);
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    SESSION_DATE_FORMATTERS.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function calendarDateParts(value) {
  if (typeof value !== "string" || !SESSION_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function isSessionDate(value) {
  return calendarDateParts(value) !== null;
}

export function isValidTimeZone(value) {
  return formatterFor(value) !== null;
}

export function sessionDateFromTimestamp(timestamp, timeZone) {
  const date = timestamp instanceof Date ? new Date(timestamp) : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("timestamp must be a valid instant");
  }
  const formatter = formatterFor(timeZone);
  if (!formatter) {
    throw new TypeError("timeZone must be a valid IANA timezone");
  }

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts
    .filter(({ type }) => ["year", "month", "day"].includes(type))
    .map(({ type, value }) => [type, value]));
  const sessionDate = `${values.year}-${values.month}-${values.day}`;
  if (!isSessionDate(sessionDate)) {
    throw new TypeError("timestamp could not be mapped to a valid session date");
  }
  return sessionDate;
}
