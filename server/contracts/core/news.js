export const NEWS_WINDOW_DAYS = 7;
export const NEWS_WINDOW_MS = NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
export const NEWS_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const NEWS_PROVIDER_LIMIT = 8;
export const NEWS_INSTRUMENT_DEFAULT_LIMIT = 6;
export const NEWS_BOARD_DEFAULT_LIMIT = 12;
export const NEWS_BATCH_MAX_LIMIT = 20;
export const NEWS_BATCH_CONCURRENCY = 5;
export const NEWS_STALE_RECHECK_MS = 60 * 1_000;
export const NEWS_PERSISTENCE_READ_TIMEOUT_MS = 100;
export const NEWS_SINGLE_FETCH_BUDGET_MS = 5_700;
export const NEWS_BATCH_BUDGET_MS = 25_000;

export const NEWS_PROVIDERS = Object.freeze(["yahoo", "finnhub"]);
export const NEWS_FEED_SOURCES = Object.freeze([
  ...NEWS_PROVIDERS,
  "last-known-good",
]);
export const NEWS_FEED_QUALITIES = Object.freeze(["fresh", "stale"]);

const HTML_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
});

function decodeEntity(match, body) {
  if (body.startsWith("#")) {
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const digits = body.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {}
    }
    return " ";
  }
  return HTML_ENTITIES[body.toLowerCase()] ?? " ";
}

export function normalizeNewsText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, decodeEntity)
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || null;
}

export function newsClockDate(clock = Date.now) {
  let value;
  if (typeof clock === "function") value = clock();
  else if (clock && typeof clock.now === "function") value = clock.now();
  else value = clock;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Provider clock must return a valid date");
  return date;
}

export function isNewsTimestampInWindow(value, {
  now = Date.now,
  windowMs = NEWS_WINDOW_MS,
  futureToleranceMs = NEWS_CLOCK_SKEW_MS,
} = {}) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const current = newsClockDate(now).getTime();
  return timestamp >= current - windowMs && timestamp <= current + futureToleranceMs;
}
