import { MarketDataError } from "../../errors/MarketDataError.js";
import {
  ASSET_CLASSES,
  CANONICAL_INSTRUMENT_ID_PATTERN,
  DATA_QUALITIES,
  ERROR_CODES,
  INSTRUMENT_STATUSES,
  MARKET_STATES,
  METRIC_PERIODS,
  METRIC_QUALITIES,
  METRIC_SOURCES,
  METRIC_UNITS,
  PROVIDER_SOURCES,
} from "./constants.js";
import {
  NEWS_CLOCK_SKEW_MS,
  NEWS_BATCH_MAX_LIMIT,
  NEWS_FEED_QUALITIES,
  NEWS_FEED_SOURCES,
  NEWS_PROVIDER_LIMIT,
  NEWS_PROVIDERS,
} from "./news.js";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isNullableFiniteNumber = (value) => value === null || isFiniteNumber(value);

export function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function issue(path, message) {
  return { path, message };
}

function requireObject(value, path, issues) {
  if (isObject(value)) return true;
  issues.push(issue(path, "must be an object"));
  return false;
}

function requireString(value, key, path, issues) {
  if (!isNonEmptyString(value[key])) issues.push(issue(`${path}.${key}`, "must be a non-empty string"));
}

function optionalString(value, key, path, issues) {
  if (hasOwn(value, key) && value[key] !== undefined && !isNonEmptyString(value[key])) {
    issues.push(issue(`${path}.${key}`, "must be a non-empty string when provided"));
  }
}

function requireEnum(value, key, allowed, path, issues) {
  if (!allowed.includes(value[key])) {
    issues.push(issue(`${path}.${key}`, `must be one of: ${allowed.join(", ")}`));
  }
}

function requireNullableNumber(value, key, path, issues, { nonNegative = false } = {}) {
  const candidate = value[key];
  if (!hasOwn(value, key) || !isNullableFiniteNumber(candidate)) {
    issues.push(issue(`${path}.${key}`, "must be a finite number or null"));
  } else if (nonNegative && candidate !== null && candidate < 0) {
    issues.push(issue(`${path}.${key}`, "must be non-negative or null"));
  }
}

function requireTimestamp(value, key, path, issues) {
  if (!isIsoTimestamp(value[key])) issues.push(issue(`${path}.${key}`, "must be an ISO-8601 timestamp"));
}

function throwIfInvalid(contract, issues, code) {
  if (!issues.length) return;
  throw new MarketDataError(code, `${contract} failed runtime validation`, {
    details: { contract, issues },
  });
}

function clockMilliseconds(value = Date.now) {
  let candidate;
  if (typeof value === "function") candidate = value();
  else if (value && typeof value.now === "function") candidate = value.now();
  else candidate = value;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
}

function validateNewsText(value, key, path, issues) {
  const candidate = value[key];
  requireString(value, key, path, issues);
  if (!isNonEmptyString(candidate)) return;
  if (candidate !== candidate.trim() || /\s{2,}/u.test(candidate) || /[\r\n\t]/u.test(candidate)) {
    issues.push(issue(`${path}.${key}`, "must have normalized whitespace"));
  }
  if (/<\/?[A-Za-z][^>]*>/u.test(candidate)) {
    issues.push(issue(`${path}.${key}`, "must contain plain text, not markup"));
  }
}

function validateCanonicalInstrumentIds(values, path, issues) {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(issue(path, "must be a non-empty array"));
    return;
  }
  const seen = new Set();
  values.forEach((instrumentId, index) => {
    if (!isNonEmptyString(instrumentId) || !CANONICAL_INSTRUMENT_ID_PATTERN.test(instrumentId)) {
      issues.push(issue(`${path}[${index}]`, "must be a canonical instrument ID"));
      return;
    }
    if (seen.has(instrumentId)) issues.push(issue(`${path}[${index}]`, "must be unique"));
    seen.add(instrumentId);
  });
}

function validateNewsTimestamp(value, key, path, issues, options) {
  requireTimestamp(value, key, path, issues);
  if (!isIsoTimestamp(value[key])) return;
  if (!value[key].endsWith("Z")) {
    issues.push(issue(`${path}.${key}`, "must be expressed in UTC"));
  }
  const now = clockMilliseconds(options.now ?? options.clock ?? Date.now);
  const tolerance = Number.isFinite(options.futureToleranceMs)
    ? Math.max(0, options.futureToleranceMs)
    : NEWS_CLOCK_SKEW_MS;
  if (Date.parse(value[key]) > now + tolerance) {
    issues.push(issue(`${path}.${key}`, "must not be in the future"));
  }
}

export function validateNewsArticle(value, options = {}) {
  const path = options.path || "article";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireString(value, "id", path, issues);
    validateNewsText(value, "title", path, issues);
    validateNewsText(value, "publisher", path, issues);
    requireString(value, "url", path, issues);
    if (isNonEmptyString(value.url)) {
      try {
        const url = new URL(value.url);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
          issues.push(issue(`${path}.url`, "must be an absolute HTTPS URL"));
        }
      } catch {
        issues.push(issue(`${path}.url`, "must be an absolute HTTPS URL"));
      }
    }
    validateNewsTimestamp(value, "publishedAt", path, issues, options);
    validateCanonicalInstrumentIds(value.instrumentIds, `${path}.instrumentIds`, issues);
    requireEnum(value, "provider", NEWS_PROVIDERS, path, issues);
    if (isNonEmptyString(value.id) && NEWS_PROVIDERS.includes(value.provider)
      && !value.id.startsWith(`${value.provider}:`)) {
      issues.push(issue(`${path}.id`, "must be namespaced by provider"));
    }
    for (const forbidden of ["body", "html", "image", "summary", "thumbnail"]) {
      if (hasOwn(value, forbidden)) {
        issues.push(issue(`${path}.${forbidden}`, "is not part of the public news contract"));
      }
    }
  }
  throwIfInvalid("NewsArticle", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateNewsFeed(value, options = {}) {
  const path = options.path || "news";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireString(value, "instrumentId", path, issues);
    if (isNonEmptyString(value.instrumentId) && !CANONICAL_INSTRUMENT_ID_PATTERN.test(value.instrumentId)) {
      issues.push(issue(`${path}.instrumentId`, "must be a canonical instrument ID"));
    }
    if (!Array.isArray(value.articles)) {
      issues.push(issue(`${path}.articles`, "must be an array"));
    } else {
      if (value.articles.length > NEWS_PROVIDER_LIMIT) {
        issues.push(issue(`${path}.articles`, `must contain at most ${NEWS_PROVIDER_LIMIT} articles`));
      }
      let previousTime = Infinity;
      let previousId = "";
      const seenIds = new Set();
      const seenUrls = new Set();
      value.articles.forEach((article, index) => {
        try {
          validateNewsArticle(article, { ...options, path: `${path}.articles[${index}]` });
        } catch (error) {
          issues.push(...(error.details?.issues || [issue(`${path}.articles[${index}]`, error.message)]));
          return;
        }
        if (!article.instrumentIds.includes(value.instrumentId)) {
          issues.push(issue(`${path}.articles[${index}].instrumentIds`, "must include the feed instrument ID"));
        }
        const published = Date.parse(article.publishedAt);
        if (published > previousTime || (published === previousTime && article.id < previousId)) {
          issues.push(issue(`${path}.articles[${index}].publishedAt`, "must be sorted newest first with a stable ID tie-breaker"));
        }
        if (seenIds.has(article.id)) {
          issues.push(issue(`${path}.articles[${index}].id`, "must be unique within the feed"));
        }
        try {
          const normalizedUrl = new URL(article.url);
          normalizedUrl.hash = "";
          if (seenUrls.has(normalizedUrl.href)) {
            issues.push(issue(`${path}.articles[${index}].url`, "must be unique within the feed"));
          }
          seenUrls.add(normalizedUrl.href);
        } catch {}
        previousTime = published;
        previousId = article.id;
        seenIds.add(article.id);
      });
    }
    requireEnum(value, "source", NEWS_FEED_SOURCES, path, issues);
    requireEnum(value, "quality", NEWS_FEED_QUALITIES, path, issues);
    validateNewsTimestamp(value, "asOf", path, issues, options);
    validateNewsTimestamp(value, "fetchedAt", path, issues, options);
    if (Array.isArray(value.articles) && isIsoTimestamp(value.asOf) && isIsoTimestamp(value.fetchedAt)) {
      const expectedAsOf = value.articles.length ? value.articles[0]?.publishedAt : value.fetchedAt;
      if (value.asOf !== expectedAsOf) {
        issues.push(issue(`${path}.asOf`, "must match the newest article, or fetchedAt for an empty feed"));
      }
    }
    if (value.source === "last-known-good") {
      if (!NEWS_PROVIDERS.includes(value.originalSource)) {
        issues.push(issue(`${path}.originalSource`, `must be one of: ${NEWS_PROVIDERS.join(", ")}`));
      }
      if (value.quality !== "stale") {
        issues.push(issue(`${path}.quality`, "must be stale for last-known-good data"));
      }
    } else {
      if (value.quality !== "fresh") {
        issues.push(issue(`${path}.quality`, "must be fresh for a provider result"));
      }
      if (hasOwn(value, "originalSource") && value.originalSource !== undefined) {
        issues.push(issue(`${path}.originalSource`, "is only valid for last-known-good data"));
      }
    }
    const expectedProvider = value.source === "last-known-good" ? value.originalSource : value.source;
    if (NEWS_PROVIDERS.includes(expectedProvider) && Array.isArray(value.articles)) {
      value.articles.forEach((article, index) => {
        if (article?.provider !== expectedProvider) {
          issues.push(issue(`${path}.articles[${index}].provider`, "must match the feed's effective provider"));
        }
      });
    }
  }
  throwIfInvalid("NewsFeed", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateNewsBatchResponse(value, options = {}) {
  const path = options.path || "newsBatch";
  const issues = [];
  if (requireObject(value, path, issues)) {
    const data = value.data ?? value;
    if (!isObject(data) || !Array.isArray(data.articles)) {
      issues.push(issue(`${path}.data.articles`, "must be an array"));
    } else {
      if (data.articles.length > NEWS_BATCH_MAX_LIMIT) {
        issues.push(issue(`${path}.data.articles`, `must contain at most ${NEWS_BATCH_MAX_LIMIT} articles`));
      }
      const ids = new Set();
      const urls = new Set();
      data.articles.forEach((article, index) => {
        try {
          validateNewsArticle(article, { ...options, path: `${path}.data.articles[${index}]` });
        } catch (error) {
          issues.push(...(error.details?.issues || [issue(`${path}.data.articles[${index}]`, error.message)]));
          return;
        }
        if (ids.has(article.id)) issues.push(issue(`${path}.data.articles[${index}].id`, "must be unique"));
        try {
          const normalized = new URL(article.url);
          normalized.hash = "";
          const key = normalized.href;
          if (urls.has(key)) issues.push(issue(`${path}.data.articles[${index}].url`, "must be unique"));
          urls.add(key);
        } catch {}
        ids.add(article.id);
      });
    }
    if (hasOwn(value, "errors") && !Array.isArray(value.errors)) {
      issues.push(issue(`${path}.errors`, "must be an array when provided"));
    } else if (Array.isArray(value.errors)) {
      value.errors.forEach((error, index) => {
        const errorPath = `${path}.errors[${index}]`;
        if (!isObject(error)) {
          issues.push(issue(errorPath, "must be an object"));
          return;
        }
        if (!isNonEmptyString(error.instrumentId) || !CANONICAL_INSTRUMENT_ID_PATTERN.test(error.instrumentId)) {
          issues.push(issue(`${errorPath}.instrumentId`, "must be a canonical instrument ID"));
        }
        if (!Object.values(ERROR_CODES).includes(error.code)) {
          issues.push(issue(`${errorPath}.code`, "must be a known market data error code"));
        }
        if (!isNonEmptyString(error.message)) {
          issues.push(issue(`${errorPath}.message`, "must be a non-empty string"));
        }
        if (typeof error.retryable !== "boolean") {
          issues.push(issue(`${errorPath}.retryable`, "must be a boolean"));
        }
      });
    }
    if (value.sources !== undefined) {
      const sources = value.sources?.news;
      if (!Array.isArray(sources) || sources.some((source) => !NEWS_FEED_SOURCES.includes(source))
        || new Set(sources).size !== sources.length) {
        issues.push(issue(`${path}.sources.news`, "must contain unique known news sources"));
      }
    }
    const nextRefreshAt = value.nextRefreshAt ?? value.meta?.nextRefreshAt;
    if (nextRefreshAt !== undefined && nextRefreshAt !== null && !isIsoTimestamp(nextRefreshAt)) {
      issues.push(issue(`${path}.nextRefreshAt`, "must be an ISO-8601 timestamp"));
    }
    const lastUpdatedAt = hasOwn(value, "lastUpdatedAt")
      ? value.lastUpdatedAt
      : value.meta?.lastUpdatedAt;
    if (lastUpdatedAt !== undefined && lastUpdatedAt !== null && !isIsoTimestamp(lastUpdatedAt)) {
      issues.push(issue(`${path}.lastUpdatedAt`, "must be an ISO-8601 timestamp or null"));
    }
  }
  throwIfInvalid("NewsBatchResponse", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateInstrument(value, options = {}) {
  const path = options.path || "instrument";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireString(value, "id", path, issues);
    requireString(value, "symbol", path, issues);
    requireString(value, "name", path, issues);
    requireEnum(value, "assetClass", ASSET_CLASSES, path, issues);
    requireEnum(value, "status", INSTRUMENT_STATUSES, path, issues);
    for (const key of ["exchange", "mic", "currency", "country", "category", "sector"]) {
      optionalString(value, key, path, issues);
    }
  }
  throwIfInvalid("Instrument", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateQuoteSnapshot(value, options = {}) {
  const path = options.path || "quote";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireString(value, "instrumentId", path, issues);
    for (const key of ["price", "change", "changePercent", "open", "previousClose", "dayHigh", "dayLow", "bid", "ask"]) {
      requireNullableNumber(value, key, path, issues);
    }
    requireNullableNumber(value, "volume", path, issues, { nonNegative: true });
    requireNullableNumber(value, "averageVolume3m", path, issues, { nonNegative: true });
    requireEnum(value, "marketState", MARKET_STATES, path, issues);
    requireTimestamp(value, "asOf", path, issues);
    requireTimestamp(value, "fetchedAt", path, issues);
    if (!(value.currency === null || isNonEmptyString(value.currency))) {
      issues.push(issue(`${path}.currency`, "must be a non-empty string or null"));
    }
    requireEnum(value, "quality", DATA_QUALITIES, path, issues);
    requireEnum(value, "source", PROVIDER_SOURCES, path, issues);
    if (isFiniteNumber(value.dayHigh) && isFiniteNumber(value.dayLow) && value.dayHigh < value.dayLow) {
      issues.push(issue(`${path}.dayHigh`, "must be greater than or equal to dayLow"));
    }
  }
  throwIfInvalid("QuoteSnapshot", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateMetric(value, options = {}) {
  const path = options.path || "metric";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireString(value, "id", path, issues);
    if (!(value.value === null || isFiniteNumber(value.value) || typeof value.value === "string")) {
      issues.push(issue(`${path}.value`, "must be a finite number, string, or null"));
    }
    requireEnum(value, "unit", METRIC_UNITS, path, issues);
    requireEnum(value, "source", METRIC_SOURCES, path, issues);
    requireEnum(value, "quality", METRIC_QUALITIES, path, issues);
    if (hasOwn(value, "period") && value.period !== undefined && !METRIC_PERIODS.includes(value.period)) {
      issues.push(issue(`${path}.period`, `must be one of: ${METRIC_PERIODS.join(", ")}`));
    }
    if (hasOwn(value, "asOf") && value.asOf !== undefined && !isIsoTimestamp(value.asOf)) {
      issues.push(issue(`${path}.asOf`, "must be an ISO-8601 timestamp when provided"));
    }
    optionalString(value, "formulaVersion", path, issues);
  }
  throwIfInvalid("Metric", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

export function validateBar(value, options = {}) {
  const path = options.path || "bar";
  const issues = [];
  if (requireObject(value, path, issues)) {
    requireTimestamp(value, "timestamp", path, issues);
    for (const key of ["open", "high", "low", "close"]) {
      if (!isFiniteNumber(value[key])) issues.push(issue(`${path}.${key}`, "must be a finite number"));
    }
    requireNullableNumber(value, "volume", path, issues, { nonNegative: true });
    if (hasOwn(value, "adjustedClose") && value.adjustedClose !== null && !isFiniteNumber(value.adjustedClose)) {
      issues.push(issue(`${path}.adjustedClose`, "must be a finite number or null when provided"));
    }
    if (hasOwn(value, "source") && value.source !== undefined && !PROVIDER_SOURCES.includes(value.source)) {
      issues.push(issue(`${path}.source`, `must be one of: ${PROVIDER_SOURCES.join(", ")}`));
    }
    if (hasOwn(value, "quality") && value.quality !== undefined && !DATA_QUALITIES.includes(value.quality)) {
      issues.push(issue(`${path}.quality`, `must be one of: ${DATA_QUALITIES.join(", ")}`));
    }

    if ([value.open, value.high, value.low, value.close].every(isFiniteNumber)) {
      const upper = Math.max(value.open, value.low, value.close);
      const lower = Math.min(value.open, value.high, value.close);
      if (value.high < upper) issues.push(issue(`${path}.high`, "must be at least open, low, and close"));
      if (value.low > lower) issues.push(issue(`${path}.low`, "must be at most open, high, and close"));
    }
  }
  throwIfInvalid("Bar", issues, options.code || ERROR_CODES.SCHEMA_INVALID);
  return value;
}

function predicate(validator, value) {
  try {
    validator(value);
    return true;
  } catch {
    return false;
  }
}

export const isInstrument = (value) => predicate(validateInstrument, value);
export const isQuoteSnapshot = (value) => predicate(validateQuoteSnapshot, value);
export const isMetric = (value) => predicate(validateMetric, value);
export const isBar = (value) => predicate(validateBar, value);
export const isNewsArticle = (value) => predicate(validateNewsArticle, value);
export const isNewsFeed = (value) => predicate(validateNewsFeed, value);
export const isNewsBatchResponse = (value) => predicate(validateNewsBatchResponse, value);
export const validateNewsAggregateResponse = validateNewsBatchResponse;
export const isNewsAggregateResponse = isNewsBatchResponse;

export function validateBars(values, options = {}) {
  if (!Array.isArray(values)) {
    throw new MarketDataError(options.code || ERROR_CODES.SCHEMA_INVALID, "Bar list failed runtime validation", {
      details: { contract: "Bar[]", issues: [issue(options.path || "bars", "must be an array")] },
    });
  }

  let previousTime = -Infinity;
  const seen = new Set();
  values.forEach((bar, index) => {
    validateBar(bar, { ...options, path: `${options.path || "bars"}[${index}]` });
    const timestamp = Date.parse(bar.timestamp);
    if (timestamp <= previousTime || seen.has(timestamp)) {
      throw new MarketDataError(options.code || ERROR_CODES.SCHEMA_INVALID, "Bar list failed runtime validation", {
        details: {
          contract: "Bar[]",
          issues: [issue(`${options.path || "bars"}[${index}].timestamp`, "must be unique and strictly ascending")],
        },
      });
    }
    seen.add(timestamp);
    previousTime = timestamp;
  });
  return values;
}
