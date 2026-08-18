export { createMarketDataService } from "./createMarketDataService.js";
export {
  createMarketDataHandler,
  PROVIDER_CAPABILITY_MANIFESTS,
  RequestQuota,
} from "./http/index.js";
export const API_VERSION = "v1";

export { MarketDataError } from "./errors/MarketDataError.js";
export {
  CANONICAL_INSTRUMENT_ID_PATTERN,
  ERROR_CODES,
  ERROR_CODE_VALUES,
  METRIC_UNITS,
  isMarketDataErrorCode,
} from "./contracts/core/constants.js";
export {
  HISTORY_ALLOWLIST,
  HISTORY_DEFAULT_INTERVALS,
} from "./contracts/core/history.js";

export {
  ADJUSTMENT_STATUSES,
  ASSET_SUBTYPES_BY_CLASS,
  CAPABILITY_REVISION,
  CAPABILITY_SUPPORT_LEVELS,
  CONTINUITY_KINDS,
  DATA_QUALITY_ISSUE_CODES,
  DATA_QUALITY_ISSUE_SEVERITIES,
  DATA_QUALITY_STATUSES,
  DEFAULT_ENABLED_ASSET_CLASSES,
  DETAIL_KINDS,
  DETAIL_SECTIONS,
  DETAIL_SECTIONS_BY_KIND,
  EFFECTIVE_CAPABILITY_OPERATIONS,
  FIELD_AVAILABILITY_STATUSES,
  HISTORY_INTERVALS,
  HISTORY_RANGES,
  MAPPING_STATUSES,
  MARKET_ASSET_CLASSES as ASSET_CLASSES,
  MARKET_SCHEMA_VERSION as SCHEMA_VERSION,
  MAX_BATCH_IDS,
  MAX_SEARCH_RESULTS,
  PRICE_BASES,
  PRICE_UNITS,
  PROVENANCE_SOURCES,
  PROVIDER_OPERATIONS,
  QUOTE_FIELD_CAPABILITIES,
  SEARCH_HYDRATION_LIMIT,
  SESSION_MODELS,
  SESSION_PHASES,
  SESSION_PHASES_BY_MODEL,
  SURFACE_QUALITIES,
  VALUE_BEARING_AVAILABILITY,
  VENUE_KINDS,
  VOLUME_SEMANTICS,
} from "./contracts/market/constants.js";

export {
  QUOTE_OBSERVATION_FIELDS,
  validateQuoteSnapshot,
} from "./contracts/market/quote.js";
export { validateHistorySeries } from "./contracts/market/history.js";
export { validateInstrumentDetails } from "./contracts/market/details.js";
export { validateInstrumentDescriptor } from "./contracts/market/instrument.js";
export { validateEffectiveCapabilities } from "./contracts/market/capabilities.js";
export {
  NEWS_BATCH_BUDGET_MS,
  NEWS_BATCH_CONCURRENCY,
  NEWS_BATCH_MAX_LIMIT,
  NEWS_BOARD_DEFAULT_LIMIT,
  NEWS_CLOCK_SKEW_MS,
  NEWS_FEED_QUALITIES,
  NEWS_FEED_SOURCES,
  NEWS_INSTRUMENT_DEFAULT_LIMIT,
  NEWS_PERSISTENCE_READ_TIMEOUT_MS,
  NEWS_PROVIDERS,
  NEWS_PROVIDER_LIMIT,
  NEWS_SINGLE_FETCH_BUDGET_MS,
  NEWS_STALE_RECHECK_MS,
  NEWS_WINDOW_DAYS,
  NEWS_WINDOW_MS,
  isNewsTimestampInWindow,
  newsClockDate,
  normalizeNewsText,
} from "./contracts/core/news.js";
export {
  isNewsAggregateResponse,
  isNewsArticle,
  isNewsBatchResponse,
  isNewsFeed,
  validateMetric,
  validateNewsAggregateResponse,
  validateNewsArticle,
  validateNewsBatchResponse,
  validateNewsFeed,
} from "./contracts/core/validators.js";
export {
  compareNewsArticles,
  deduplicateNewsArticles,
  newsArticleKey,
  normalizeNewsUrl,
  selectBalancedNewsArticles,
  sortNewsArticles,
} from "./metrics/index.js";
export { ttlFor as ttlForMarketData } from "./orchestration/ttlPolicy.js";

export {
  CURATED_INSTRUMENTS,
  DEFAULT_BOARD_IDS,
  DEFAULT_EQUITY_BOARD_IDS,
  InstrumentCatalog,
  LEGACY_CANONICAL_ID_MIGRATIONS,
  decodeCanonicalId,
  encodeCanonicalId,
  isCanonicalInstrumentId,
} from "./instruments/InstrumentCatalog.js";
export {
  ALL_ASSET_POLICIES,
  assetPolicyFor,
  detailSectionsFor,
  isAssetClassEnabled,
  normalizeEnabledAssetClasses,
} from "./instruments/assetPolicies.js";

export { InMemorySnapshotStore } from "./cache/InMemorySnapshotStore.js";
export { MySQLSnapshotStore } from "./cache/MySQLSnapshotStore.js";
export { InMemoryInstrumentCatalogStore } from "./instruments/InstrumentCatalogStore.js";
export { MySQLInstrumentCatalogStore } from "./instruments/MySQLInstrumentCatalogStore.js";
export {
  IN_MEMORY_ANALYTICS_DEFAULT_MAX_SCOPES,
  InMemoryAnalyticsStore,
} from "./analytics/persistence/InMemoryAnalyticsStore.js";
export { MySQLAnalyticsStore } from "./analytics/persistence/MySQLAnalyticsStore.js";

export { PROVIDER_CAPABILITIES, ProviderAdapter } from "./providers/ProviderAdapter.js";
export { YahooProvider } from "./providers/yahoo/YahooProvider.js";
export { YAHOO_CAPABILITY_MANIFEST } from "./providers/yahoo/capabilityManifest.js";
export { YahooClient } from "./providers/yahoo/yahooClient.js";
export { YAHOO_USER_AGENT, YahooSession } from "./providers/yahoo/yahooSession.js";
export { YahooCookieJar } from "./providers/yahoo/yahooCookieJar.js";
export { FinnhubProvider } from "./providers/finnhub/FinnhubProvider.js";
export { FINNHUB_CAPABILITY_MANIFEST } from "./providers/finnhub/capabilityManifest.js";

export {
  DAILY_ANALYTICS_CUTOFF_UTC,
  DAILY_ANALYTICS_RUNNER_VERSION,
  HOLIDAY_RULE_KINDS,
  MOVEMENT_SNAPSHOT_MAX_IDS,
  NYSE_CALENDAR_SOURCE,
  OBSERVANCES,
  createExchangeCalendar,
  nyseCalendar,
  reconcileSessionGrid,
  validateSessionGrid,
} from "./analytics/index.js";

export { Telemetry, createStructuredLogger } from "./observability/index.js";
