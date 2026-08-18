import { createHash } from "node:crypto";
import { clonePlain } from "../../shared/clonePlain.js";
import {
  CANONICAL_INSTRUMENT_ID_PATTERN,
  SCHEMA_VERSION,
  ERROR_CODES,
  MAX_MARKET_IDS,
  PROVIDER_SOURCES,
} from "../contracts/core/constants.js";
import {
  NEWS_BATCH_BUDGET_MS,
  NEWS_BATCH_CONCURRENCY,
  NEWS_BATCH_MAX_LIMIT,
  NEWS_BOARD_DEFAULT_LIMIT,
  NEWS_PERSISTENCE_READ_TIMEOUT_MS,
  NEWS_SINGLE_FETCH_BUDGET_MS,
  NEWS_STALE_RECHECK_MS,
  NEWS_WINDOW_MS,
} from "../contracts/core/news.js";
import {
  isIsoTimestamp,
  validateNewsBatchResponse,
  validateNewsFeed,
} from "../contracts/core/validators.js";
import {
  CAPABILITY_REVISION,
  MARKET_SCHEMA_VERSION,
  SEMANTIC_REVISION,
  marketCacheKey,
} from "../contracts/market/constants.js";
import {
  validateHistorySeries,
  validateInstrumentDetails,
  validateQuoteSnapshot,
} from "../contracts/market/index.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import { MemoryCache } from "../cache/MemoryCache.js";
import { InMemorySnapshotStore } from "../cache/InMemorySnapshotStore.js";
import { selectBalancedNewsArticles } from "../metrics/news.js";
import { Telemetry } from "../observability/Telemetry.js";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { SingleFlight } from "./SingleFlight.js";
import { DEFAULT_TTL_POLICY, ttlForNews, ttlFor } from "./ttlPolicy.js";
import { defaultFallbackPolicy } from "./FallbackPolicy.js";

const clone = clonePlain;
const iso = (value) => new Date(value).toISOString();
const CANONICAL_HASH_PREFIX = "sha256-c14n-v1:";
function cacheKey(resourceType, instrumentId, variant = "") {
  return [resourceType, instrumentId, variant].filter(Boolean).join(":");
}

function asMarketError(error, context = {}) {
  const normalized = MarketDataError.from(error, {
    code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    message: context.message || "Market data provider is unavailable",
    retryable: true,
    ...context,
  });
  if (!normalized.provider && context.provider) normalized.provider = context.provider;
  if (!normalized.capability && context.capability) normalized.capability = context.capability;
  if (!normalized.instrumentId && context.instrumentId) normalized.instrumentId = context.instrumentId;
  return normalized;
}

function supports(provider, capability, assetClass) {
  if (typeof provider?.supports === "function") return provider.supports(capability, assetClass);
  const declared = provider?.capabilities?.();
  if (Array.isArray(declared)) return declared.includes(capability);
  if (declared && typeof declared === "object") {
    const value = declared[capability];
    if (value === true) return true;
    if (Array.isArray(value)) return !assetClass || value.includes(assetClass);
    return Boolean(value?.enabled ?? value);
  }
  return typeof provider?.[capability === "quote" ? "quoteMany" : capability] === "function";
}

function markStaleNews(payload, resourceType, layer, ageMs, now) {
  const value = clone(payload);
  const fetchedAt = Date.parse(value.fetchedAt);
  const sourceAgeMs = Number.isFinite(fetchedAt) && Number.isFinite(now)
    ? Math.max(0, now - fetchedAt)
    : ageMs;
  value.cache = { state: "stale", layer, ageMs: sourceAgeMs };
  value.quality = "stale";
  value.originalSource = value.source === "last-known-good" ? value.originalSource : value.source;
  value.source = "last-known-good";
  if (resourceType === "profile" && Array.isArray(value.metrics)) {
    value.metrics = value.metrics.map((metric) => ({
      ...metric,
      quality: metric.value === null ? "unavailable" : "stale",
      ...(metric.source === "derived"
        ? {}
        : { originalSource: metric.source, source: "last-known-good" }),
    }));
  }
  if (resourceType === "history" && Array.isArray(value.bars)) {
    value.bars = value.bars.map((bar) => ({
      ...bar,
      quality: "stale",
      originalSource: bar.source || value.originalSource,
      source: "last-known-good",
    }));
  }
  return value;
}

function uniqueSources(values) {
  return [...new Set(values.map((value) => value?.source).filter(Boolean))];
}

function requestAbortedError(cause) {
  return new MarketDataError(
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    "Provider request was aborted by the caller",
    {
      cause,
      retryable: false,
      details: { reason: "request_aborted" },
    },
  );
}

function persistenceTimeoutError(timeoutMs) {
  return new MarketDataError(
    ERROR_CODES.PERSISTENCE_UNAVAILABLE,
    "Snapshot persistence operation timed out",
    {
      retryable: true,
      details: { reason: "persistence_timeout", timeoutMs },
    },
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function payloadHash(payload) {
  return `${CANONICAL_HASH_PREFIX}${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function validateCachedNewsFeed(resourceType, payload, expected = {}) {
  if (resourceType !== "news") throw new TypeError(`Unsupported news cache resource: ${resourceType}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Cached payload must be an object");
  }
  validateNewsFeed(payload, { now: expected.now });
  if (payload.instrumentId !== expected.instrumentId) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Cached news instrument identity does not match");
  }
  if (!PROVIDER_SOURCES.includes(payload.source)) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Cached payload source is invalid");
  }
  for (const field of ["asOf", "fetchedAt"]) {
    if (!isIsoTimestamp(payload[field])) {
      throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, `Cached payload ${field} is invalid`);
    }
  }
  return payload;
}

function pruneCachedNewsFeed(payload, now) {
  const cutoff = now - NEWS_WINDOW_MS;
  const articles = payload.articles.filter((article) => Date.parse(article.publishedAt) >= cutoff);
  if (articles.length === payload.articles.length) {
    return { value: payload, becameEmpty: false };
  }
  const pruned = {
    ...payload,
    articles,
    asOf: articles[0]?.publishedAt || payload.fetchedAt,
  };
  validateNewsFeed(pruned, { now });
  return {
    value: pruned,
    becameEmpty: payload.articles.length > 0 && articles.length === 0,
  };
}

function capPrunedNewsDeadlines({
  becameEmpty,
  freshUntil,
  origin,
  staleUntil,
  ttlPolicy,
}) {
  if (!becameEmpty) return { freshUntil, staleUntil };
  const emptyTtl = ttlPolicy.newsEmpty;
  return {
    freshUntil: Math.min(freshUntil, origin + emptyTtl.freshMs),
    staleUntil: Math.min(staleUntil, origin + emptyTtl.staleMs),
  };
}

function newsBatchBudgetError(instrumentId, budgetMs) {
  return new MarketDataError(ERROR_CODES.TIMEOUT, "News batch budget exceeded", {
    capability: "news",
    instrumentId,
    retryable: true,
    details: { reason: "batch_budget_exceeded", budgetMs },
  });
}

function validateCachedPayload(resourceType, payload, expected = {}) {
  if (resourceType === "quote") validateQuoteSnapshot(payload);
  else if (resourceType === "history") validateHistorySeries(payload);
  else if (resourceType === "details") validateInstrumentDetails(payload);
  else throw new TypeError(`Unsupported v2 cache resource: ${resourceType}`);
  const payloadInstrumentId = resourceType === "details"
    ? payload.instrument?.id
    : payload.instrumentId;
  if (payloadInstrumentId !== expected.instrumentId) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Cached instrument identity does not match");
  }
  if (resourceType === "history" && expected.variant) {
    for (const [key, value] of Object.entries(expected.variant)) {
      if (payload[key] !== value) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, `Cached v2 history ${key} does not match`);
      }
    }
  }
  return payload;
}

function markStale(payload) {
  const value = clone(payload);
  value.quality = "stale";
  value.dataQuality = {
    ...value.dataQuality,
    status: "usable_with_warnings",
    issues: [
      ...(value.dataQuality?.issues || []).filter(({ code }) => code !== "stale_last_known_good"),
      { code: "stale_last_known_good", severity: "warning", field: null },
    ],
  };
  if (value.fieldAvailability) {
    value.fieldAvailability = Object.fromEntries(Object.entries(value.fieldAvailability)
      .map(([field, entry]) => [field, entry.status === "available" ? { ...entry, status: "stale" } : entry]));
  }
  if (Array.isArray(value.sections)) {
    value.sections = value.sections.map((section) => ({
      ...section,
      status: section.status === "available" ? "stale" : section.status,
      fieldAvailability: Object.fromEntries(Object.entries(section.fieldAvailability || {})
        .map(([field, entry]) => [field, entry.status === "available" ? { ...entry, status: "stale" } : entry])),
    }));
  }
  value.provenance = {
    ...value.provenance,
    originalSource: value.provenance.originalSource || value.provenance.source,
  };
  const resourceType = Array.isArray(value.bars) ? "history" : value.instrument ? "details" : "quote";
  validateCachedPayload(resourceType, value, {
    instrumentId: resourceType === "details" ? value.instrument.id : value.instrumentId,
  });
  return value;
}

function historyVariant(options, descriptor) {
  const variant = {
    range: options.range || "1d",
    interval: options.interval || "5m",
    priceBasis: options.priceBasis || "raw",
    includePrePost: options.includePrePost === true,
    continuity: descriptor.assetClass === "commodity_future"
      ? "provider_continuous_front"
      : "single_instrument",
    schemaVersion: MARKET_SCHEMA_VERSION,
    semanticRevision: SEMANTIC_REVISION,
    capabilityRevision: CAPABILITY_REVISION,
    normalizerRevision: "yahoo-v2@1",
  };
  const hash = createHash("sha256").update(canonicalJson(variant)).digest("base64url").slice(0, 24);
  return { ...variant, hash };
}

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

function groupByAssetClass(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const assetClass = entry?.descriptor?.assetClass || "unknown";
    if (!groups.has(assetClass)) groups.set(assetClass, []);
    groups.get(assetClass).push(entry);
  }
  return groups;
}

function isAggregateProviderFailure(errors, expectedCount) {
  if (!expectedCount || !Array.isArray(errors) || errors.length < expectedCount) return false;
  const systemicCodes = new Set([
    ERROR_CODES.AUTH_FAILED,
    ERROR_CODES.ENTITLEMENT_MISSING,
    ERROR_CODES.RATE_LIMITED,
    ERROR_CODES.SCHEMA_INVALID,
    ERROR_CODES.TIMEOUT,
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
  ]);
  return errors.every((error) => systemicCodes.has(error?.code));
}

function recordQuality(telemetry, resource, payload) {
  if (!telemetry || !payload) return;
  const assetClass = payload.assetClass || payload.instrument?.assetClass || "unknown";
  const unavailable = new Map();
  const addAvailability = (field, entry) => {
    if (!entry || ["available", "stale"].includes(entry.status)) return;
    const reason = entry.reason || entry.status;
    const key = `${field}:${reason}`;
    unavailable.set(key, {
      field,
      reason,
      count: (unavailable.get(key)?.count || 0) + 1,
    });
  };
  for (const [field, entry] of Object.entries(payload.fieldAvailability || {})) {
    addAvailability(field, entry);
  }
  for (const section of payload.sections || []) {
    for (const [field, entry] of Object.entries(section.fieldAvailability || {})) {
      addAvailability(`${section.id}.${field}`, entry);
    }
  }
  for (const bar of payload.bars || []) {
    for (const [field, entry] of Object.entries(bar.fieldAvailability || {})) {
      addAvailability(field, entry);
    }
  }
  for (const { field, reason, count } of unavailable.values()) {
    telemetry.increment("field_unavailable_total", {
      assetClass,
      resource,
      field,
      reason,
    }, count);
  }

  if (resource === "history") {
    const rowsByReason = new Map();
    for (const issue of payload.dataQuality?.issues || []) {
      if (!`${issue.code || ""}`.startsWith("row_dropped_") && issue.code !== "duplicate_timestamp") continue;
      rowsByReason.set(issue.code, (rowsByReason.get(issue.code) || 0) + 1);
    }
    for (const [reason, count] of rowsByReason) {
      telemetry.increment("history_rows_dropped_total", { assetClass, reason }, count);
    }
    if ((payload.dataQuality?.issues || []).some(({ code }) => code === "future_rollover_detected")) {
      telemetry.increment("future_rollover_total", { assetClass });
    }
  }
}

export class MarketDataOrchestrator {
  constructor({
    providers = [],
    memoryCache = new MemoryCache({ clone }),
    snapshotStore = new InMemorySnapshotStore(),
    singleFlight = new SingleFlight(),
    telemetry = new Telemetry(),
    logger = null,
    clock = () => Date.now(),
    ttlPolicy = DEFAULT_TTL_POLICY,
    providerTimeoutMs = 2_800,
    persistenceTimeoutMs = Math.min(providerTimeoutMs, 750),
    historyBatchConcurrency = 8,
    breakerOptions = {},
    instrumentResolver,
    fallbackPolicy = defaultFallbackPolicy,
  } = {}) {
    if (!Array.isArray(providers) || !providers.length) {
      throw new TypeError("MarketDataOrchestrator requires at least one provider");
    }
    if (typeof instrumentResolver?.getDescriptor !== "function"
      || typeof instrumentResolver?.capabilitiesFor !== "function"
      || typeof instrumentResolver?.idForProviderSymbol !== "function") {
      throw new TypeError("A compatible instrument resolver is required");
    }
    this.providers = providers;
    this.memoryCache = memoryCache;
    this.snapshotStore = snapshotStore;
    this.singleFlight = singleFlight;
    this.telemetry = telemetry;
    this.logger = logger;
    this.clock = clock;
    this.ttlPolicy = ttlPolicy === DEFAULT_TTL_POLICY
      ? ttlPolicy
      : Object.freeze({ ...DEFAULT_TTL_POLICY, ...(ttlPolicy || {}) });
    this.providerTimeoutMs = providerTimeoutMs;
    this.persistenceTimeoutMs = Math.max(1, Number(persistenceTimeoutMs) || Math.min(providerTimeoutMs, 750));
    this.historyBatchConcurrency = Math.max(1, Math.min(Number(historyBatchConcurrency) || 8, 16));
    this.breakerOptions = breakerOptions;
    this.instrumentResolver = instrumentResolver;
    this.fallbackPolicy = fallbackPolicy;
    this.breakers = new Map();
    this.disabledCapabilities = new Map();
    this.newsFlights = new Map();
    this.newsFlightSequence = 0;
    this.persistenceHealthy = true;
  }

  async #resolveDescriptor(value, signal) {
    return this.instrumentResolver.getDescriptor(value, { signal });
  }

  async getSnapshot(ids, options = {}) {
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
    const dataById = new Map();
    const errorsById = new Map();
    const staleById = new Map();
    const pending = [];
    const freshUntilValues = [];

    const unique = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).toUpperCase()))];

    const candidates = await mapConcurrent(
      unique,
      this.historyBatchConcurrency,
      async (id) => {
        try {
          const descriptor = await this.#resolveDescriptor(id, options.signal);
          const capabilities = this.instrumentResolver.capabilitiesFor(descriptor);
          if (capabilities.quote.status === "unsupported") {
            this.telemetry.increment("capability_skip_total", {
              operation: "quote",
              assetClass: descriptor.assetClass,
              reason: capabilities.quote.reason || "quote_unsupported",
            });
            throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, "Quote is not enabled for this instrument", {
              instrumentId: id,
              retryable: false,
              details: { reason: capabilities.quote.reason || "quote_unsupported", assetClass: descriptor.assetClass },
            });
          }
          const key = marketCacheKey("quote", descriptor.id, "observation");
          const cached = await this.#readCache(key, "quote", descriptor.id, null, options.signal);
          return { id, descriptor, key, cached };
        } catch (error) {
          return { id, error: asMarketError(error, { instrumentId: id, capability: "quote" }) };
        }
      },
    );
    const order = [];
    const seenInstrumentIds = new Set();
    for (const candidate of candidates) {
      if (candidate.error) {
        order.push(candidate.id);
        errorsById.set(candidate.id, candidate.error);
        continue;
      }
      const instrumentId = candidate.descriptor.id;
      if (seenInstrumentIds.has(instrumentId)) continue;
      seenInstrumentIds.add(instrumentId);
      order.push(instrumentId);
      if (candidate.cached?.state === "fresh") {
        dataById.set(instrumentId, candidate.cached.value);
        freshUntilValues.push(candidate.cached.freshUntil);
      } else {
        if (candidate.cached?.state === "stale") {
          staleById.set(instrumentId, markStale(candidate.cached.value));
        }
        pending.push({ descriptor: candidate.descriptor, key: candidate.key });
      }
    }

    if (pending.length) {
      const yahoo = this.providers.find((provider) => provider.id === "yahoo" && typeof provider.quoteMany === "function");
      let fetched = { data: [], errors: [] };
      if (yahoo) {
        const groups = [...groupByAssetClass(pending)];
        const outcomes = await mapConcurrent(groups, Math.min(3, groups.length), async ([assetClass, entries]) => {
          try {
            const result = await this.#callProvider(yahoo, {
              operation: "quote",
              assetClass,
              semanticVariant: "raw_quote",
            }, async (signal) => {
              const batch = await yahoo.quoteMany(entries.map(({ descriptor }) => descriptor), { signal });
              if (!batch || !Array.isArray(batch.data) || !Array.isArray(batch.errors)) {
                throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Yahoo returned an invalid quote batch", {
                  provider: "yahoo",
                  capability: "quote",
                  retryable: true,
                });
              }
              if (!batch.data.length && isAggregateProviderFailure(batch.errors, entries.length)) {
                throw batch.errors[0];
              }
              return batch;
            }, options.signal);
            return { ...result, assetClass, requested: entries.length };
          } catch (error) {
            return {
              data: [],
              errors: entries.map(({ descriptor }) => asMarketError(error, {
                instrumentId: descriptor.id,
                capability: "quote",
                provider: "yahoo",
              })),
              assetClass,
              requested: entries.length,
            };
          }
        });
        for (const outcome of outcomes) {
          fetched.data.push(...outcome.data);
          fetched.errors.push(...outcome.errors);
          this.telemetry.observe("quote_coverage_ratio", outcome.requested
            ? outcome.data.length / outcome.requested
            : 0, { assetClass: outcome.assetClass });
          for (const quote of outcome.data) recordQuality(this.telemetry, "quote", quote);
        }
      } else {
        fetched.errors = pending.map(({ descriptor }) => new MarketDataError(
          ERROR_CODES.UPSTREAM_UNAVAILABLE,
          "No quote provider is configured",
          { instrumentId: descriptor.id, capability: "quote", retryable: true },
        ));
      }

      const fetchedById = new Map(fetched.data.map((quote) => [quote.instrumentId, quote]));
      const primaryErrors = new Map(fetched.errors.map((error) => [error.instrumentId, error]));
      const finnhub = this.providers.find((provider) => provider.id === "finnhub" && typeof provider.quoteMany === "function");
      const fallbackDescriptors = [];
      const fallbackContextById = new Map();
      for (const { descriptor } of pending) {
        if (fetchedById.has(descriptor.id)) continue;
        const primaryError = primaryErrors.get(descriptor.id) || new MarketDataError(
          ERROR_CODES.UPSTREAM_UNAVAILABLE,
          "Yahoo returned no quote",
          { instrumentId: descriptor.id, capability: "quote", provider: "yahoo", retryable: true },
        );
        primaryErrors.set(descriptor.id, primaryError);
        const decision = this.fallbackPolicy?.fallbackDecision?.({
          fromProvider: "yahoo",
          toProvider: "finnhub",
          operation: "quote",
          assetClass: descriptor.assetClass,
          semanticVariant: "raw_quote",
          fallbackSemanticVariant: "raw_quote",
          instrument: descriptor,
          error: primaryError,
        }) || { allowed: false, reason: "policy_unavailable" };
        const fallbackAvailable = decision.allowed
          && finnhub
          && this.#supports(finnhub, "quote", descriptor.assetClass, "raw_quote", descriptor);
        if (fallbackAvailable) {
          fallbackDescriptors.push(descriptor);
          fallbackContextById.set(descriptor.id, {
            fromProvider: "yahoo",
            errorCode: primaryError.code,
            semanticMatch: decision.semanticMatch,
          });
        } else {
          this.telemetry.increment("provider_fallback_prevented", {
            provider: "finnhub",
            operation: "quote",
            assetClass: descriptor.assetClass,
            reason: decision.allowed ? "provider_unavailable" : decision.reason,
          });
        }
      }

      if (fallbackDescriptors.length) {
        try {
          const fallback = await this.#callProvider(finnhub, {
            operation: "quote",
            assetClass: "equity",
            semanticVariant: "raw_quote",
          }, async (signal) => {
            const batch = await finnhub.quoteMany(fallbackDescriptors, { signal, fallbackContextById });
            if (!batch || !Array.isArray(batch.data) || !Array.isArray(batch.errors)) {
              throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Finnhub returned an invalid quote batch", {
                provider: "finnhub",
                capability: "quote",
                retryable: true,
              });
            }
            if (!batch.data.length && isAggregateProviderFailure(batch.errors, fallbackDescriptors.length)) {
              throw batch.errors[0];
            }
            return batch;
          }, options.signal);
          for (const quote of fallback.data) {
            fetchedById.set(quote.instrumentId, quote);
            recordQuality(this.telemetry, "quote", quote);
            this.telemetry.increment("provider_fallback", {
              provider: "finnhub",
              operation: "quote",
              assetClass: quote.assetClass,
              outcome: "success",
            });
            this.telemetry.increment("provider_fallback_total", {
              from: "yahoo",
              to: "finnhub",
              operation: "quote",
              assetClass: quote.assetClass,
              semanticMatch: "raw_quote",
              outcome: "success",
            });
          }
          for (const error of fallback.errors) {
            this.telemetry.increment("provider_fallback_total", {
              from: "yahoo",
              to: "finnhub",
              operation: "quote",
              assetClass: "equity",
              semanticMatch: "raw_quote",
              outcome: error.code || "error",
            });
          }
        } catch (error) {
          this.telemetry.increment("provider_fallback_total", {
            from: "yahoo",
            to: "finnhub",
            operation: "quote",
            assetClass: "equity",
            semanticMatch: "raw_quote",
            outcome: error?.code || "error",
          });
        }
      }

      const cacheWrites = new Map();
      for (const { descriptor, key } of pending) {
        const quote = fetchedById.get(descriptor.id);
        if (quote) {
          dataById.set(descriptor.id, quote);
          const ttl = ttlFor("quote", quote, this.ttlPolicy);
          freshUntilValues.push(this.clock() + ttl.freshMs);
          cacheWrites.set(key, { key, instrumentId: descriptor.id, quote, ttl });
        } else if (staleById.has(descriptor.id)) {
          dataById.set(descriptor.id, staleById.get(descriptor.id));
          freshUntilValues.push(this.clock() + this.ttlPolicy.quote.freshMs);
        } else {
          errorsById.set(descriptor.id, primaryErrors.get(descriptor.id) || new MarketDataError(
            ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "No provider returned a quote",
            { instrumentId: descriptor.id, capability: "quote", retryable: true },
          ));
        }
      }
      await mapConcurrent(
        [...cacheWrites.values()],
        this.historyBatchConcurrency,
        ({ key, instrumentId, quote, ttl }) => this.#writeCache(
          key,
          "quote",
          instrumentId,
          quote,
          { ttl },
        ),
      );
    }

    const data = order.map((id) => dataById.get(id)).filter(Boolean);
    const errors = order.map((id) => errorsById.get(id)).filter(Boolean);
    const retryMs = this.ttlPolicy.quote.freshMs;
    if (errors.some((error) => error.retryable)) {
      freshUntilValues.push(this.clock() + retryMs);
    }
    const nextRefreshAt = iso(freshUntilValues.length
      ? Math.min(...freshUntilValues)
      : this.clock() + retryMs);
    return {
      data,
      errors,
      sources: { quote: [...new Set(data.map((quote) => quote.provenance.source))] },
      descriptorRevision: 1,
      nextRefreshAt,
    };
  }

  async getDetails(id, options = {}) {
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
    const descriptor = await this.#resolveDescriptor(String(id).toUpperCase(), options.signal);
    const capabilities = this.instrumentResolver.capabilitiesFor(descriptor);
    if (capabilities.details.status === "unsupported") {
      this.telemetry.increment("capability_skip_total", {
        operation: "details",
        assetClass: descriptor.assetClass,
        reason: capabilities.details.reason || "details_unsupported",
      });
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, "Details are unavailable for this instrument", {
        instrumentId: descriptor.id,
        capability: "details",
        retryable: false,
        details: { reason: capabilities.details.reason || "details_unsupported", assetClass: descriptor.assetClass },
      });
    }
    const requestedSections = Array.isArray(options.sections) && options.sections.length
      ? options.sections.filter((section) => capabilities.details.sections.includes(section))
      : capabilities.details.sections;
    if (!requestedSections.length) {
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_SEMANTICS, "No requested detail section is available", {
        instrumentId: descriptor.id,
        capability: "details",
        retryable: false,
      });
    }
    const variant = createHash("sha256")
      .update(canonicalJson({
        sections: requestedSections.slice().sort(),
        schemaVersion: MARKET_SCHEMA_VERSION,
        semanticRevision: SEMANTIC_REVISION,
        capabilityRevision: CAPABILITY_REVISION,
        normalizerRevision: "yahoo-details-v2@1",
      }))
      .digest("base64url")
      .slice(0, 24);
    const key = marketCacheKey("details", descriptor.id, variant);
    const cached = await this.#readCache(key, "details", descriptor.id, null, options.signal);
    if (cached?.state === "fresh") {
      return {
        data: cached.value,
        sources: { details: cached.value.provenance.source },
        nextRefreshAt: iso(cached.freshUntil),
      };
    }
    const stale = cached?.state === "stale" ? markStale(cached.value) : null;
    const yahoo = this.providers.find((provider) => provider.id === "yahoo" && typeof provider.details === "function");
    if (!yahoo) {
      if (stale) return { data: stale, sources: { details: stale.provenance.source }, nextRefreshAt: iso(this.clock() + this.ttlPolicy.quote.freshMs) };
      throw new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "No details provider is configured", {
        instrumentId: descriptor.id,
        capability: "details",
        retryable: true,
      });
    }
    try {
      let details = await this.#runShared(
        key,
        () => this.#callProvider(yahoo, {
          operation: "details",
          assetClass: descriptor.assetClass,
          semanticVariant: requestedSections.slice().sort().join("+") || "default",
        }, (signal) => yahoo.details(descriptor, { signal }), undefined),
        options.signal,
      );
      details = {
        ...details,
        sections: details.sections.filter((section) => requestedSections.includes(section.id)),
      };
      validateInstrumentDetails(details);
      recordQuality(this.telemetry, "details", details);
      const ttl = ttlFor("details", details, this.ttlPolicy);
      await this.#writeCache(key, "details", descriptor.id, details, { ttl });
      return {
        data: details,
        sources: { details: details.provenance.source },
        nextRefreshAt: iso(this.clock() + ttl.freshMs),
      };
    } catch (error) {
      if (stale) return { data: stale, sources: { details: stale.provenance.source }, nextRefreshAt: iso(this.clock() + this.ttlPolicy.quote.freshMs) };
      throw error;
    }
  }

  async getHistory(id, options = {}) {
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
    const descriptor = await this.#resolveDescriptor(String(id).toUpperCase(), options.signal);
    const capabilities = this.instrumentResolver.capabilitiesFor(descriptor);
    const range = options.range || "1d";
    const interval = options.interval || "5m";
    const priceBasis = options.priceBasis || "raw";
    this.telemetry.increment("history_basis_request_total", {
      assetClass: descriptor.assetClass,
      priceBasis,
      outcome: "requested",
    });
    const allowedIntervals = capabilities.history.ranges?.[range] || [];
    const allowedBases = capabilities.history.priceBases || [];
    if (capabilities.history.status === "unsupported"
      || !allowedIntervals.includes(interval)
      || !allowedBases.includes(priceBasis)) {
      this.telemetry.increment("capability_skip_total", {
        operation: "history",
        assetClass: descriptor.assetClass,
        reason: capabilities.history.reason || "unsupported_semantics",
      });
      this.telemetry.increment("history_basis_request_total", {
        assetClass: descriptor.assetClass,
        priceBasis,
        outcome: "unsupported",
      });
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_SEMANTICS, "Requested history semantics are unavailable", {
        instrumentId: descriptor.id,
        capability: "history",
        retryable: false,
        details: {
          range,
          interval,
          requestedPriceBasis: priceBasis,
          availablePriceBases: allowedBases,
          availableRanges: capabilities.history.ranges || {},
        },
      });
    }

    const variant = historyVariant({ ...options, range, interval, priceBasis }, descriptor);
    const key = marketCacheKey("history", descriptor.id, variant.hash);
    const expected = { range, interval, priceBasis, requestedPriceBasis: priceBasis };
    const cached = await this.#readCache(key, "history", descriptor.id, expected, options.signal);
    if (cached?.state === "fresh") {
      this.telemetry.increment("history_basis_request_total", {
        assetClass: descriptor.assetClass,
        priceBasis,
        outcome: "cache_hit",
      });
      return {
        data: cached.value,
        sources: { history: cached.value.provenance.source },
        nextRefreshAt: iso(cached.freshUntil),
      };
    }
    const stale = cached?.state === "stale" ? markStale(cached.value) : null;
    const yahoo = this.providers.find((provider) => provider.id === "yahoo" && typeof provider.history === "function");
    if (!yahoo) {
      if (stale) {
        return {
          data: stale,
          sources: { history: stale.provenance.source },
          nextRefreshAt: iso(this.clock() + this.ttlPolicy.quote.freshMs),
        };
      }
      throw new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "No history provider is configured", {
        instrumentId: descriptor.id,
        capability: "history",
        retryable: true,
      });
    }

    try {
      const history = await this.#runShared(
        key,
        () => this.#callProvider(yahoo, {
          operation: "history",
          assetClass: descriptor.assetClass,
          semanticVariant: priceBasis,
        }, (signal) => yahoo.history(descriptor, {
          ...options,
          range,
          interval,
          priceBasis,
          signal,
        }), undefined),
        options.signal,
      );
      recordQuality(this.telemetry, "history", history);
      this.telemetry.increment("history_basis_request_total", {
        assetClass: descriptor.assetClass,
        priceBasis,
        outcome: "success",
      });
      const ttl = ttlFor("history", history, this.ttlPolicy);
      await this.#writeCache(key, "history", descriptor.id, history, { ttl, variant: expected });
      return {
        data: history,
        sources: { history: history.provenance.source },
        nextRefreshAt: iso(this.clock() + ttl.freshMs),
      };
    } catch (error) {
      this.telemetry.increment("history_basis_request_total", {
        assetClass: descriptor.assetClass,
        priceBasis,
        outcome: error?.code || "error",
      });
      if (stale) {
        return {
          data: stale,
          sources: { history: stale.provenance.source },
          nextRefreshAt: iso(this.clock() + this.ttlPolicy.quote.freshMs),
        };
      }
      throw error;
    }
  }

  async getHistoryBatch(ids, options = {}) {
    if (!Array.isArray(ids)) {
      throw new MarketDataError(
        ERROR_CODES.INVALID_REQUEST,
        "History batch expects an array of instrument IDs",
        { capability: "history", retryable: false },
      );
    }
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
    const unique = [...new Set(ids.map((id) => String(id).toUpperCase()))];
    const concurrency = Math.max(1, Math.min(
      Number(options.maxConcurrency) || this.historyBatchConcurrency,
      unique.length || 1,
    ));
    const outcomes = await mapConcurrent(unique, concurrency, async (instrumentId) => {
      try {
        return { ok: true, result: await this.getHistory(instrumentId, options) };
      } catch (error) {
        const normalized = asMarketError(error, { instrumentId, capability: "history" });
        if (normalized.details?.reason === "request_aborted") throw normalized;
        return { ok: false, error: normalized };
      }
    });
    const dataById = new Map();
    const errorsById = new Map();
    const refresh = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      const instrumentId = unique[index];
      if (outcome.ok) {
        dataById.set(instrumentId, outcome.result.data);
        const at = Date.parse(outcome.result.nextRefreshAt);
        if (Number.isFinite(at)) refresh.push(at);
      } else errorsById.set(instrumentId, outcome.error);
    }
    const data = unique.map((instrumentId) => dataById.get(instrumentId)).filter(Boolean);
    const errors = unique.map((instrumentId) => errorsById.get(instrumentId)).filter(Boolean);
    return {
      data,
      errors,
      sources: { history: [...new Set(data.map((series) => series.provenance.source))] },
      nextRefreshAt: iso(refresh.length ? Math.min(...refresh) : this.clock() + this.ttlPolicy.historyIntraday.freshMs),
    };
  }

  async getNews(id, options = {}) {
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
    const instrument = await this.#resolveDescriptor(String(id).toUpperCase(), options.signal);
    const capabilities = this.instrumentResolver.capabilitiesFor(instrument);
    if (capabilities.news?.status === "unsupported") {
      this.telemetry.increment("capability_skip_total", {
        operation: "news",
        assetClass: instrument.assetClass,
        reason: capabilities.news.reason || "news_unsupported",
      });
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, "News is unavailable for this instrument", {
        instrumentId: instrument.id,
        capability: "news",
        retryable: false,
        details: { reason: capabilities.news.reason || "news_unsupported", assetClass: instrument.assetClass },
      });
    }
    const key = cacheKey("news", instrument.id);
    const cached = await this.#readNewsCache(key, "news", instrument.id, null, options.signal);
    if (cached?.state === "fresh") {
      return {
        data: cached.value,
        sources: { news: [cached.value.source] },
        lastUpdatedAt: cached.value.fetchedAt,
        nextRefreshAt: iso(cached.freshUntil),
      };
    }
    if (cached?.state === "stale") {
      this.singleFlight.run(
        `${key}:refresh`,
        () => this.#withNewsFetchBudget(
          (signal) => this.#fetchNews(instrument, { ...options, signal }, key),
        ),
      ).catch((error) => {
        this.logger?.warn?.({
          capability: "news",
          cacheOutcome: "refresh-error",
          errorCode: error?.code,
          instrumentId: instrument.id,
        });
      });
      return {
        data: markStaleNews(cached.value, "news", cached.layer, cached.ageMs, this.clock()),
        sources: { news: ["last-known-good"] },
        lastUpdatedAt: cached.value.fetchedAt,
        nextRefreshAt: iso(this.clock() + NEWS_STALE_RECHECK_MS),
      };
    }

    const feed = await this.#runNewsShared(
      key,
      (signal) => this.#withNewsFetchBudget(
        (fetchSignal) => this.#fetchNews(instrument, { ...options, signal: fetchSignal }, key),
        signal,
      ),
      options.signal,
    );
    const ttl = ttlForNews("news", feed, this.ttlPolicy);
    const written = this.memoryCache.peek(key);
    return {
      data: feed,
      sources: { news: [feed.source] },
      lastUpdatedAt: feed.fetchedAt,
      nextRefreshAt: iso(written?.freshUntil ?? this.clock() + ttl.freshMs),
    };
  }

  async getNewsBatch(ids, options = {}) {
    if (!Array.isArray(ids)) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "News batch expects an array of instrument IDs", {
        capability: "news",
        retryable: false,
      });
    }
    if (!ids.length || ids.length > MAX_MARKET_IDS) {
      throw new MarketDataError(
        ERROR_CODES.INVALID_REQUEST,
        `News batch requires between 1 and ${MAX_MARKET_IDS} instrument IDs`,
        { capability: "news", retryable: false },
      );
    }
    if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);

    const requestedIds = ids.map((value) => typeof value === "string" ? value.trim().toUpperCase() : "");
    if (requestedIds.some((value) => !CANONICAL_INSTRUMENT_ID_PATTERN.test(value))) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "News batch requires canonical instrument IDs", {
        capability: "news",
        retryable: false,
      });
    }

    const budgetMs = Math.min(
      NEWS_BATCH_BUDGET_MS,
      Math.max(1, Number(options.budgetMs) || NEWS_BATCH_BUDGET_MS),
    );
    const controller = new AbortController();
    let budgetExceeded = false;
    const budgetTimer = setTimeout(() => {
      budgetExceeded = true;
      controller.abort(new Error("News batch budget exceeded"));
    }, budgetMs);
    budgetTimer.unref?.();
    const onCallerAbort = () => controller.abort(options.signal.reason);
    if (options.signal) {
      if (options.signal.aborted) onCallerAbort();
      else options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const initialErrors = [];
    const seen = new Set();
    const instruments = [];
    try {
      for (const requestedId of requestedIds) {
        if (controller.signal.aborted) {
          if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
          initialErrors.push(newsBatchBudgetError(requestedId, budgetMs));
          continue;
        }
        try {
          const instrument = await this.#raceCaller(
            this.#resolveDescriptor(requestedId, controller.signal),
            controller.signal,
          );
          if (seen.has(instrument.id)) continue;
          seen.add(instrument.id);
          instruments.push(instrument);
        } catch (error) {
          if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
          initialErrors.push(budgetExceeded
            ? newsBatchBudgetError(requestedId, budgetMs)
            : asMarketError(error, {
                capability: "news",
                instrumentId: String(requestedId).toUpperCase(),
              }));
        }
      }

      const concurrency = Math.max(1, Math.min(
        Number(options.maxConcurrency) || NEWS_BATCH_CONCURRENCY,
        NEWS_BATCH_CONCURRENCY,
        instruments.length || 1,
      ));
      const outcomes = new Array(instruments.length);
      let cursor = 0;
      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) {
            if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
            return;
          }
          const index = cursor;
          cursor += 1;
          if (index >= instruments.length) return;
          const instrument = instruments[index];
          try {
            outcomes[index] = {
              ok: true,
              result: await this.getNews(instrument.id, { signal: controller.signal }),
            };
          } catch (error) {
            const normalized = asMarketError(error, {
              capability: "news",
              instrumentId: instrument.id,
            });
            if (normalized.details?.reason === "request_aborted") {
              if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
              if (budgetExceeded) {
                outcomes[index] = { ok: false, error: newsBatchBudgetError(instrument.id, budgetMs) };
                return;
              }
              throw normalized;
            }
            outcomes[index] = { ok: false, error: normalized };
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: concurrency }, worker));
      } catch (error) {
        if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
        if (!budgetExceeded) throw error;
      }
      if (options.signal?.aborted) throw requestAbortedError(options.signal.reason);
      if (budgetExceeded) {
        for (let index = 0; index < outcomes.length; index += 1) {
          if (!outcomes[index]) {
            outcomes[index] = {
              ok: false,
              error: newsBatchBudgetError(instruments[index].id, budgetMs),
            };
          }
        }
      }

      const feeds = [];
      const errors = [...initialErrors];
      const refreshTimes = [];
      const updatedTimes = [];
      for (const outcome of outcomes) {
        if (!outcome) continue;
        if (!outcome.ok) {
          errors.push(outcome.error);
          continue;
        }
        feeds.push(outcome.result.data);
        const updatedAt = Date.parse(outcome.result.data.fetchedAt);
        if (Number.isFinite(updatedAt)) updatedTimes.push(updatedAt);
        const refreshAt = Date.parse(outcome.result.nextRefreshAt);
        if (Number.isFinite(refreshAt)) refreshTimes.push(refreshAt);
      }
      if (errors.some((error) => error.retryable)) {
        refreshTimes.push(this.clock() + NEWS_STALE_RECHECK_MS);
      }

      const requested = Number(options.limit ?? NEWS_BOARD_DEFAULT_LIMIT);
      const limit = Number.isInteger(requested)
        ? Math.max(1, Math.min(requested, NEWS_BATCH_MAX_LIMIT))
        : NEWS_BOARD_DEFAULT_LIMIT;
      const articles = selectBalancedNewsArticles(feeds, { limit });
      const result = {
        data: { articles },
        errors,
        sources: { news: uniqueSources(feeds) },
        lastUpdatedAt: updatedTimes.length ? iso(Math.min(...updatedTimes)) : null,
        nextRefreshAt: iso(refreshTimes.length
          ? Math.min(...refreshTimes)
          : this.clock() + ttlForNews("news", { articles: [] }, this.ttlPolicy).freshMs),
      };
      validateNewsBatchResponse(result, { now: this.clock() });
      return result;
    } finally {
      clearTimeout(budgetTimer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  getHealth() {
    const circuits = Object.fromEntries([...this.breakers].map(([key, breaker]) => [key, breaker.snapshot()]));
    const providerStatus = Object.fromEntries(this.providers.map((provider) => {
      const capabilities = provider.capabilities?.() || {};
      const quarantinedCapabilities = Object.fromEntries(
        [...this.disabledCapabilities]
          .filter(([key]) => key.startsWith(`${provider.id}:`))
          .map(([key, value]) => [key.slice(provider.id.length + 1), value]),
      );
      const globallyQuarantined = Object.hasOwn(quarantinedCapabilities, "*:*:*");
      const enabled = Object.entries(capabilities).some(([capability, spec]) => (
        (spec === true || spec?.enabled === true)
        && !globallyQuarantined
        && !Object.hasOwn(quarantinedCapabilities, capability)
      ));
      return [provider.id, { enabled, capabilities, quarantinedCapabilities }];
    }));
    const providerEnabled = Object.values(providerStatus).some((provider) => provider.enabled);
    const persistenceDegraded = Boolean(this.snapshotStore) && !this.persistenceHealthy;
    const circuitDegraded = Object.values(circuits).some((circuit) => circuit.state !== "closed");
    const providerDegraded = Object.values(providerStatus).some(
      (provider) => Object.keys(provider.quarantinedCapabilities).length > 0,
    );
    return {
      status: providerEnabled && !persistenceDegraded && !circuitDegraded && !providerDegraded
        ? "ok"
        : "degraded",
      providers: providerStatus,
      persistence: {
        enabled: Boolean(this.snapshotStore),
        healthy: this.persistenceHealthy,
        adapter: this.snapshotStore?.constructor?.name || "none",
        entries: typeof this.snapshotStore?.size === "number" ? this.snapshotStore.size : null,
      },
      memoryCache: { entries: this.memoryCache.size },
      singleFlight: { active: this.singleFlight.size },
      circuits,
      telemetry: this.telemetry.snapshot(),
    };
  }

  async close() {
    await this.snapshotStore?.close?.();
  }

  async #fetchNews(instrument, options, explicitKey) {
    let lastError = null;
    let primaryRetryableError = null;
    let validEmpty = null;
    let retryableFailureAfterEmpty = false;
    let fallbackReason = null;
    let attempted = 0;

    for (const provider of this.providers) {
      if (!this.#supportsNews(provider, "news", instrument.assetClass, instrument)) continue;
      if (attempted > 0) {
        this.telemetry.increment("provider_fallback", {
          capability: "news",
          provider: provider.id,
          reason: fallbackReason || "unavailable",
        });
      }
      attempted += 1;
      try {
        const feed = await this.#callNewsProvider(provider, "news", async (signal) => {
          const value = await provider.news(instrument, {
            ...options,
            signal,
            resolveProviderSymbol: (symbol) => this.instrumentResolver.idForProviderSymbol(symbol) || null,
          });
          try {
            validateNewsFeed(value, { now: this.clock() });
          } catch (error) {
            throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, `${provider.id} returned an invalid news feed`, {
              cause: error,
              provider: provider.id,
              capability: "news",
              instrumentId: instrument.id,
              details: error.details,
            });
          }
          if (value.instrumentId !== instrument.id) {
            throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, `${provider.id} returned news for a different instrument`, {
              provider: provider.id,
              capability: "news",
              instrumentId: instrument.id,
            });
          }
          if (value.source !== provider.id || value.quality !== "fresh") {
            throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, `${provider.id} returned invalid news provenance`, {
              provider: provider.id,
              capability: "news",
              instrumentId: instrument.id,
              details: { source: value.source, quality: value.quality },
            });
          }
          return value;
        }, options.signal);
        if (feed.articles.length > 0) {
          await this.#writeNewsCache(
            explicitKey || cacheKey("news", instrument.id),
            "news",
            instrument.id,
            feed,
            { backgroundPersistence: true },
          );
          return feed;
        }
        validEmpty = feed;
        fallbackReason = "empty";
      } catch (error) {
        const normalized = asMarketError(error, {
          provider: provider.id,
          capability: "news",
          instrumentId: instrument.id,
        });
        if (normalized.details?.reason === "request_aborted") throw normalized;
        if (!primaryRetryableError && normalized.retryable) primaryRetryableError = normalized;
        if (validEmpty && normalized.retryable) retryableFailureAfterEmpty = true;
        const locallyIneligible = [
          ERROR_CODES.MAPPING_AMBIGUOUS,
          ERROR_CODES.UNSUPPORTED_ASSET,
        ].includes(normalized.code);
        lastError = locallyIneligible && primaryRetryableError
          ? primaryRetryableError
          : normalized;
        fallbackReason = "error";
      }
    }

    if (validEmpty) {
      const emptyTtl = ttlForNews("news", validEmpty, this.ttlPolicy);
      await this.#writeNewsCache(
        explicitKey || cacheKey("news", instrument.id),
        "news",
        instrument.id,
        validEmpty,
        {
          backgroundPersistence: true,
          ttlOverride: retryableFailureAfterEmpty
            ? {
                freshMs: NEWS_STALE_RECHECK_MS,
                staleMs: Math.max(NEWS_STALE_RECHECK_MS, emptyTtl.staleMs),
              }
            : undefined,
        },
      );
      return validEmpty;
    }
    throw lastError || new MarketDataError(
      ERROR_CODES.UNSUPPORTED_ASSET,
      `No provider supports news for ${instrument.assetClass}`,
      { capability: "news", instrumentId: instrument.id, retryable: false },
    );
  }

  async #callNewsProvider(provider, capability, operation, externalSignal) {
    const breaker = this.#breaker(provider.id, capability);
    const startedAt = this.clock();
    try {
      const result = await breaker.execute(() => this.#withTimeout(operation, externalSignal));
      this.telemetry.increment("provider_success", { provider: provider.id, capability });
      return result;
    } catch (error) {
      const normalized = asMarketError(error, { provider: provider.id, capability });
      if ([ERROR_CODES.AUTH_FAILED, ERROR_CODES.ENTITLEMENT_MISSING].includes(normalized.code)) {
        this.disabledCapabilities.set(`${provider.id}:${capability}`, {
          code: normalized.code,
          disabledAt: iso(this.clock()),
        });
      }
      this.telemetry.increment("provider_error", {
        provider: provider.id,
        capability,
        code: normalized.code,
      });
      throw normalized;
    } finally {
      this.telemetry.observe("provider_latency_ms", this.clock() - startedAt, {
        provider: provider.id,
        capability,
      });
    }
  }

  async #callProvider(provider, {
    operation,
    assetClass,
    semanticVariant = "default",
  }, request, externalSignal) {
    const quarantined = this.#quarantineFor(provider.id, operation, assetClass, semanticVariant);
    if (quarantined) {
      throw new MarketDataError(
        quarantined.code || ERROR_CODES.UPSTREAM_UNAVAILABLE,
        `${provider.id} is quarantined for ${operation}/${assetClass}`,
        {
          provider: provider.id,
          capability: operation,
          retryable: false,
          details: {
            reason: "provider_quarantined",
            scope: quarantined.scope,
          },
        },
      );
    }

    const breaker = this.#breaker(provider.id, operation, assetClass, semanticVariant);
    const startedAt = this.clock();
    try {
      const result = await breaker.execute(() => this.#withTimeout(request, externalSignal));
      this.telemetry.increment("provider_success", { provider: provider.id, capability: operation });
      this.telemetry.increment("provider_request_total", {
        provider: provider.id,
        operation,
        assetClass,
        outcome: "success",
      });
      this.logger?.debug?.({
        provider: provider.id,
        operation,
        assetClass,
        semanticVariant,
        capabilityRevision: CAPABILITY_REVISION,
        outcome: "success",
        durationMs: this.clock() - startedAt,
      });
      return result;
    } catch (error) {
      const normalized = asMarketError(error, { provider: provider.id, capability: operation });
      if (normalized.code === ERROR_CODES.AUTH_FAILED) {
        const scope = `${provider.id}:*:*:*`;
        this.disabledCapabilities.set(scope, {
          code: normalized.code,
          reason: "provider_auth_failed",
          scope,
          disabledAt: iso(this.clock()),
        });
      } else if (normalized.code === ERROR_CODES.ENTITLEMENT_MISSING) {
        const scope = `${provider.id}:${operation}:${assetClass}:*`;
        this.disabledCapabilities.set(scope, {
          code: normalized.code,
          reason: "operation_asset_entitlement_missing",
          scope,
          disabledAt: iso(this.clock()),
        });
      }
      this.telemetry.increment("provider_error", {
        provider: provider.id,
        capability: operation,
        code: normalized.code,
      });
      this.telemetry.increment("provider_request_total", {
        provider: provider.id,
        operation,
        assetClass,
        outcome: normalized.code,
      });
      if (normalized.code === ERROR_CODES.SCHEMA_INVALID) {
        this.telemetry.increment("provider_schema_invalid_total", {
          provider: provider.id,
          operation,
          assetClass,
        });
      }
      this.logger?.warn?.({
        provider: provider.id,
        operation,
        assetClass,
        semanticVariant,
        capabilityRevision: CAPABILITY_REVISION,
        outcome: "error",
        errorCode: normalized.code,
        durationMs: this.clock() - startedAt,
      });
      throw normalized;
    } finally {
      this.telemetry.observe("provider_latency_ms", this.clock() - startedAt, {
        provider: provider.id,
        capability: operation,
        assetClass,
        semanticVariant,
      });
    }
  }

  #quarantineFor(providerId, operation, assetClass, semanticVariant) {
    for (const scope of [
      `${providerId}:*:*:*`,
      `${providerId}:${operation}`,
      `${providerId}:${operation}:${assetClass}:*`,
      `${providerId}:${operation}:${assetClass}:${semanticVariant}`,
    ]) {
      const entry = this.disabledCapabilities.get(scope);
      if (entry) return { ...entry, scope: entry.scope || scope };
    }
    return null;
  }

  #supports(provider, operation, assetClass, semanticVariant, instrument = null) {
    if (this.#quarantineFor(provider.id, operation, assetClass, semanticVariant)) return false;
    const implemented = typeof provider?.[operation] === "function"
      || (operation === "quote" && typeof provider?.quoteMany === "function")
      || (operation === "details" && typeof provider?.details === "function");
    if (!implemented) return false;
    if (operation !== "details" && !supports(provider, operation, assetClass)) return false;
    return !instrument
      || typeof provider.supportsInstrument !== "function"
      || provider.supportsInstrument(operation, instrument);
  }

  #supportsNews(provider, capability, assetClass, instrument = null) {
    return !this.disabledCapabilities.has(`${provider.id}:*:*:*`)
      && !this.disabledCapabilities.has(`${provider.id}:${capability}`)
      && supports(provider, capability, assetClass)
      && (!instrument
        || typeof provider.supportsInstrument !== "function"
        || provider.supportsInstrument(capability, instrument));
  }

  async #runShared(key, operation, externalSignal) {
    if (externalSignal?.aborted) throw requestAbortedError(externalSignal.reason);
    const shared = this.singleFlight.run(key, operation);
    return this.#raceCaller(shared, externalSignal);
  }

  async #runNewsShared(key, operation, externalSignal) {
    if (externalSignal?.aborted) throw requestAbortedError(externalSignal.reason);
    let flight = this.newsFlights.get(key);
    if (!flight?.accepting) {
      const controller = new AbortController();
      flight = {
        accepting: true,
        consumers: 0,
        controller,
        settled: false,
        promise: null,
      };
      const flightKey = `${key}:consumer-flight:${++this.newsFlightSequence}`;
      flight.promise = this.singleFlight.run(flightKey, () => operation(controller.signal));
      this.newsFlights.set(key, flight);
      const settle = () => {
        flight.settled = true;
        flight.accepting = false;
        if (this.newsFlights.get(key) === flight) this.newsFlights.delete(key);
      };
      flight.promise.then(settle, settle);
    }

    flight.consumers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight.consumers = Math.max(0, flight.consumers - 1);
      if (flight.consumers === 0 && !flight.settled) {
        flight.accepting = false;
        if (this.newsFlights.get(key) === flight) this.newsFlights.delete(key);
        flight.controller.abort(new Error("No active news consumers remain"));
      }
    };

    try {
      return await this.#raceCaller(flight.promise, externalSignal);
    } finally {
      release();
    }
  }

  async #raceCaller(work, externalSignal) {
    if (externalSignal?.aborted) throw requestAbortedError(externalSignal.reason);
    if (!externalSignal) return work;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(requestAbortedError(externalSignal.reason));
      externalSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      externalSignal.removeEventListener("abort", onAbort);
    }
  }

  async #withTimeout(operation, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Provider timeout"));
    }, this.providerTimeoutMs);
    timeout.unref?.();
    const onAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const abortPromise = new Promise((_, reject) => {
        const rejectAborted = () => reject(
          timedOut
            ? new MarketDataError(ERROR_CODES.TIMEOUT, "Provider request timed out", { retryable: true })
            : requestAbortedError(controller.signal.reason),
        );
        if (controller.signal.aborted) rejectAborted();
        else controller.signal.addEventListener("abort", rejectAborted, { once: true });
      });
      return await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) return abortPromise;
          return operation(controller.signal);
        }),
        abortPromise,
      ]);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", onAbort);
    }
  }

  async #withNewsFetchBudget(operation, externalSignal) {
    if (externalSignal?.aborted) throw requestAbortedError(externalSignal.reason);
    const controller = new AbortController();
    let budgetExceeded = false;
    const timeout = setTimeout(() => {
      budgetExceeded = true;
      controller.abort(new Error("News fetch budget exceeded"));
    }, NEWS_SINGLE_FETCH_BUDGET_MS);
    timeout.unref?.();
    const onAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    const aborted = new Promise((_, reject) => {
      const rejectAborted = () => reject(
        budgetExceeded
          ? new MarketDataError(ERROR_CODES.TIMEOUT, "News request budget exceeded", {
              capability: "news",
              retryable: true,
              details: {
                reason: "news_request_budget_exceeded",
                budgetMs: NEWS_SINGLE_FETCH_BUDGET_MS,
              },
            })
          : requestAbortedError(controller.signal.reason),
      );
      if (controller.signal.aborted) rejectAborted();
      else controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", onAbort);
    }
  }

  #breaker(providerId, operation, assetClass = null, semanticVariant = null) {
    const key = [providerId, operation, assetClass, semanticVariant].filter(Boolean).join(":");
    if (!this.breakers.has(key)) {
      this.breakers.set(key, new CircuitBreaker({
        name: key,
        clock: this.clock,
        shouldCountFailure: (error) => (
          error?.details?.reason !== "empty_history"
          && (error?.code === ERROR_CODES.SCHEMA_INVALID
            || error?.retryable !== false)
        ),
        ...this.breakerOptions,
      }));
    }
    return this.breakers.get(key);
  }

  async #readCache(key, resourceType, instrumentId, variant, externalSignal) {
    const memory = this.memoryCache.read(key);
    if (memory) {
      try {
        validateCachedPayload(resourceType, memory.value, { instrumentId, variant });
        this.telemetry.increment("cache_hit", { layer: "memory", resource: `${resourceType}-market`, state: memory.state });
        return { ...memory, layer: "memory" };
      } catch (error) {
        this.memoryCache.delete(key);
        this.telemetry.increment("cache_invalid", { layer: "memory", resource: `${resourceType}-market` });
        this.logger?.warn?.({ cacheOutcome: "memory-invalid", errorCode: error?.code, resourceType: `${resourceType}-market` });
      }
    }
    this.telemetry.increment("cache_miss", { layer: "memory", resource: `${resourceType}-market` });
    if (!this.snapshotStore) return null;

    let record;
    try {
      record = await this.#withPersistenceTimeout(() => this.snapshotStore.get(key), externalSignal);
      this.persistenceHealthy = true;
    } catch (error) {
      if (error?.details?.reason === "request_aborted") throw error;
      this.persistenceHealthy = false;
      this.telemetry.increment("persistence_error", { operation: "get-market" });
      return null;
    }
    if (!record) {
      this.telemetry.increment("cache_miss", { layer: "persistent", resource: `${resourceType}-market` });
      return null;
    }

    try {
      if (record.schemaVersion !== MARKET_SCHEMA_VERSION
        || record.cacheKey !== key
        || record.resourceType !== `v2_${resourceType}`
        || record.instrumentId !== instrumentId
        || record.payloadHash !== payloadHash(record.payload)) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent cache metadata does not match");
      }
      validateCachedPayload(resourceType, record.payload, { instrumentId, variant });
      const origin = Date.parse(record.lastSuccessAt || record.fetchedAt);
      const freshUntil = Date.parse(record.freshUntil);
      const staleUntil = Date.parse(record.staleUntil);
      if (![origin, freshUntil, staleUntil].every(Number.isFinite)
        || staleUntil < freshUntil
        || origin > freshUntil) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent cache deadlines are invalid");
      }
      const now = this.clock();
      if (now > staleUntil) {
        await this.#withPersistenceTimeout(() => this.snapshotStore.delete(key), externalSignal);
        return null;
      }
      this.memoryCache.set(key, record.payload, {
        now: origin,
        freshTtlMs: Math.max(0, freshUntil - origin),
        staleTtlMs: Math.max(0, staleUntil - origin),
      });
      const state = now < freshUntil ? "fresh" : "stale";
      this.telemetry.increment("cache_hit", { layer: "persistent", resource: `${resourceType}-market`, state });
      return {
        value: clone(record.payload),
        state,
        ageMs: Math.max(0, now - origin),
        storedAt: origin,
        freshUntil,
        staleUntil,
        layer: "persistent",
      };
    } catch (error) {
      this.telemetry.increment("cache_invalid", { layer: "persistent", resource: `${resourceType}-market` });
      this.logger?.warn?.({ cacheOutcome: "persistent-invalid", errorCode: error?.code, resourceType: `${resourceType}-market` });
      try {
        await this.#withPersistenceTimeout(() => this.snapshotStore.delete(key), externalSignal);
      } catch {}
      return null;
    }
  }

  async #writeCache(key, resourceType, instrumentId, payload, { ttl, variant = null } = {}) {
    validateCachedPayload(resourceType, payload, { instrumentId, variant });
    const now = this.clock();
    const resolvedTtl = ttl || ttlFor(resourceType, payload, this.ttlPolicy);
    this.memoryCache.set(key, payload, {
      freshTtlMs: resolvedTtl.freshMs,
      staleTtlMs: resolvedTtl.staleMs,
    });
    if (!this.snapshotStore) return;
    try {
      await this.#withPersistenceTimeout(() => this.snapshotStore.set({
        cacheKey: key,
        instrumentId,
        resourceType: `v2_${resourceType}`,
        provider: payload.provenance.source,
        payload,
        sourceAsOf: payload.asOf,
        fetchedAt: payload.fetchedAt,
        freshUntil: iso(now + resolvedTtl.freshMs),
        staleUntil: iso(now + resolvedTtl.staleMs),
        schemaVersion: MARKET_SCHEMA_VERSION,
        payloadHash: payloadHash(payload),
        lastSuccessAt: iso(now),
      }));
      this.persistenceHealthy = true;
    } catch (error) {
      this.persistenceHealthy = false;
      this.telemetry.increment("persistence_error", { operation: "set-market" });
      this.logger?.warn?.({ cacheOutcome: "persistent-error", errorCode: error?.code, resourceType: `${resourceType}-market` });
    }
  }

  async #readNewsCache(key, resourceType, instrumentId, variant, externalSignal) {
    const memory = this.memoryCache.read(key);
    if (memory) {
      try {
        const now = this.clock();
        validateCachedNewsFeed(resourceType, memory.value, { instrumentId, variant, now });
        const pruned = resourceType === "news"
          ? pruneCachedNewsFeed(memory.value, now)
          : { value: memory.value, becameEmpty: false };
        const deadlines = capPrunedNewsDeadlines({
          becameEmpty: pruned.becameEmpty,
          freshUntil: memory.freshUntil,
          origin: memory.storedAt,
          staleUntil: memory.staleUntil,
          ttlPolicy: this.ttlPolicy,
        });
        if (now > deadlines.staleUntil) {
          this.memoryCache.delete(key);
        } else {
          const state = now < deadlines.freshUntil ? "fresh" : "stale";
          if (
            pruned.value !== memory.value
            || deadlines.freshUntil !== memory.freshUntil
            || deadlines.staleUntil !== memory.staleUntil
          ) {
            this.memoryCache.set(key, pruned.value, {
              now: memory.storedAt,
              freshTtlMs: Math.max(0, deadlines.freshUntil - memory.storedAt),
              staleTtlMs: Math.max(0, deadlines.staleUntil - memory.storedAt),
            });
          }
          this.telemetry.increment("cache_hit", { layer: "memory", resource: resourceType, state });
          return {
            ...memory,
            value: pruned.value,
            state,
            freshUntil: deadlines.freshUntil,
            staleUntil: deadlines.staleUntil,
            layer: "memory",
          };
        }
      } catch (error) {
        this.memoryCache.delete(key);
        this.telemetry.increment("cache_invalid", { layer: "memory", resource: resourceType });
        this.logger?.warn?.({ cacheOutcome: "memory-invalid", errorCode: error?.code, resourceType });
      }
    }
    this.telemetry.increment("cache_miss", { layer: "memory", resource: resourceType });
    if (!this.snapshotStore) return null;
    let record;
    const persistenceTimeoutMs = resourceType === "news"
      ? Math.min(this.persistenceTimeoutMs, NEWS_PERSISTENCE_READ_TIMEOUT_MS)
      : this.persistenceTimeoutMs;
    try {
      record = await this.#withPersistenceTimeout(
        () => this.snapshotStore.get(key),
        externalSignal,
        persistenceTimeoutMs,
      );
      this.persistenceHealthy = true;
    } catch (error) {
      if (error?.details?.reason === "request_aborted") throw error;
      this.persistenceHealthy = false;
      this.telemetry.increment("persistence_error", { operation: "get" });
      this.logger?.warn?.({ cacheOutcome: "persistent-error", errorCode: error?.code, resourceType });
      return null;
    }
    if (!record) {
      this.telemetry.increment("cache_miss", { layer: "persistent", resource: resourceType });
      return null;
    }

    let freshUntil;
    let staleUntil;
    let cachedPayload;
    let cacheOrigin;
    const now = this.clock();
    try {
      if (
        record.schemaVersion !== SCHEMA_VERSION
        || record.cacheKey !== key
        || record.resourceType !== resourceType
        || record.instrumentId !== instrumentId
      ) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent snapshot metadata does not match request");
      }
      if (record.payloadHash !== payloadHash(record.payload)) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent snapshot payload hash does not match");
      }
      validateCachedNewsFeed(resourceType, record.payload, { instrumentId, variant, now });
      freshUntil = Date.parse(record.freshUntil);
      staleUntil = Date.parse(record.staleUntil);
      if (!Number.isFinite(freshUntil) || !Number.isFinite(staleUntil) || staleUntil < freshUntil) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent snapshot TTL metadata is invalid");
      }
      const pruned = resourceType === "news"
        ? pruneCachedNewsFeed(record.payload, now)
        : { value: record.payload, becameEmpty: false };
      cachedPayload = pruned.value;
      cacheOrigin = Date.parse(record.lastSuccessAt || record.fetchedAt);
      if (!Number.isFinite(cacheOrigin)) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent snapshot origin is invalid");
      }
      if (cacheOrigin > freshUntil) {
        throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Persistent snapshot origin exceeds its freshness deadline");
      }
      const deadlines = capPrunedNewsDeadlines({
        becameEmpty: pruned.becameEmpty,
        freshUntil,
        origin: cacheOrigin,
        staleUntil,
        ttlPolicy: this.ttlPolicy,
      });
      freshUntil = deadlines.freshUntil;
      staleUntil = deadlines.staleUntil;
    } catch (error) {
      this.telemetry.increment("cache_invalid", { layer: "persistent", resource: resourceType });
      this.logger?.warn?.({ cacheOutcome: "persistent-invalid", errorCode: error?.code, resourceType });
      try {
        await this.#withPersistenceTimeout(
          () => this.snapshotStore.delete(key),
          externalSignal,
          persistenceTimeoutMs,
        );
      } catch (deleteError) {
        if (deleteError?.details?.reason === "request_aborted") throw deleteError;
        this.persistenceHealthy = false;
        this.telemetry.increment("persistence_error", { operation: "delete" });
      }
      return null;
    }

    if (now > staleUntil) {
      try {
        await this.#withPersistenceTimeout(
          () => this.snapshotStore.delete(key),
          externalSignal,
          persistenceTimeoutMs,
        );
      } catch (error) {
        if (error?.details?.reason === "request_aborted") throw error;
        this.persistenceHealthy = false;
        this.telemetry.increment("persistence_error", { operation: "delete" });
      }
      this.telemetry.increment("cache_miss", { layer: "persistent", resource: resourceType });
      return null;
    }
    const state = now < freshUntil ? "fresh" : "stale";
    this.memoryCache.set(key, cachedPayload, {
      now: cacheOrigin,
      freshTtlMs: Math.max(0, freshUntil - cacheOrigin),
      staleTtlMs: Math.max(0, staleUntil - cacheOrigin),
    });
    this.telemetry.increment("cache_hit", { layer: "persistent", resource: resourceType, state });
    return {
      value: clone(cachedPayload),
      state,
      ageMs: Math.max(0, now - Date.parse(record.fetchedAt)),
      freshUntil,
      staleUntil,
      layer: "persistent",
    };
  }

  async #writeNewsCache(key, resourceType, instrumentId, payload, {
    backgroundPersistence = false,
    ttlOverride,
  } = {}) {
    const now = this.clock();
    const ttl = ttlOverride || ttlForNews(resourceType, payload, this.ttlPolicy);
    validateCachedNewsFeed(resourceType, payload, {
      instrumentId,
      variant: resourceType === "history" ? `${payload.range}:${payload.interval}` : null,
      now,
    });
    this.memoryCache.set(key, payload, { freshTtlMs: ttl.freshMs, staleTtlMs: ttl.staleMs });
    if (!this.snapshotStore) return;
    const persist = async () => {
      try {
        await this.#withPersistenceTimeout(() => this.snapshotStore.set({
          cacheKey: key,
          instrumentId,
          resourceType,
          provider: payload.source || "mixed",
          payload,
          sourceAsOf: payload.asOf || payload.fetchedAt || iso(now),
          fetchedAt: payload.fetchedAt || iso(now),
          freshUntil: iso(now + ttl.freshMs),
          staleUntil: iso(now + ttl.staleMs),
          schemaVersion: SCHEMA_VERSION,
          payloadHash: payloadHash(payload),
          lastSuccessAt: iso(now),
        }));
        this.persistenceHealthy = true;
      } catch (error) {
        this.persistenceHealthy = false;
        this.telemetry.increment("persistence_error", { operation: "set" });
        this.logger?.warn?.({ cacheOutcome: "persistent-error", errorCode: error?.code, resourceType });
      }
    };
    if (backgroundPersistence) {
      void persist();
      return;
    }
    await persist();
  }

  async #withPersistenceTimeout(operation, externalSignal, timeoutMs = this.persistenceTimeoutMs) {
    if (externalSignal?.aborted) throw requestAbortedError(externalSignal.reason);
    let timeout;
    let onAbort;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(persistenceTimeoutError(timeoutMs)), timeoutMs);
    });
    const aborted = externalSignal && new Promise((_, reject) => {
      onAbort = () => reject(requestAbortedError(externalSignal.reason));
      externalSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        timedOut,
        ...(aborted ? [aborted] : []),
      ]);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", onAbort);
    }
  }
}
