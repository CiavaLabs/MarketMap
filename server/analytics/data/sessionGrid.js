import { isSessionDate, isValidTimeZone } from "./sessionDate.js";

const CALENDAR_ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/u;

const NORMALIZED_GRIDS = new WeakSet();

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateSessionGrid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sessionGrid must be an object");
  }
  if (NORMALIZED_GRIDS.has(value)) return value;
  const calendarId = requireNonEmptyString(
    value.calendarId,
    "sessionGrid.calendarId",
  );
  if (!CALENDAR_ID_PATTERN.test(calendarId)) {
    throw new TypeError("sessionGrid.calendarId has an invalid format");
  }
  const source = requireNonEmptyString(value.source, "sessionGrid.source");
  const revision = requireNonEmptyString(value.revision, "sessionGrid.revision");
  const timeZone = requireNonEmptyString(
    value.timeZone,
    "sessionGrid.timeZone",
  );
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError("sessionGrid.timeZone must be a valid IANA timezone");
  }
  if (!Array.isArray(value.sessionDates) || value.sessionDates.length < 2) {
    throw new TypeError("sessionGrid.sessionDates must contain at least two dates");
  }

  let previous = null;
  const sessionDates = value.sessionDates.map((sessionDate, index) => {
    if (!isSessionDate(sessionDate)) {
      throw new TypeError(
        `sessionGrid.sessionDates[${index}] must be a valid session date`,
      );
    }
    if (previous !== null && sessionDate <= previous) {
      throw new TypeError(
        "sessionGrid.sessionDates must be unique and strictly ascending",
      );
    }
    previous = sessionDate;
    return sessionDate;
  });

  const normalized = Object.freeze({
    calendarId,
    source,
    revision,
    timeZone,
    sessionDates: Object.freeze(sessionDates),
  });
  NORMALIZED_GRIDS.add(normalized);
  return normalized;
}

export function sessionGridSummary(value) {
  const grid = validateSessionGrid(value);
  return {
    calendarId: grid.calendarId,
    source: grid.source,
    revision: grid.revision,
    timeZone: grid.timeZone,
    startSessionDate: grid.sessionDates[0],
    endSessionDate: grid.sessionDates.at(-1),
    sessionCount: grid.sessionDates.length,
  };
}
