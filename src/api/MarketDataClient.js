import { CONFIG } from "../config.js";
import { BatchRequestPlanner } from "./BatchRequestPlanner.js";

const DEFAULT_API_BASE_URL = CONFIG.API.BASE_URL;
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_ETAG_CACHE_MAX_ENTRIES = 200;
const MAX_PLANNED_IDS = 1_000;
const MAX_ANALYTICS_IDS = 40;
const MAX_SEARCH_RESULTS = 20;
const MAX_NEWS_PER_INSTRUMENT = 8;
const MAX_NEWS_BATCH_RESULTS = 20;
const MAX_NEWS_BATCH_IDS = 40;
const CANONICAL_INSTRUMENT_ID = /^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function createAbortError(reason) {
  if (reason instanceof Error) return reason;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError("timeoutMs must be a non-negative finite number");
  }
  return timeout;
}

function normalizeCacheSize(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("maxEtagEntries must be a positive integer");
  }
  return value;
}

function normalizeApiBaseUrl(value, runtimeOrigin, {
  optionName = "apiBaseUrl",
  version = "v1",
  fallback = DEFAULT_API_BASE_URL,
} = {}) {
  const input = String(value || fallback).trim();
  if (!input) throw new TypeError(`${optionName} must be a non-empty string`);

  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith("//");
  let pathname;
  let normalized;

  if (isAbsolute) {
    if (!runtimeOrigin) {
      throw new TypeError(`An origin is required to verify an absolute ${optionName}`);
    }

    let resolved;
    let expectedOrigin;
    try {
      resolved = new URL(input, runtimeOrigin);
      expectedOrigin = new URL(runtimeOrigin).origin;
    } catch {
      throw new TypeError(`${optionName} must be a valid same-origin URL`);
    }

    if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== expectedOrigin) {
      throw new TypeError(`${optionName} must be same-origin`);
    }
    if (resolved.search || resolved.hash) {
      throw new TypeError(`${optionName} cannot include a query string or fragment`);
    }

    pathname = resolved.pathname.replace(/\/+$/, "");
    normalized = `${resolved.origin}${pathname}`;
  } else {
    const path = input.startsWith("/") ? input : `/${input}`;
    if (path.includes("?") || path.includes("#")) {
      throw new TypeError(`${optionName} cannot include a query string or fragment`);
    }
    pathname = path.replace(/\/+$/, "");
    normalized = pathname;
  }

  if (!pathname.endsWith(`/${version}`)) {
    throw new TypeError(`${optionName} must target a versioned /${version} API`);
  }
  return normalized;
}

function normalizeInstrumentId(value, label = "instrumentId") {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  const canonical = normalized.toUpperCase();
  return CANONICAL_INSTRUMENT_ID.test(canonical) ? canonical : normalized;
}

function normalizeNewsInstrumentId(value, label = "instrumentId") {
  return normalizeInstrumentId(value, label);
}

function normalizeBooleanOption(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function normalizeInstrumentIds(
  ids,
  label,
  maximum = MAX_PLANNED_IDS,
  normalizeId = normalizeInstrumentId,
  { deduplicate = false } = {},
) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TypeError(`${label} ids must be a non-empty array`);
  }
  if (ids.length > maximum) {
    throw new RangeError(`${label} accepts at most ${maximum} instrument ids`);
  }

  const normalized = ids.map((id, index) => normalizeId(id, `ids[${index}]`));
  if (!deduplicate && new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} ids must be unique`);
  }
  return deduplicate ? [...new Set(normalized)] : normalized;
}

const normalizeSnapshotIds = (ids) => normalizeInstrumentIds(
  ids,
  "snapshot",
  MAX_PLANNED_IDS,
  normalizeInstrumentId,
  { deduplicate: true },
);

function itemErrorFromChunk(reason, instrumentId, operation) {
  return {
    instrumentId,
    operation,
    code: reason?.code || "chunk_unavailable",
    reason: reason?.problem?.reason || reason?.code || "chunk_unavailable",
    message: reason?.message || `${operation} chunk is unavailable`,
    retryable: reason?.retryable !== false,
  };
}

function mergeBatchEnvelopes(ids, outcomes, operation) {
  const dataById = new Map();
  const errors = new Map();
  const sources = new Set();
  const refreshTimes = [];
  let meta = null;
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      for (const instrumentId of outcome.items) {
        errors.set(
          `${instrumentId}:${outcome.reason?.code || "chunk_unavailable"}`,
          itemErrorFromChunk(outcome.reason, instrumentId, operation),
        );
      }
      continue;
    }
    const envelope = outcome.value || {};
    meta ||= envelope.meta || null;
    for (const item of Array.isArray(envelope.data) ? envelope.data : []) {
      if (item?.instrumentId) dataById.set(item.instrumentId, item);
      if (item?.provenance?.source) sources.add(item.provenance.source);
    }
    for (const error of envelope.errors || []) {
      errors.set(`${error.instrumentId}:${error.code}`, error);
    }
    const next = Date.parse(envelope.meta?.nextRefreshAt);
    if (Number.isFinite(next)) refreshTimes.push(next);
  }
  return {
    data: ids.map((id) => dataById.get(id)).filter(Boolean),
    ...(errors.size ? { errors: [...errors.values()] } : {}),
    ...(sources.size ? { sources: { [operation]: [...sources] } } : {}),
    meta: {
      ...(meta || {}),
      nextRefreshAt: refreshTimes.length
        ? new Date(Math.min(...refreshTimes)).toISOString()
        : meta?.nextRefreshAt || null,
    },
  };
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeIntegerLimit(value, fallback, maximum, label) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return limit;
}

function validateNewsArticle(article, endpoint) {
  const invalid = () => new MarketDataClientError(`${endpoint} returned an invalid news article`, {
    code: "schema_invalid",
    retryable: false,
  });
  if (!isObject(article)) throw invalid();
  for (const key of ["id", "title", "publisher"]) {
    if (typeof article[key] !== "string" || !article[key].trim()) throw invalid();
  }
  let url;
  try {
    url = new URL(article.url);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !isIsoTimestamp(article.publishedAt)
  ) throw invalid();
  if (!Array.isArray(article.instrumentIds) || article.instrumentIds.length === 0) throw invalid();
  const ids = article.instrumentIds.map((id) => (
    typeof id === "string" ? id.trim() : ""
  ));
  if (
    ids.some((id) => !CANONICAL_INSTRUMENT_ID.test(id))
    || new Set(ids).size !== ids.length
  ) throw invalid();
  if (article.provider !== "yahoo" && article.provider !== "finnhub") throw invalid();
  if (!article.id.startsWith(`${article.provider}:`) || article.id === `${article.provider}:`) {
    throw invalid();
  }
  return article;
}

function validateNewsFeed(feed, endpoint) {
  const invalid = (message) => new MarketDataClientError(`${endpoint} ${message}`, {
    code: "schema_invalid",
    retryable: false,
  });
  if (
    !isObject(feed)
    || typeof feed.instrumentId !== "string"
    || !CANONICAL_INSTRUMENT_ID.test(feed.instrumentId)
  ) {
    throw invalid("returned an invalid news feed");
  }
  if (!Array.isArray(feed.articles) || feed.articles.length > MAX_NEWS_PER_INSTRUMENT) {
    throw invalid("response articles must be an array of at most 8 items");
  }
  feed.articles.forEach((article) => validateNewsArticle(article, endpoint));
  if (feed.articles.some((article) => !article.instrumentIds.includes(feed.instrumentId))) {
    throw invalid("returned an article for the wrong instrument");
  }
  if (!["yahoo", "finnhub", "last-known-good"].includes(feed.source)) {
    throw invalid("returned an invalid news source");
  }
  if (feed.quality !== "fresh" && feed.quality !== "stale") {
    throw invalid("returned an invalid news quality");
  }
  if (!isIsoTimestamp(feed.asOf) || !isIsoTimestamp(feed.fetchedAt)) {
    throw invalid("returned invalid news timestamps");
  }
  if (
    feed.source === "last-known-good"
    && feed.originalSource !== "yahoo"
    && feed.originalSource !== "finnhub"
  ) {
    throw invalid("returned an invalid original news source");
  }
  return feed;
}

function validateNewsEnvelope(envelope, endpoint, { batch = false, instrumentId = null } = {}) {
  validateMarketDataEnvelope(envelope, endpoint);
  if (batch) {
    if (
      !isObject(envelope.data)
      || !Array.isArray(envelope.data.articles)
      || envelope.data.articles.length > MAX_NEWS_BATCH_RESULTS
    ) {
      throw new MarketDataClientError(`${endpoint} response is missing news articles`, {
        code: "schema_invalid",
        retryable: false,
      });
    }
    envelope.data.articles.forEach((article) => validateNewsArticle(article, endpoint));
    const articleIds = new Set();
    const articleUrls = new Set();
    for (const article of envelope.data.articles) {
      const normalizedUrl = new URL(article.url);
      normalizedUrl.hash = "";
      if (articleIds.has(article.id) || articleUrls.has(normalizedUrl.href)) {
        throw new MarketDataClientError(`${endpoint} response contains duplicate news articles`, {
          code: "schema_invalid",
          retryable: false,
        });
      }
      articleIds.add(article.id);
      articleUrls.add(normalizedUrl.href);
    }
  } else {
    validateNewsFeed(envelope.data, endpoint);
    if (instrumentId && envelope.data.instrumentId !== instrumentId) {
      throw new MarketDataClientError(`${endpoint} returned news for the wrong instrument`, {
        code: "schema_invalid",
        retryable: false,
      });
    }
  }
  if (
    !isObject(envelope.sources)
    || !Array.isArray(envelope.sources.news)
    || envelope.sources.news.some((source) => !["yahoo", "finnhub", "last-known-good"].includes(source))
    || new Set(envelope.sources.news).size !== envelope.sources.news.length
  ) {
    throw new MarketDataClientError(`${endpoint} response has invalid news provenance`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (batch && (envelope.errors || []).some((error) => (
    !isObject(error)
    || typeof error.instrumentId !== "string"
    || !CANONICAL_INSTRUMENT_ID.test(error.instrumentId)
    || typeof error.code !== "string"
    || !error.code.trim()
    || typeof error.message !== "string"
    || !error.message.trim()
    || typeof error.retryable !== "boolean"
  ))) {
    throw new MarketDataClientError(`${endpoint} response has invalid per-instrument errors`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (
    batch
    && Array.isArray(envelope.errors)
    && new Set(envelope.errors.map(({ instrumentId: id }) => id)).size !== envelope.errors.length
  ) {
    throw new MarketDataClientError(`${endpoint} response repeats a per-instrument error`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  for (const value of [envelope.meta?.lastUpdatedAt, envelope.lastUpdatedAt]) {
    if (value != null && !isIsoTimestamp(value)) {
      throw new MarketDataClientError(`${endpoint} response has an invalid lastUpdatedAt`, {
        code: "schema_invalid",
        retryable: false,
      });
    }
  }
  return envelope;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateAnalyticsEnvelope(envelope, endpoint) {
  const invalid = (message) => new MarketDataClientError(`${endpoint} ${message}`, {
    code: "schema_invalid",
    retryable: false,
  });
  if (!Array.isArray(envelope.data) || envelope.data.length > MAX_ANALYTICS_IDS) {
    throw invalid("response data must be an array of at most 40 assessments");
  }
  const seen = new Set();
  for (const item of envelope.data) {
    if (
      !isObject(item)
      || typeof item.instrumentId !== "string"
      || !CANONICAL_INSTRUMENT_ID.test(item.instrumentId)
      || seen.has(item.instrumentId)
      || !SHA256_DIGEST.test(item.runId || "")
      || !isIsoTimestamp(item.computedAt)
      || !isObject(item.assessment)
    ) {
      throw invalid("returned an invalid analytics record");
    }
    seen.add(item.instrumentId);
    const assessment = item.assessment;
    if (
      assessment.schemaVersion !== 1
      || assessment.instrumentId !== item.instrumentId
      || !["available", "unavailable"].includes(assessment.status)
      || (assessment.sessionDate !== null && !SESSION_DATE.test(assessment.sessionDate || ""))
      || !isObject(assessment.quality)
    ) {
      throw invalid("returned an invalid movement assessment");
    }
    if (assessment.status === "available"
      && (!isObject(assessment.forecast) || !isObject(assessment.evidence))) {
      throw invalid("returned an available assessment without forecast and evidence");
    }
    if (assessment.status === "unavailable"
      && (assessment.forecast !== null || assessment.evidence !== null)) {
      throw invalid("returned an unavailable assessment carrying results");
    }
  }
  return envelope;
}

export function validateMarketDataEnvelope(value, endpoint = "market data", expected = null) {
  if (!isObject(value) || !hasOwn(value, "data")) {
    throw new MarketDataClientError(`${endpoint} returned an invalid response envelope`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (!isObject(value.meta)) {
    throw new MarketDataClientError(`${endpoint} response is missing envelope metadata`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (expected?.apiVersion && value.meta.apiVersion !== expected.apiVersion) {
    throw new MarketDataClientError(`${endpoint} returned the wrong API version`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (expected?.schemaVersion && value.meta.schemaVersion !== expected.schemaVersion) {
    throw new MarketDataClientError(`${endpoint} returned the wrong schema version`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (hasOwn(value, "errors") && !Array.isArray(value.errors)) {
    throw new MarketDataClientError(`${endpoint} response errors must be an array`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  if (value.meta.nextRefreshAt != null && !isIsoTimestamp(value.meta.nextRefreshAt)) {
    throw new MarketDataClientError(`${endpoint} returned an invalid nextRefreshAt`, {
      code: "schema_invalid",
      retryable: false,
    });
  }
  return value;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

export class MarketDataClientError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "MarketDataClientError";
    this.code = options.code || "market_data_request_failed";
    this.status = Number.isInteger(options.status) ? options.status : 0;
    this.retryable = options.retryable ?? this.status >= 500;
    this.type = options.type || null;
    this.title = options.title || null;
    this.requestId = options.requestId || null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.problem = options.problem || null;
    this.url = options.url || null;
  }

  static fromResponse(response, problem, url) {
    const body = isObject(problem) ? problem : {};
    const status = Number.isInteger(body.status) ? body.status : response.status;
    const message = body.detail || body.title || `Market data request failed with HTTP ${response.status}`;
    return new MarketDataClientError(message, {
      code: body.code || "http_error",
      status,
      retryable: body.retryable ?? status >= 500,
      type: body.type,
      title: body.title,
      requestId: body.requestId || response.headers.get("x-request-id"),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      problem: isObject(problem) ? problem : null,
      url,
    });
  }
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return { value: null, parseError: null };
  try {
    return { value: JSON.parse(text), parseError: null };
  } catch (parseError) {
    return { value: null, parseError };
  }
}

export class MarketDataClient {
  constructor(options = {}) {
    const runtimeOrigin = options.origin ?? globalThis.location?.origin ?? null;
    this.apiBaseUrl = normalizeApiBaseUrl(
      options.apiBaseUrl || DEFAULT_API_BASE_URL,
      runtimeOrigin,
    );
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("MarketDataClient requires a fetch implementation");
    }
    this.fetchImpl = (...args) => fetchImpl(...args);

    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.batchPlanner = options.batchPlanner || new BatchRequestPlanner({
      chunkSize: options.maxBatchIds ?? CONFIG.API.MAX_BATCH_IDS ?? 40,
      concurrency: options.batchConcurrency ?? 2,
    });
    this.etagCache = options.etagCache || new Map();
    this.maxEtagEntries = normalizeCacheSize(
      options.maxEtagEntries ?? DEFAULT_ETAG_CACHE_MAX_ENTRIES,
    );
    if (
      !this.etagCache
      || typeof this.etagCache.get !== "function"
      || typeof this.etagCache.set !== "function"
      || typeof this.etagCache.clear !== "function"
    ) {
      throw new TypeError("etagCache must implement get, set, and clear");
    }
  }

  snapshot(ids, options = {}) {
    const normalizedIds = normalizeSnapshotIds(ids);
    return this.batchPlanner.execute(
      normalizedIds,
      (chunk, context) => this.#request("/snapshot", {
        query: { ids: chunk.join(",") },
        signal: context.signal,
        timeoutMs: options.chunkTimeoutMs ?? options.timeoutMs,
      }),
      {
        signal: options.signal,
        chunkSize: options.maxBatchIds,
        timeoutMs: options.batchTimeoutMs ?? options.timeoutMs ?? this.timeoutMs,
      },
    ).then((outcomes) => mergeBatchEnvelopes(normalizedIds, outcomes, "quote"));
  }

  search(query, options = {}) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (normalizedQuery.length < 2 || normalizedQuery.length > 80) {
      throw new RangeError("search query must contain between 2 and 80 characters");
    }

    const params = { q: normalizedQuery };
    const assetClasses = options.assetClasses ?? options.assetClass;
    if (assetClasses != null) {
      const normalizedClasses = (Array.isArray(assetClasses) ? assetClasses : [assetClasses])
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (normalizedClasses.length) params.assetClass = normalizedClasses.join(",");
    }
    const venue = options.venue ?? options.mic ?? options.exchange;
    if (venue != null && String(venue).trim()) {
      params.venue = String(venue).trim();
    }
    if (options.currency != null && String(options.currency).trim()) {
      params.currency = String(options.currency).trim();
    }
    if (options.includeUnsupported != null) {
      if (typeof options.includeUnsupported !== "boolean") {
        throw new TypeError("includeUnsupported must be a boolean");
      }
      params.includeUnsupported = String(options.includeUnsupported);
    }
    if (options.limit != null) {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
        throw new RangeError(`search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
      }
      params.limit = String(limit);
    }

    return this.#request("/instruments/search", {
      query: params,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  instrument(instrumentId, options = {}) {
    const id = normalizeInstrumentId(instrumentId);
    const query = {};
    if (options.providerSymbol != null && String(options.providerSymbol).trim()) {
      query.providerSymbol = String(options.providerSymbol).trim();
    }
    return this.#request(`/instruments/${encodeURIComponent(id)}`, {
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  details(instrumentId, options = {}) {
    const id = normalizeInstrumentId(instrumentId);
    const sections = Array.isArray(options.sections)
      ? options.sections.map((value) => String(value).trim()).filter(Boolean)
      : [];
    return this.#request(`/instruments/${encodeURIComponent(id)}/details`, {
      query: sections.length ? { section: sections.join(",") } : null,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  history(instrumentId, options = {}) {
    const id = normalizeInstrumentId(instrumentId);
    const range = String(options.range || "1d").trim();
    const interval = String(options.interval || "5m").trim();
    if (!range || !interval) {
      throw new TypeError("history range and interval must be non-empty strings");
    }

    const priceBasis = String(options.priceBasis || "raw");
    const includePrePost = options.includePrePost == null
      ? undefined
      : normalizeBooleanOption(options.includePrePost, "includePrePost");
    return this.#request(`/instruments/${encodeURIComponent(id)}/history`, {
      query: {
        range,
        interval,
        priceBasis,
        ...(includePrePost !== undefined ? { includePrePost } : {}),
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  historyBatch(ids, options = {}) {
    const normalizedIds = normalizeSnapshotIds(ids);
    const range = String(options.range || "1d").trim();
    const interval = String(options.interval || "5m").trim();
    if (!range || !interval) {
      throw new TypeError("history range and interval must be non-empty strings");
    }

    const priceBasis = String(options.priceBasis || "raw");
    const includePrePost = options.includePrePost == null
      ? undefined
      : normalizeBooleanOption(options.includePrePost, "includePrePost");
    return this.batchPlanner.execute(
      normalizedIds,
      (chunk, context) => this.#request("/history", {
        query: {
          ids: chunk.join(","),
          range,
          interval,
          priceBasis,
          ...(includePrePost !== undefined ? { includePrePost } : {}),
        },
        signal: context.signal,
        timeoutMs: options.chunkTimeoutMs ?? options.timeoutMs ?? CONFIG.API.HISTORY_BATCH_TIMEOUT_MS,
      }),
      {
        signal: options.signal,
        chunkSize: options.maxBatchIds,
        timeoutMs: options.batchTimeoutMs
          ?? options.timeoutMs
          ?? CONFIG.API.HISTORY_BATCH_TIMEOUT_MS,
      },
    ).then((outcomes) => mergeBatchEnvelopes(normalizedIds, outcomes, "history"));
  }

  news(instrumentId, options = {}) {
    const id = normalizeNewsInstrumentId(instrumentId);
    const limit = normalizeIntegerLimit(
      options.limit,
      CONFIG.NEWS.MODAL_LIMIT,
      MAX_NEWS_PER_INSTRUMENT,
      "news limit",
    );
    const endpoint = `/instruments/${encodeURIComponent(id)}/news`;
    return this.#request(endpoint, {
      query: { limit },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }).then((envelope) => validateNewsEnvelope(envelope, endpoint, { instrumentId: id }));
  }

  newsBatch(instrumentIds, options = {}) {
    const ids = normalizeInstrumentIds(
      instrumentIds,
      "news batch",
      MAX_NEWS_BATCH_IDS,
      normalizeNewsInstrumentId,
    );
    const limit = normalizeIntegerLimit(
      options.limit,
      CONFIG.NEWS.BOARD_LIMIT,
      MAX_NEWS_BATCH_RESULTS,
      "news batch limit",
    );
    const endpoint = "/news";
    return this.#request(endpoint, {
      query: { ids: ids.join(","), limit },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? CONFIG.API.NEWS_BATCH_TIMEOUT_MS,
    }).then((envelope) => validateNewsEnvelope(envelope, endpoint, { batch: true }));
  }

  analyticsSnapshot(ids, options = {}) {
    const normalizedIds = normalizeInstrumentIds(
      ids,
      "analytics snapshot",
      MAX_ANALYTICS_IDS,
      normalizeInstrumentId,
      { deduplicate: true },
    );
    const endpoint = "/analytics/snapshot";
    return this.#request(endpoint, {
      query: { ids: normalizedIds.join(",") },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }).then((envelope) => validateAnalyticsEnvelope(envelope, endpoint));
  }

  health(options = {}) {
    return this.#request("/health", {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  clearCache() {
    this.etagCache.clear();
  }

  async #request(path, options) {
    const url = this.#buildUrl(path, options.query);
    const cached = this.#readCachedEnvelope(url);
    const headers = {
      Accept: "application/json, application/problem+json",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    const timeoutMs = normalizeTimeout(options.timeoutMs, this.timeoutMs);
    const controller = new AbortController();
    const externalSignal = options.signal;
    let timeoutId = null;
    let timedOut = false;

    if (externalSignal?.aborted) {
      throw createAbortError(externalSignal.reason);
    }

    const forwardAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(createAbortError());
      }, timeoutMs);
    }

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-cache",
        headers,
        signal: controller.signal,
      });

      if (timedOut) throw createAbortError();
      if (externalSignal?.aborted) throw createAbortError(externalSignal.reason);
      if (response.status === 304) {
        if (!cached?.envelope) {
          throw new MarketDataClientError("Received HTTP 304 without a cached response", {
            code: "schema_invalid",
            status: 502,
            retryable: false,
            url,
          });
        }
        const refreshedEtag = response.headers.get("etag") || cached.etag;
        const nextRefreshAt = response.headers.get("x-next-refresh-at");
        const refreshedEnvelope = nextRefreshAt
          ? {
              ...cached.envelope,
              meta: { ...cached.envelope.meta, nextRefreshAt },
            }
          : cached.envelope;
        if (refreshedEtag !== cached.etag || refreshedEnvelope !== cached.envelope) {
          this.#cacheEnvelope(url, {
            etag: refreshedEtag,
            envelope: refreshedEnvelope,
          });
        }
        return refreshedEnvelope;
      }

      const { value, parseError } = await readJsonBody(response);
      if (timedOut) throw createAbortError();
      if (externalSignal?.aborted) throw createAbortError(externalSignal.reason);

      if (!response.ok) {
        throw MarketDataClientError.fromResponse(response, value, url);
      }
      if (parseError || value === null) {
        throw new MarketDataClientError("Market data API returned invalid JSON", {
          code: "schema_invalid",
          status: 502,
          retryable: false,
          cause: parseError,
          url,
        });
      }

      const envelope = validateMarketDataEnvelope(value, path, {
        apiVersion: "v1",
        schemaVersion: 2,
      });
      const etag = response.headers.get("etag");
      if (etag) this.#cacheEnvelope(url, { etag, envelope });
      else if (cached) this.#cacheEnvelope(url, null);
      return envelope;
    } catch (error) {
      if (error instanceof MarketDataClientError) throw error;
      if (timedOut) {
        throw new MarketDataClientError(`Market data request timed out after ${timeoutMs}ms`, {
          code: "timeout",
          retryable: true,
          cause: error,
          url,
        });
      }
      if (externalSignal?.aborted) {
        throw createAbortError(externalSignal.reason);
      }
      throw new MarketDataClientError("Unable to reach the market data API", {
        code: "network_error",
        retryable: true,
        cause: error,
        url,
      });
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  #buildUrl(path, query = null) {
    const params = new URLSearchParams();
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value != null) params.set(key, String(value));
      });
    }
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : "";
    return `${this.apiBaseUrl}${path}${suffix}`;
  }

  #readCachedEnvelope(url) {
    const cached = this.etagCache.get(url);
    if (cached && typeof this.etagCache.delete === "function") {
      this.etagCache.delete(url);
      this.etagCache.set(url, cached);
    }
    return cached;
  }

  #cacheEnvelope(url, entry) {
    if (!entry) {
      if (typeof this.etagCache.delete === "function") this.etagCache.delete(url);
      else this.etagCache.set(url, null);
      return;
    }

    this.etagCache.delete?.(url);
    this.etagCache.set(url, entry);
    if (
      typeof this.etagCache.size !== "number"
      || typeof this.etagCache.keys !== "function"
      || typeof this.etagCache.delete !== "function"
    ) {
      return;
    }
    while (this.etagCache.size > this.maxEtagEntries) {
      const oldest = this.etagCache.keys().next().value;
      if (oldest === undefined) return;
      this.etagCache.delete(oldest);
    }
  }
}

export { DEFAULT_ETAG_CACHE_MAX_ENTRIES };
