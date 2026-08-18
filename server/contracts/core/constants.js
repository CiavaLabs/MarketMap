export const API_VERSION = "v1";
export const SCHEMA_VERSION = 1;
export const MAX_MARKET_IDS = 40;
export const CANONICAL_INSTRUMENT_ID_PATTERN = /^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/;

export const ASSET_CLASSES = Object.freeze([
  "equity",
  "etf",
  "mutual_fund",
  "index",
  "fx",
  "crypto",
  "commodity_future",
  "commodity_proxy",
  "rate_index",
  "bond",
]);

export const INSTRUMENT_STATUSES = Object.freeze([
  "active",
  "delisted",
  "unknown",
]);

export const MARKET_STATES = Object.freeze([
  "pre",
  "regular",
  "post",
  "closed",
  "unknown",
]);

export const DATA_QUALITIES = Object.freeze([
  "fresh",
  "delayed",
  "stale",
  "unavailable",
]);

export const METRIC_QUALITIES = Object.freeze([
  "fresh",
  "stale",
  "unavailable",
]);

export const PROVIDER_SOURCES = Object.freeze([
  "yahoo",
  "finnhub",
  "last-known-good",
]);

export const METRIC_SOURCES = Object.freeze([
  ...PROVIDER_SOURCES,
  "derived",
]);

export const METRIC_UNITS = Object.freeze([
  "currency",
  "percent",
  "ratio",
  "count",
  "bps",
  "date",
  "text",
]);

export const METRIC_PERIODS = Object.freeze([
  "instant",
  "ttm",
  "fy",
  "quarter",
  "1d",
  "1m",
  "ytd",
  "1y",
]);

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  TIMEOUT: "timeout",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  AUTH_FAILED: "auth_failed",
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
  SCHEMA_INVALID: "schema_invalid",
  INSTRUMENT_NOT_FOUND: "instrument_not_found",
  UNSUPPORTED_ASSET: "unsupported_asset",
  ENTITLEMENT_MISSING: "entitlement_missing",
  MAPPING_AMBIGUOUS: "mapping_ambiguous",
  PERSISTENCE_UNAVAILABLE: "persistence_unavailable",
  INTERNAL_ERROR: "internal_error",
  UNSUPPORTED_SEMANTICS: "unsupported_semantics",
  NOT_IMPLEMENTED: "not_implemented",
});

export const ERROR_CODE_VALUES = Object.freeze(Object.values(ERROR_CODES));

export function isMarketDataErrorCode(value) {
  return ERROR_CODE_VALUES.includes(value);
}
