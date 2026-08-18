export const HISTORY_DEFAULT_INTERVALS = Object.freeze({
  "1d": "5m",
  "5d": "15m",
  "1m": "1d",
  "6m": "1d",
  "1y": "1d",
  "5y": "1wk",
});

export const HISTORY_ALLOWLIST = Object.freeze({
  "1d": Object.freeze(["1m", "5m", "15m"]),
  "5d": Object.freeze(["5m", "15m", "30m", "1h"]),
  "1m": Object.freeze(["1h", "1d"]),
  "6m": Object.freeze(["1d"]),
  "1y": Object.freeze(["1d", "1wk"]),
  "5y": Object.freeze(["1d", "1wk", "1mo"]),
});

export function isHistoryRangeIntervalSupported(range, interval) {
  return Boolean(HISTORY_ALLOWLIST[range]?.includes(interval));
}

function shiftUtcMonths(date, months) {
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
}

export function historyStartDate(range, endValue) {
  const end = endValue instanceof Date ? new Date(endValue) : new Date(endValue);
  if (!Number.isFinite(end.getTime()) || !HISTORY_ALLOWLIST[range]) return null;

  const start = new Date(end);
  switch (range) {
    case "1d": start.setUTCDate(start.getUTCDate() - 1); break;
    case "5d": start.setUTCDate(start.getUTCDate() - 5); break;
    case "1m": shiftUtcMonths(start, -1); break;
    case "6m": shiftUtcMonths(start, -6); break;
    case "1y": shiftUtcMonths(start, -12); break;
    case "5y": shiftUtcMonths(start, -60); break;
    default: return null;
  }
  return start;
}
