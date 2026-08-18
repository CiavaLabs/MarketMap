import { ERROR_CODES } from "../../contracts/core/constants.js";
import {
  NEWS_PROVIDER_LIMIT,
  isNewsTimestampInWindow,
  normalizeNewsText,
} from "../../contracts/core/news.js";
import {
  validateNewsArticle,
  validateNewsFeed,
} from "../../contracts/core/validators.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import { deduplicateNewsArticles, normalizeNewsUrl } from "../../metrics/news.js";

function unwrap(value) {
  if (value && typeof value === "object" && "raw" in value) return value.raw;
  return value;
}

export function finiteOrNull(value, { nonNegative = false } = {}) {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const candidate = Number(raw);
  if (!Number.isFinite(candidate) || (nonNegative && candidate < 0)) return null;
  return candidate;
}

export function clockTimestamp(clock = Date.now) {
  let value;
  if (typeof clock === "function") value = clock();
  else if (clock && typeof clock.now === "function") value = clock.now();
  else value = Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Provider clock must return a valid date or epoch value");
  }
  return date.toISOString();
}

export function toIsoTimestamp(value, fallback = null) {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "") return fallback;
  let date;
  if (raw instanceof Date) date = raw;
  else if (typeof raw === "number") date = new Date(raw < 1e12 ? raw * 1000 : raw);
  else date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function yahooNewsSchemaError(message, instrumentId, details = null) {
  return new MarketDataError(ERROR_CODES.SCHEMA_INVALID, message, {
    provider: "yahoo",
    capability: "news",
    instrumentId,
    details,
  });
}

function relatedInstrumentIds(raw, instrument, resolveProviderSymbol) {
  const ids = new Set([instrument.id]);
  if (typeof resolveProviderSymbol === "function") {
    for (const ticker of Array.isArray(raw.relatedTickers) ? raw.relatedTickers : []) {
      const symbol = normalizeNewsText(ticker);
      if (!symbol) continue;
      ids.add(resolveProviderSymbol(symbol));
    }
  }
  ids.delete(undefined);
  ids.delete(null);
  return [...ids].sort();
}

export function normalizeYahooNewsArticle(raw, {
  instrument,
  resolveProviderSymbol,
  clock = Date.now,
} = {}) {
  if (!raw || typeof raw !== "object" || !instrument?.id) return null;
  const providerId = normalizeNewsText(raw.uuid);
  const title = normalizeNewsText(raw.title);
  const publisher = normalizeNewsText(raw.publisher);
  const url = normalizeNewsUrl(raw.link);
  const publishedAt = toIsoTimestamp(raw.providerPublishTime);
  if (!providerId || !title || !publisher || !url || !publishedAt) return null;
  if (!isNewsTimestampInWindow(publishedAt, { now: clock })) return null;

  const article = {
    id: `yahoo:${providerId}`,
    title,
    publisher,
    url,
    publishedAt,
    instrumentIds: relatedInstrumentIds(raw, instrument, resolveProviderSymbol),
    provider: "yahoo",
  };
  try {
    validateNewsArticle(article, { clock });
    return article;
  } catch {
    return null;
  }
}

export function normalizeYahooNews(payload, {
  instrument,
  resolveProviderSymbol,
  clock = Date.now,
} = {}) {
  if (!instrument?.id) {
    throw yahooNewsSchemaError("A canonical instrument is required to normalize Yahoo news", null);
  }
  const rows = Array.isArray(payload) ? payload : payload?.news;
  if (!Array.isArray(rows)) {
    throw yahooNewsSchemaError("Yahoo returned an invalid news payload", instrument.id);
  }
  const fetchedAt = clockTimestamp(clock);
  const articles = deduplicateNewsArticles(rows
    .map((row) => normalizeYahooNewsArticle(row, { instrument, resolveProviderSymbol, clock }))
    .filter(Boolean))
    .slice(0, NEWS_PROVIDER_LIMIT);
  const feed = {
    instrumentId: instrument.id,
    articles,
    source: "yahoo",
    quality: "fresh",
    asOf: articles[0]?.publishedAt || fetchedAt,
    fetchedAt,
  };
  try {
    validateNewsFeed(feed, { clock });
    return feed;
  } catch (error) {
    throw yahooNewsSchemaError(`Yahoo news failed validation for ${instrument.id}`, instrument.id, error.details);
  }
}
