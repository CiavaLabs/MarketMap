export const MARKET_SCHEMA_VERSION = 2;
export const SEMANTIC_REVISION = "fetching-v2@1";
export const CAPABILITY_REVISION = "capabilities@1";

export const MAX_BATCH_IDS = 40;
export const MAX_SEARCH_RESULTS = 20;
export const SEARCH_HYDRATION_LIMIT = 8;

export const MARKET_ASSET_CLASSES = Object.freeze([
  "equity",
  "etf",
  "index",
  "fx",
  "crypto",
  "commodity_future",
  "rate_index",
]);

export const ASSET_SUBTYPES_BY_CLASS = Object.freeze({
  equity: Object.freeze(["common_stock", "unknown"]),
  etf: Object.freeze(["equity_etf", "bond_etf", "commodity_etf", "mixed_etf", "unknown"]),
  index: Object.freeze(["market_index", "unknown"]),
  fx: Object.freeze(["spot_pair"]),
  crypto: Object.freeze(["spot_pair", "unknown"]),
  commodity_future: Object.freeze(["continuous_front", "dated_contract"]),
  rate_index: Object.freeze(["yield_index", "unknown"]),
});

export const DEFAULT_ENABLED_ASSET_CLASSES = Object.freeze([...MARKET_ASSET_CLASSES]);

export const PRICE_UNITS = Object.freeze([
  "currency",
  "currency_per_unit",
  "index_points",
  "percent_yield",
]);

export const MAPPING_STATUSES = Object.freeze([
  "resolved",
  "provisional",
  "ambiguous",
  "unsupported",
]);

export const VENUE_KINDS = Object.freeze([
  "exchange",
  "fx_network",
  "crypto_network",
  "index_publisher",
  "futures_exchange",
  "unknown",
]);

export const SESSION_MODELS = Object.freeze([
  "exchange_hours",
  "24x5",
  "24x7",
  "publisher_schedule",
  "provider_schedule",
  "unknown",
]);

export const SESSION_PHASES = Object.freeze([
  "pre",
  "regular",
  "post",
  "closed",
  "continuous",
  "unknown",
]);

export const SESSION_PHASES_BY_MODEL = Object.freeze({
  exchange_hours: Object.freeze(["pre", "regular", "post", "closed", "unknown"]),
  "24x5": Object.freeze(["continuous", "closed", "unknown"]),
  "24x7": Object.freeze(["continuous", "unknown"]),
  publisher_schedule: Object.freeze(["pre", "regular", "post", "closed", "unknown"]),
  provider_schedule: Object.freeze(["pre", "regular", "post", "closed", "continuous", "unknown"]),
  unknown: Object.freeze(["unknown"]),
});

export const PRICE_BASES = Object.freeze([
  "raw",
  "provider_adjusted",
  "split_adjusted",
]);

export const ADJUSTMENT_STATUSES = Object.freeze([
  "none",
  "provider_defined",
  "split_adjusted",
  "unknown",
]);

export const CONTINUITY_KINDS = Object.freeze([
  "single_instrument",
  "provider_continuous_front",
]);

export const FIELD_AVAILABILITY_STATUSES = Object.freeze([
  "available",
  "not_applicable",
  "unsupported",
  "temporarily_unavailable",
  "invalid",
  "stale",
]);

export const VALUE_BEARING_AVAILABILITY = Object.freeze(["available", "stale"]);

export const SURFACE_QUALITIES = Object.freeze([
  "fresh",
  "delayed",
  "stale",
  "unavailable",
]);

export const DATA_QUALITY_STATUSES = Object.freeze([
  "usable",
  "usable_with_warnings",
  "unusable",
]);

export const DATA_QUALITY_ISSUE_CODES = Object.freeze([
  "provider_delayed",
  "provider_type_conflict",
  "provider_zero_placeholder",
  "missing_optional_field",
  "missing_required_field",
  "row_dropped_invalid_ohlc",
  "row_dropped_invalid_timestamp",
  "duplicate_timestamp",
  "partial_adjusted_series",
  "unknown_adjustment_semantics",
  "future_rollover_detected",
  "stale_last_known_good",
  "fallback_provider_used",
  "venue_mapping_provisional",
  "derived_from_previous_close",
]);

export const DATA_QUALITY_ISSUE_SEVERITIES = Object.freeze([
  "info",
  "warning",
  "error",
]);

export const DETAIL_KINDS = Object.freeze([
  "company",
  "fund",
  "index",
  "currency_pair",
  "crypto_asset",
  "future_contract",
  "rate_index",
]);

export const DETAIL_SECTIONS_BY_KIND = Object.freeze({
  company: Object.freeze(["company_profile", "equity_fundamentals", "analyst_outlook"]),
  fund: Object.freeze(["fund_profile", "fund_composition", "fund_stats"]),
  index: Object.freeze(["index_metadata", "market_stats"]),
  currency_pair: Object.freeze(["pair_metadata"]),
  crypto_asset: Object.freeze(["crypto_metadata", "crypto_market_stats"]),
  future_contract: Object.freeze(["future_contract", "future_market_stats", "rollover_notice"]),
  rate_index: Object.freeze(["index_metadata", "market_stats"]),
});

export const DETAIL_SECTIONS = Object.freeze([
  ...new Set(Object.values(DETAIL_SECTIONS_BY_KIND).flat()),
]);

export const CAPABILITY_SUPPORT_LEVELS = Object.freeze([
  "supported",
  "partial",
  "unsupported",
]);

export const PROVIDER_OPERATIONS = Object.freeze([
  "search",
  "quote",
  "history",
  "details",
  "news",
]);

export const EFFECTIVE_CAPABILITY_OPERATIONS = Object.freeze([
  "quote",
  "history",
  "details",
  "news",
  "analytics",
]);

export const QUOTE_FIELD_CAPABILITIES = Object.freeze([
  "price",
  "change",
  "open",
  "previousClose",
  "dayRange",
  "bidAsk",
  "volume",
  "averageVolume",
  "session",
]);

export const HISTORY_INTERVALS = Object.freeze([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "1d",
  "1wk",
  "1mo",
]);

export const HISTORY_RANGES = Object.freeze([
  "1d",
  "5d",
  "1m",
  "6m",
  "1y",
  "5y",
]);

export const VOLUME_SEMANTICS = Object.freeze([
  "exchange_traded",
  "provider_reported",
  "provider_aggregate",
  "not_applicable",
]);

export const PROVENANCE_SOURCES = Object.freeze(["yahoo", "finnhub"]);

export function marketCacheKey(resourceType, instrumentId, variantHash = "", semanticRevision = SEMANTIC_REVISION) {
  return ["v2", resourceType, instrumentId, variantHash, semanticRevision]
    .map((part) => `${part ?? ""}`)
    .join(":");
}
