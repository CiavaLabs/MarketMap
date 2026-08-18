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
import { validateQuoteSnapshot } from "../../contracts/market/quote.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import { deduplicateNewsArticles, normalizeNewsUrl } from "../../metrics/news.js";

const FINNHUB_SYMBOL_PATTERN = /^[A-Z0-9._:-]{1,80}$/i;

function numberOrNull(value, { nonNegative = false } = {}) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const candidate = Number(value);
  if (!Number.isFinite(candidate) || (nonNegative && candidate < 0)) return null;
  return candidate;
}

function positiveNumberOrNull(value) {
  const candidate = numberOrNull(value, { nonNegative: true });
  return candidate !== null && candidate > 0 ? candidate : null;
}

function provenanceLabel(value, fallback) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : fallback;
}

function clockIso(clock = Date.now) {
  let value;
  if (typeof clock === "function") value = clock();
  else if (clock && typeof clock.now === "function") value = clock.now();
  else value = Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Provider clock must return a valid date");
  return date.toISOString();
}

function timestamp(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function schemaError(message, instrumentId, capability, details = null) {
  return new MarketDataError(ERROR_CODES.SCHEMA_INVALID, message, {
    provider: "finnhub",
    capability,
    instrumentId,
    details,
  });
}

export function normalizeFinnhubQuote(raw, {
  descriptor,
  clock = Date.now,
  fallbackFrom = "yahoo",
  fallbackReason = "upstream_unavailable",
  semanticMatch = "raw_quote",
} = {}) {
  const id = descriptor?.id;
  const mapping = descriptor?.providerSymbols?.finnhub;
  const providerSymbol = `${mapping?.symbol || ""}`.trim();
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !id
    || !FINNHUB_SYMBOL_PATTERN.test(providerSymbol)) {
    throw schemaError("Finnhub returned an invalid quote payload", id || null, "quote");
  }
  const fetchedAt = clockIso(clock);
  const value = numberOrNull(raw.c);
  const providerTimestamp = positiveNumberOrNull(raw.t);
  if (value === null || value < 0) {
    throw schemaError("Finnhub returned an invalid quote value", id, "quote");
  }
  if (value === 0) {
    throw new MarketDataError(ERROR_CODES.INSTRUMENT_NOT_FOUND, `Finnhub returned no quote for ${id}`, {
      provider: "finnhub",
      capability: "quote",
      instrumentId: id,
      retryable: false,
    });
  }
  const previousClose = positiveNumberOrNull(raw.pc);
  const dayHigh = positiveNumberOrNull(raw.h);
  const dayLow = positiveNumberOrNull(raw.l);
  if (dayHigh !== null && dayLow !== null && dayHigh < dayLow) {
    throw schemaError("Finnhub quote day high is below day low", id, "quote", { dayHigh, dayLow });
  }
  const computedChange = previousClose === null ? null : value - previousClose;
  const change = numberOrNull(raw.d) ?? computedChange;
  const changePercent = numberOrNull(raw.dp)
    ?? (previousClose && change !== null ? (change / previousClose) * 100 : null);
  const optional = {
    change,
    changePercent,
    open: positiveNumberOrNull(raw.o),
    previousClose,
    dayHigh,
    dayLow,
    bid: null,
    ask: null,
    volume: null,
    averageVolume3m: null,
  };
  const fieldAvailability = Object.fromEntries(Object.entries(optional).map(([field, valueAtField]) => {
    if (["bid", "ask", "volume", "averageVolume3m"].includes(field)) {
      return [field, { status: "unsupported", reason: "provider_does_not_expose" }];
    }
    return [field, valueAtField === null ? { status: "temporarily_unavailable" } : { status: "available" }];
  }));
  const quote = {
    instrumentId: id,
    assetClass: descriptor.assetClass,
    value,
    price: value,
    priceUnit: descriptor.priceUnit,
    currency: descriptor.currency || null,
    ...optional,
    session: {
      model: "exchange_hours",
      phase: "unknown",
      timezone: null,
      isTrading: null,
      regularStart: null,
      regularEnd: null,
    },
    fieldAvailability,
    quality: "fresh",
    dataQuality: {
      status: "usable_with_warnings",
      issues: [{ code: "fallback_provider_used", severity: "info", field: null }],
    },
    provenance: {
      source: "finnhub",
      providerSymbol,
      fallback: true,
      fallbackFrom: fallbackFrom === "yahoo" ? fallbackFrom : "yahoo",
      fallbackReason: provenanceLabel(fallbackReason, "upstream_unavailable"),
      semanticMatch: provenanceLabel(semanticMatch, "raw_quote"),
    },
    asOf: timestamp(providerTimestamp, fetchedAt),
    fetchedAt,
  };
  validateQuoteSnapshot(quote);
  return quote;
}

export function normalizeFinnhubNewsArticle(raw, {
  instrument,
  clock = Date.now,
} = {}) {
  if (!raw || typeof raw !== "object" || !instrument?.id) return null;
  const providerId = normalizeNewsText(raw.id);
  const title = normalizeNewsText(raw.headline);
  const publisher = normalizeNewsText(raw.source);
  const url = normalizeNewsUrl(raw.url);
  const publishedAt = timestamp(raw.datetime);
  if (!providerId || !title || !publisher || !url || !publishedAt) return null;
  if (!isNewsTimestampInWindow(publishedAt, { now: clock })) return null;

  const article = {
    id: `finnhub:${providerId}`,
    title,
    publisher,
    url,
    publishedAt,
    instrumentIds: [instrument.id],
    provider: "finnhub",
  };
  try {
    validateNewsArticle(article, { clock });
    return article;
  } catch {
    return null;
  }
}

export function normalizeFinnhubNews(payload, {
  instrument,
  clock = Date.now,
} = {}) {
  if (!instrument?.id) {
    throw schemaError("A canonical instrument is required for Finnhub news", null, "news");
  }
  if (!Array.isArray(payload)) {
    throw schemaError("Finnhub returned an invalid company-news payload", instrument.id, "news");
  }
  const fetchedAt = clockIso(clock);
  const articles = deduplicateNewsArticles(payload
    .map((row) => normalizeFinnhubNewsArticle(row, { instrument, clock }))
    .filter(Boolean))
    .slice(0, NEWS_PROVIDER_LIMIT);
  const feed = {
    instrumentId: instrument.id,
    articles,
    source: "finnhub",
    quality: "fresh",
    asOf: articles[0]?.publishedAt || fetchedAt,
    fetchedAt,
  };
  try {
    validateNewsFeed(feed, { clock });
    return feed;
  } catch (error) {
    throw schemaError(`Finnhub news failed validation for ${instrument.id}`, instrument.id, "news", error.details);
  }
}
