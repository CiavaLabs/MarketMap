import { randomUUID } from "node:crypto";
import { ERROR_CODES } from "../contracts/core/constants.js";
import {
  MARKET_ASSET_CLASSES as CURRENT_ASSET_CLASSES,
  CAPABILITY_REVISION,
  DETAIL_SECTIONS,
  MAX_BATCH_IDS,
  MAX_SEARCH_RESULTS,
  PRICE_BASES,
  SEARCH_HYDRATION_LIMIT,
  MARKET_SCHEMA_VERSION as CURRENT_SCHEMA_VERSION,
} from "../contracts/market/constants.js";
import {
  HISTORY_ALLOWLIST,
  HISTORY_DEFAULT_INTERVALS,
} from "../contracts/core/history.js";
import {
  NEWS_BATCH_MAX_LIMIT,
  NEWS_BOARD_DEFAULT_LIMIT,
  NEWS_INSTRUMENT_DEFAULT_LIMIT,
  NEWS_PROVIDER_LIMIT,
} from "../contracts/core/news.js";
import { normalizeEnabledAssetClasses } from "../instruments/assetPolicies.js";
import { YAHOO_CAPABILITY_MANIFEST } from "../providers/yahoo/capabilityManifest.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "../providers/finnhub/capabilityManifest.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import { RequestQuota, quotaExceeded } from "./RequestQuota.js";
import {
  errorRetryAfterSeconds,
  invalid,
  jsonResponse,
  normalizeBasePath,
  normalizeServiceResult,
  problemResponse,
  resolveRequestId,
  splitIds,
  validateInstrumentId,
} from "./shared.js";

const API_VERSION = "v1";
const API_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
const API_SEMANTIC_REVISION = "market-data@1";
const MARKET_API_BASE_PATH = "/api/market/v1";
const MANIFESTS = Object.freeze([YAHOO_CAPABILITY_MANIFEST, FINNHUB_CAPABILITY_MANIFEST]);
const API_TELEMETRY_ENDPOINTS = new Set([
  "health",
  "snapshot",
  "history-batch",
  "news-batch",
  "search",
  "instrument",
  "history",
  "details",
  "news",
  "analytics-snapshot",
]);
const ENDPOINT_BY_PATH = Object.freeze({
  "/health": "health",
  "/snapshot": "snapshot",
  "/history": "history-batch",
  "/news": "news-batch",
  "/instruments/search": "search",
  "/analytics/snapshot": "analytics-snapshot",
});
const ANALYTICS_MAX_BATCH_IDS = 40;

const SERVICE_METHOD_BY_OPERATION = Object.freeze({
  health: "getHealth",
  snapshot: "getSnapshot",
  history: "getHistory",
  "history-batch": "getHistoryBatch",
  details: "getDetails",
  news: "getNews",
  "news-batch": "getNewsBatch",
  "analytics-snapshot": "getAnalyticsSnapshot",
});
const RESOLVER_OPERATIONS = Object.freeze(["instrument", "search"]);

const ENDPOINT_UPSTREAM_COST = Object.freeze({
  health: 1,
  search: SEARCH_HYDRATION_LIMIT,
  instrument: 2,
  details: 3,
  history: 3,
  news: 2,
});

const DEAREST_ENDPOINT = Math.max(...Object.values(ENDPOINT_UPSTREAM_COST));

function resolveQuota(configuration, maxBatchIds) {
  if (!configuration) return null;
  const { clientKey, quota, ...options } = configuration;
  if (typeof clientKey !== "function") {
    throw new TypeError("quota.clientKey must be a function: only the host can identify a caller");
  }
  const bucket = quota || new RequestQuota(options);
  const dearest = Math.max(maxBatchIds, DEAREST_ENDPOINT);
  if (bucket.limit < dearest) {
    throw new RangeError(
      `quota.limit is ${bucket.limit} and one request may cost ${dearest} instruments of `
      + "upstream work, which no caller could ever afford. Raise the limit or lower maxBatchIds.",
    );
  }
  return { clientKey, quota: bucket };
}

function quotaClientKey(resolve, request) {
  let key;
  try {
    key = resolve(request);
  } catch (cause) {
    throw new MarketDataError(ERROR_CODES.INTERNAL_ERROR, "Client identification failed", {
      retryable: false,
      cause,
    });
  }
  if (key === null || key === undefined) return null;
  if (typeof key !== "string" && typeof key !== "number") {
    throw new MarketDataError(ERROR_CODES.INTERNAL_ERROR, "Client identification failed", {
      retryable: false,
      details: { reason: "client_key_not_scalar" },
    });
  }
  return String(key);
}

function implementedCapabilities(service, resolver) {
  const operations = Object.entries(SERVICE_METHOD_BY_OPERATION)
    .filter(([, method]) => typeof service?.[method] === "function")
    .map(([operation]) => operation);
  if (resolver) operations.push(...RESOLVER_OPERATIONS);
  return operations.sort();
}

function healthSummary(health) {
  return {
    status: health?.status ?? "unknown",
    providers: Object.fromEntries(Object.entries(health?.providers || {})
      .map(([id, provider]) => [id, { enabled: Boolean(provider?.enabled) }])),
    persistence: { enabled: Boolean(health?.persistence?.enabled) },
  };
}

function telemetryEndpoint(operation, relativePath) {
  if (API_TELEMETRY_ENDPOINTS.has(operation)) return operation;
  if (typeof relativePath !== "string") return "not-found";
  if (ENDPOINT_BY_PATH[relativePath]) return ENDPOINT_BY_PATH[relativePath];
  const route = relativePath.match(/^\/instruments\/[^/]+(?:\/(history|details|news))?$/);
  return route ? route[1] || "instrument" : "not-found";
}

function notImplemented(operation, plannedTranche) {
  return new MarketDataError(ERROR_CODES.NOT_IMPLEMENTED, `Market API ${operation} is not implemented yet`, {
    retryable: false,
    capability: operation,
    details: { operation, plannedTranche },
  });
}

function parseNewsLimit(searchParams, { defaultValue, maximum }) {
  const raw = searchParams.get("limit");
  if (raw === null) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw invalid(`limit must be an integer between 1 and ${maximum}`, { field: "limit" });
  }
  return value;
}

function limitNews(result, limit) {
  const normalized = normalizeServiceResult(result);
  if (!normalized.data || !Array.isArray(normalized.data.articles)) return normalized;
  return {
    ...normalized,
    data: {
      ...normalized.data,
      articles: normalized.data.articles.slice(0, limit),
    },
  };
}

function parseBatchIds(searchParams, operation, maxBatchIds = MAX_BATCH_IDS) {
  const ids = splitIds(searchParams);
  if (!ids.length || ids.length > maxBatchIds) {
    throw invalid(`${operation} requires between 1 and ${maxBatchIds} unique ids`, {
      field: "ids",
      maxBatchIds,
    });
  }
  ids.forEach(validateInstrumentId);
  return ids;
}

function parseHistoryOptions(searchParams) {
  const range = searchParams.get("range") || "1d";
  const interval = searchParams.get("interval") || HISTORY_DEFAULT_INTERVALS[range];
  if (!HISTORY_ALLOWLIST[range] || !HISTORY_ALLOWLIST[range].includes(interval)) {
    throw invalid("Unsupported history range and interval combination", {
      field: "range/interval",
      range,
      interval,
      allowed: HISTORY_ALLOWLIST,
    });
  }
  const priceBasis = searchParams.get("priceBasis") || "raw";
  if (!PRICE_BASES.includes(priceBasis)) {
    throw new MarketDataError(ERROR_CODES.UNSUPPORTED_SEMANTICS, "Requested price basis is not supported", {
      retryable: false,
      details: { requestedPriceBasis: priceBasis, availablePriceBases: PRICE_BASES },
    });
  }
  const includePrePost = searchParams.get("includePrePost");
  if (includePrePost !== null && includePrePost !== "true" && includePrePost !== "false") {
    throw invalid("includePrePost must be true or false", { field: "includePrePost" });
  }
  return { range, interval, priceBasis, includePrePost: includePrePost === "true" };
}

function parseSearchOptions(searchParams) {
  const query = (searchParams.get("q") || "").trim();
  if (query.length < 2 || query.length > 80) {
    throw invalid("q must contain between 2 and 80 characters", { field: "q" });
  }
  const assetClasses = [...new Set(searchParams.getAll("assetClass")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
  for (const assetClass of assetClasses) {
    if (!CURRENT_ASSET_CLASSES.includes(assetClass)) {
      throw invalid("assetClass is not supported", {
        field: "assetClass",
        allowed: CURRENT_ASSET_CLASSES,
      });
    }
  }
  const currency = searchParams.get("currency") || undefined;
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) {
    throw invalid("currency must be a three-letter code", { field: "currency" });
  }
  const venue = searchParams.get("venue") || searchParams.get("mic") || undefined;
  if (venue && (venue.length > 32 || !/^[A-Za-z0-9 ._-]+$/.test(venue))) {
    throw invalid("venue must be a valid venue name or MIC", { field: "venue" });
  }
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? MAX_SEARCH_RESULTS : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw invalid(`limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}`, { field: "limit" });
  }
  const includeUnsupported = searchParams.get("includeUnsupported");
  if (includeUnsupported !== null && includeUnsupported !== "true" && includeUnsupported !== "false") {
    throw invalid("includeUnsupported must be true or false", { field: "includeUnsupported" });
  }
  return {
    query,
    assetClasses,
    currency: currency?.toUpperCase(),
    venue,
    limit,
    includeUnsupported: includeUnsupported === "true",
  };
}

function matchInstrumentRoute(relativePath) {
  const match = relativePath.match(/^\/instruments\/([^/]+)(?:\/(history|details|news))?$/);
  if (!match || match[1] === "search") return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw invalid("Instrument ID is not valid URL encoding", { field: "id" });
  }
  return { id: validateInstrumentId(id), resource: match[2] || "instrument" };
}

function serializeItemError(error, operation) {
  const item = error instanceof MarketDataError
    ? error
    : MarketDataError.from(error, { code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
  return {
    instrumentId: item.instrumentId,
    operation,
    assetClass: item.details?.assetClass || null,
    code: item.code,
    reason: item.details?.reason || item.code,
    message: item.message,
    retryable: item.retryable,
  };
}

function responseHeaders(requestId, nextRefreshAt = null) {
  return {
    "x-request-id": requestId,
    ...(nextRefreshAt ? { "x-next-refresh-at": nextRefreshAt } : {}),
  };
}

function retryAfterHeader(errors) {
  const seconds = (errors || [])
    .map(errorRetryAfterSeconds)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return seconds.length ? { "retry-after": String(Math.ceil(Math.min(...seconds))) } : {};
}

export function createMarketDataHandler({
  service,
  resolver = null,
  basePath = MARKET_API_BASE_PATH,
  clock = () => Date.now(),
  requestIdFactory = randomUUID,
  logger = null,
  telemetry = null,
  enabledAssetClasses,
  maxBatchIds = MAX_BATCH_IDS,
  quota: quotaConfiguration = null,
  exposeHealthInternals = false,
} = {}) {
  if (!service || typeof service !== "object") {
    throw new TypeError("createMarketDataHandler requires a service");
  }
  const normalizedBase = normalizeBasePath(basePath, MARKET_API_BASE_PATH);
  const enabled = normalizeEnabledAssetClasses(enabledAssetClasses);
  if (!Number.isInteger(maxBatchIds) || maxBatchIds < 1 || maxBatchIds > 1_000) {
    throw new RangeError("maxBatchIds must be an integer between 1 and 1000");
  }
  const quota = resolveQuota(quotaConfiguration, maxBatchIds);
  const recordRequest = (endpoint, outcome) => {
    telemetry?.increment?.("v1_request", { endpoint, outcome });
    telemetry?.increment?.("api_request_total", {
      apiVersion: API_VERSION,
      endpoint,
      outcome,
    });
  };

  const meta = (requestId) => ({
    apiVersion: API_VERSION,
    schemaVersion: API_SCHEMA_VERSION,
    semanticRevision: API_SEMANTIC_REVISION,
    capabilityRevision: CAPABILITY_REVISION,
    requestId,
    generatedAt: new Date(clock()).toISOString(),
  });

  return async function handleMarketDataRequest(request) {
    const startedAt = clock();
    const requestId = resolveRequestId(request, requestIdFactory);
    const url = new URL(request.url);
    const isApiPath = url.pathname === normalizedBase || url.pathname.startsWith(`${normalizedBase}/`);
    const relativePath = isApiPath
      ? url.pathname.slice(normalizedBase.length) || "/"
      : null;
    let operation = relativePath;
    const finish = (endpoint, response, outcome = "ok") => {
      recordRequest(endpoint, outcome);
      logger?.info?.({
        requestId,
        endpoint: `v1:${endpoint}`,
        durationMs: clock() - startedAt,
        status: response.status,
      });
      return response;
    };

    try {
      if (relativePath === null) {
        throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Market API route not found", {
          status: 404,
          retryable: false,
        });
      }
      if (request.method !== "GET") {
        throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Only GET is supported by market API v1", {
          status: 405,
          retryable: false,
        });
      }

      const endpoint = telemetryEndpoint(operation, relativePath);
      const clientKey = quota && endpoint !== "not-found"
        ? quotaClientKey(quota.clientKey, request)
        : null;
      let spent = 0;
      const charge = (cost) => {
        if (clientKey === null || cost < 1) return;
        const verdict = quota.quota.consume(clientKey, cost);
        if (verdict.allowed) {
          spent += cost;
          return;
        }
        if (spent) quota.quota.refund(clientKey, spent);
        telemetry?.increment?.("quota_rejected_total", { endpoint });
        throw quotaExceeded(verdict.retryAfterMs);
      };
      const chargeBatch = (ids) => charge(ids.length - 1);
      charge(ENDPOINT_UPSTREAM_COST[endpoint] ?? 1);

      if (relativePath === "/health") {
        operation = "health";
        if (typeof service.getHealth !== "function") throw notImplemented("health", "tranche-1");
        const health = await service.getHealth();
        const response = jsonResponse({
          data: {
            ...(exposeHealthInternals ? health : healthSummary(health)),
            capabilities: implementedCapabilities(service, resolver),
            enabledAssetClasses: [...enabled],
            maxBatchIds,
            manifests: Object.fromEntries(MANIFESTS.map((manifest) => [
              manifest.provider,
              { manifestVersion: manifest.manifestVersion },
            ])),
          },
          meta: meta(requestId),
        }, { request, headers: { "x-request-id": requestId } });
        return finish(operation, response);
      }

      if (relativePath === "/snapshot") {
        operation = "snapshot";
        const ids = parseBatchIds(url.searchParams, "snapshot", maxBatchIds);
        if (typeof service.getSnapshot !== "function") throw notImplemented("snapshot", "tranche-2");
        chargeBatch(ids);
        const result = await service.getSnapshot(ids, { signal: request.signal });
        const payload = {
          data: result.data,
          ...(result.errors?.length
            ? { errors: result.errors.map((error) => serializeItemError(error, "quote")) }
            : {}),
          ...(result.sources ? { sources: result.sources } : {}),
          meta: {
            ...meta(requestId),
            nextRefreshAt: result.nextRefreshAt || null,
            descriptorRevision: result.descriptorRevision || 1,
          },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: { data: payload.data, errors: payload.errors, descriptorRevision: payload.meta.descriptorRevision },
          headers: responseHeaders(requestId, payload.meta.nextRefreshAt),
        });
        return finish(operation, response, result.errors?.length ? "partial" : "ok");
      }
      if (relativePath === "/history") {
        operation = "history-batch";
        const ids = parseBatchIds(url.searchParams, "history", maxBatchIds);
        const historyOptions = parseHistoryOptions(url.searchParams);
        if (typeof service.getHistoryBatch !== "function") throw notImplemented("history-batch", "tranche-3");
        chargeBatch(ids);
        const result = await service.getHistoryBatch(ids, {
          ...historyOptions,
          signal: request.signal,
        });
        const payload = {
          data: result.data,
          ...(result.errors?.length
            ? { errors: result.errors.map((error) => serializeItemError(error, "history")) }
            : {}),
          ...(result.sources ? { sources: result.sources } : {}),
          meta: { ...meta(requestId), nextRefreshAt: result.nextRefreshAt || null },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: { data: payload.data, errors: payload.errors },
          headers: responseHeaders(requestId, payload.meta.nextRefreshAt),
        });
        return finish(operation, response, result.errors?.length ? "partial" : "ok");
      }
      if (relativePath === "/news") {
        operation = "news-batch";
        const ids = parseBatchIds(url.searchParams, "news", maxBatchIds);
        const limit = parseNewsLimit(url.searchParams, {
          defaultValue: NEWS_BOARD_DEFAULT_LIMIT,
          maximum: NEWS_BATCH_MAX_LIMIT,
        });
        if (typeof service.getNewsBatch !== "function") throw notImplemented("news-batch", "news");
        chargeBatch(ids);
        const normalized = limitNews(await service.getNewsBatch(ids, {
          limit,
          signal: request.signal,
        }), limit);
        const hasLastUpdatedAt = Object.hasOwn(normalized, "lastUpdatedAt");
        const payload = {
          data: normalized.data,
          ...(normalized.errors?.length
            ? { errors: normalized.errors.map((error) => serializeItemError(error, "news")) }
            : {}),
          ...(normalized.sources ? { sources: normalized.sources } : {}),
          meta: {
            ...meta(requestId),
            nextRefreshAt: normalized.nextRefreshAt || null,
            ...(hasLastUpdatedAt ? { lastUpdatedAt: normalized.lastUpdatedAt } : {}),
          },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: {
            data: payload.data,
            errors: payload.errors,
            sources: payload.sources,
            ...(hasLastUpdatedAt ? { lastUpdatedAt: payload.meta.lastUpdatedAt } : {}),
          },
          headers: {
            ...responseHeaders(requestId, payload.meta.nextRefreshAt),
            ...retryAfterHeader(normalized.errors),
          },
        });
        return finish(operation, response, normalized.errors?.length ? "partial" : "ok");
      }
      if (relativePath === "/analytics/snapshot") {
        operation = "analytics-snapshot";
        const ids = parseBatchIds(
          url.searchParams,
          "analytics snapshot",
          Math.min(maxBatchIds, ANALYTICS_MAX_BATCH_IDS),
        );
        if (typeof service.getAnalyticsSnapshot !== "function") {
          throw notImplemented("analytics-snapshot", "tranche-d");
        }
        chargeBatch(ids);
        const result = await service.getAnalyticsSnapshot(ids, { signal: request.signal });
        const payload = {
          data: result.data,
          ...(result.errors?.length
            ? { errors: result.errors.map((error) => serializeItemError(error, "analytics")) }
            : {}),
          meta: meta(requestId),
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: { data: payload.data, errors: payload.errors },
          headers: responseHeaders(requestId),
        });
        return finish(operation, response, result.errors?.length ? "partial" : "ok");
      }
      if (relativePath === "/instruments/search") {
        operation = "search";
        const searchOptions = parseSearchOptions(url.searchParams);
        if (!resolver) throw notImplemented("search", "tranche-1");
        const results = await resolver.searchInstruments(searchOptions.query, {
          assetClasses: searchOptions.assetClasses,
          currency: searchOptions.currency,
          venue: searchOptions.venue,
          limit: searchOptions.limit,
          includeUnsupported: searchOptions.includeUnsupported,
          signal: request.signal,
        });
        const response = jsonResponse(
          { data: results, meta: meta(requestId) },
          { request, etagValue: { data: results }, headers: { "x-request-id": requestId } },
        );
        return finish(operation, response);
      }

      const route = matchInstrumentRoute(relativePath);
      if (!route) {
        throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Market API route not found", {
          status: 404,
          retryable: false,
        });
      }
      operation = route.resource;
      if (route.resource === "history") {
        const historyOptions = parseHistoryOptions(url.searchParams);
        if (typeof service.getHistory !== "function") throw notImplemented("history", "tranche-3");
        const result = await service.getHistory(route.id, {
          ...historyOptions,
          signal: request.signal,
        });
        const payload = {
          data: result.data,
          ...(result.sources ? { sources: result.sources } : {}),
          meta: { ...meta(requestId), nextRefreshAt: result.nextRefreshAt || null },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: { data: payload.data },
          headers: responseHeaders(requestId, payload.meta.nextRefreshAt),
        });
        return finish(operation, response);
      }
      if (route.resource === "details") {
        if (typeof service.getDetails !== "function") throw notImplemented("details", "tranche-4");
        const sections = [...new Set(url.searchParams.getAll("section")
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter(Boolean))];
        if (sections.some((section) => !DETAIL_SECTIONS.includes(section))) {
          throw invalid("section is not a recognized details section", {
            field: "section",
            allowed: DETAIL_SECTIONS,
          });
        }
        const result = await service.getDetails(route.id, {
          sections,
          signal: request.signal,
        });
        const payload = {
          data: result.data,
          ...(result.sources ? { sources: result.sources } : {}),
          meta: { ...meta(requestId), nextRefreshAt: result.nextRefreshAt || null },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: { data: payload.data },
          headers: responseHeaders(requestId, payload.meta.nextRefreshAt),
        });
        return finish(operation, response);
      }
      if (route.resource === "news") {
        const limit = parseNewsLimit(url.searchParams, {
          defaultValue: NEWS_INSTRUMENT_DEFAULT_LIMIT,
          maximum: NEWS_PROVIDER_LIMIT,
        });
        if (typeof service.getNews !== "function") throw notImplemented("news", "news");
        const normalized = limitNews(await service.getNews(route.id, {
          limit,
          signal: request.signal,
        }), limit);
        const hasLastUpdatedAt = Object.hasOwn(normalized, "lastUpdatedAt");
        const payload = {
          data: normalized.data,
          ...(normalized.sources ? { sources: normalized.sources } : {}),
          meta: {
            ...meta(requestId),
            nextRefreshAt: normalized.nextRefreshAt || null,
            ...(hasLastUpdatedAt ? { lastUpdatedAt: normalized.lastUpdatedAt } : {}),
          },
        };
        const response = jsonResponse(payload, {
          request,
          etagValue: {
            data: payload.data,
            sources: payload.sources,
            ...(hasLastUpdatedAt ? { lastUpdatedAt: payload.meta.lastUpdatedAt } : {}),
          },
          headers: responseHeaders(requestId, payload.meta.nextRefreshAt),
        });
        return finish(operation, response);
      }
      if (!resolver) throw notImplemented("instrument", "tranche-1");
      const hint = url.searchParams.get("providerSymbol");
      if (hint !== null && !/^[A-Za-z0-9^.=_-]{1,24}$/.test(hint)) {
        throw invalid("providerSymbol hint is not a valid provider symbol", { field: "providerSymbol" });
      }
      const instrument = await resolver.getDescriptor(route.id, {
        hints: hint ? { yahoo: { symbol: hint } } : undefined,
        signal: request.signal,
      });
      const payload = {
        instrument,
        capabilities: resolver.capabilitiesFor(instrument),
        ...resolver.isAddable(instrument),
      };
      const response = jsonResponse(
        { data: payload, meta: meta(requestId) },
        { request, etagValue: { data: payload }, headers: { "x-request-id": requestId } },
      );
      return finish(operation, response);
    } catch (error) {
      const response = problemResponse(error, { request, requestId });
      const endpoint = telemetryEndpoint(operation, relativePath);
      recordRequest(
        endpoint,
        error?.code === ERROR_CODES.NOT_IMPLEMENTED ? "not-implemented" : "error",
      );
      const log = error?.code === ERROR_CODES.NOT_IMPLEMENTED ? logger?.info : logger?.error;
      log?.call(logger, {
        requestId,
        endpoint: `v1:${endpoint}`,
        durationMs: clock() - startedAt,
        status: response.status,
        errorCode: error?.code || ERROR_CODES.INTERNAL_ERROR,
      });
      return response;
    }
  };
}

export const PROVIDER_CAPABILITY_MANIFESTS = MANIFESTS;
