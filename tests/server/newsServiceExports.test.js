import { describe, expect, it, vi } from "vitest";
import * as server from "../../server/index.js";
import { createMarketDataService } from "../../server/createMarketDataService.js";
import { InstrumentCatalog } from "../../server/instruments/InstrumentCatalog.js";
import { descriptorFromLegacyInstrument } from "../../server/instruments/descriptorFactory.js";

const newsCatalog = new InstrumentCatalog();
const descriptorResolver = {
  getDescriptor: async (value) => descriptorFromLegacyInstrument(
    newsCatalog.resolve(String(value).toUpperCase()),
    { verifiedAt: "2026-07-16T00:00:00.000Z" },
  ),
  idForProviderSymbol: (symbol) => newsCatalog.resolveByProviderSymbol?.(symbol)?.id || null,
  capabilitiesFor: () => ({ news: { status: "supported" } }),
  isAddable: () => ({ addable: true, reasonCode: null }),
  searchInstruments: async () => [],
};

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

function feed(instrumentId) {
  return {
    instrumentId,
    articles: [{
      id: `yahoo:${instrumentId}`,
      title: `Coverage for ${instrumentId}`,
      publisher: "Publisher",
      url: `https://news.example.test/${encodeURIComponent(instrumentId)}`,
      publishedAt: "2026-07-13T19:00:00.000Z",
      instrumentIds: [instrumentId],
      provider: "yahoo",
    }],
    source: "yahoo",
    quality: "fresh",
    asOf: "2026-07-13T19:00:00.000Z",
    fetchedAt: "2026-07-13T20:00:00.000Z",
  };
}

describe("news service and public server exports", () => {
  it("exposes single and batch news methods through the service facade", async () => {
    const provider = {
      id: "yahoo",
      capabilities: () => ({ news: { enabled: true } }),
      supports: (capability) => capability === "news",
      news: vi.fn(async (instrument) => feed(instrument.id)),
    };
    const service = createMarketDataService({
      providers: [provider],
      resolver: descriptorResolver,
      clock: () => NOW,
      logLevel: "silent",
    });

    await expect(service.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { instrumentId: "XNAS:AAPL", source: "yahoo" },
    });
    await expect(service.getNewsBatch(["XNAS:AAPL", "XNAS:MSFT"])).resolves.toMatchObject({
      data: { articles: expect.any(Array) },
      sources: { news: ["yahoo"] },
    });
    expect(typeof service.getNews).toBe("function");
    expect(typeof service.getNewsBatch).toBe("function");
  });

  it("publishes the complete additive contract from the server entry point", () => {
    expect(server).toMatchObject({
      API_VERSION: "v1",
      SCHEMA_VERSION: 2,
      ASSET_CLASSES: [
        "equity",
        "etf",
        "index",
        "fx",
        "crypto",
        "commodity_future",
        "rate_index",
      ],
      NEWS_PROVIDER_LIMIT: 8,
      NEWS_BOARD_DEFAULT_LIMIT: 12,
      NEWS_INSTRUMENT_DEFAULT_LIMIT: 6,
      NEWS_BATCH_BUDGET_MS: 25_000,
      NEWS_SINGLE_FETCH_BUDGET_MS: 5_700,
      NEWS_WINDOW_DAYS: 7,
      validateNewsArticle: expect.any(Function),
      validateNewsFeed: expect.any(Function),
      validateNewsBatchResponse: expect.any(Function),
      validateNewsAggregateResponse: expect.any(Function),
      validateQuoteSnapshot: expect.any(Function),
      validateHistorySeries: expect.any(Function),
      validateInstrumentDetails: expect.any(Function),
      ttlForMarketData: expect.any(Function),
      isNewsAggregateResponse: expect.any(Function),
      selectBalancedNewsArticles: expect.any(Function),
      deduplicateNewsArticles: expect.any(Function),
    });
    expect(server.PROVIDER_CAPABILITIES).toContain("news");
    expect(server).not.toHaveProperty("API_VERSION_V2");
    expect(server).not.toHaveProperty("MARKET_API_V2_BASE_PATH");
    expect(server).not.toHaveProperty("MARKET_ASSET_CLASSES");
    expect(server).not.toHaveProperty("ttlFor");
    expect(server).not.toHaveProperty("ttlForNews");
    expect(server).not.toHaveProperty("validateInstrument");
    expect(server).not.toHaveProperty("validateBars");
  });

  it("publishes exactly this surface, and nothing that has not been decided", () => {
    expect(Object.keys(server).sort()).toEqual([
      "ADJUSTMENT_STATUSES",
      "ALL_ASSET_POLICIES",
      "API_VERSION",
      "ASSET_CLASSES",
      "ASSET_SUBTYPES_BY_CLASS",
      "CANONICAL_INSTRUMENT_ID_PATTERN",
      "CAPABILITY_REVISION",
      "CAPABILITY_SUPPORT_LEVELS",
      "CONTINUITY_KINDS",
      "CURATED_INSTRUMENTS",
      "DAILY_ANALYTICS_CUTOFF_UTC",
      "DAILY_ANALYTICS_RUNNER_VERSION",
      "DATA_QUALITY_ISSUE_CODES",
      "DATA_QUALITY_ISSUE_SEVERITIES",
      "DATA_QUALITY_STATUSES",
      "DEFAULT_BOARD_IDS",
      "DEFAULT_ENABLED_ASSET_CLASSES",
      "DEFAULT_EQUITY_BOARD_IDS",
      "DETAIL_KINDS",
      "DETAIL_SECTIONS",
      "DETAIL_SECTIONS_BY_KIND",
      "EFFECTIVE_CAPABILITY_OPERATIONS",
      "ERROR_CODES",
      "ERROR_CODE_VALUES",
      "FIELD_AVAILABILITY_STATUSES",
      "FINNHUB_CAPABILITY_MANIFEST",
      "FinnhubProvider",
      "HISTORY_ALLOWLIST",
      "HISTORY_DEFAULT_INTERVALS",
      "HISTORY_INTERVALS",
      "HISTORY_RANGES",
      "HOLIDAY_RULE_KINDS",
      "IN_MEMORY_ANALYTICS_DEFAULT_MAX_SCOPES",
      "InMemoryAnalyticsStore",
      "InMemoryInstrumentCatalogStore",
      "InMemorySnapshotStore",
      "InstrumentCatalog",
      "LEGACY_CANONICAL_ID_MIGRATIONS",
      "MAPPING_STATUSES",
      "MAX_BATCH_IDS",
      "MAX_SEARCH_RESULTS",
      "METRIC_UNITS",
      "MOVEMENT_SNAPSHOT_MAX_IDS",
      "MarketDataError",
      "MySQLAnalyticsStore",
      "MySQLInstrumentCatalogStore",
      "MySQLSnapshotStore",
      "NEWS_BATCH_BUDGET_MS",
      "NEWS_BATCH_CONCURRENCY",
      "NEWS_BATCH_MAX_LIMIT",
      "NEWS_BOARD_DEFAULT_LIMIT",
      "NEWS_CLOCK_SKEW_MS",
      "NEWS_FEED_QUALITIES",
      "NEWS_FEED_SOURCES",
      "NEWS_INSTRUMENT_DEFAULT_LIMIT",
      "NEWS_PERSISTENCE_READ_TIMEOUT_MS",
      "NEWS_PROVIDERS",
      "NEWS_PROVIDER_LIMIT",
      "NEWS_SINGLE_FETCH_BUDGET_MS",
      "NEWS_STALE_RECHECK_MS",
      "NEWS_WINDOW_DAYS",
      "NEWS_WINDOW_MS",
      "NYSE_CALENDAR_SOURCE",
      "OBSERVANCES",
      "PRICE_BASES",
      "PRICE_UNITS",
      "PROVENANCE_SOURCES",
      "PROVIDER_CAPABILITIES",
      "PROVIDER_CAPABILITY_MANIFESTS",
      "PROVIDER_OPERATIONS",
      "ProviderAdapter",
      "QUOTE_FIELD_CAPABILITIES",
      "QUOTE_OBSERVATION_FIELDS",
      "RequestQuota",
      "SCHEMA_VERSION",
      "SEARCH_HYDRATION_LIMIT",
      "SESSION_MODELS",
      "SESSION_PHASES",
      "SESSION_PHASES_BY_MODEL",
      "SURFACE_QUALITIES",
      "Telemetry",
      "VALUE_BEARING_AVAILABILITY",
      "VENUE_KINDS",
      "VOLUME_SEMANTICS",
      "YAHOO_CAPABILITY_MANIFEST",
      "YAHOO_USER_AGENT",
      "YahooClient",
      "YahooCookieJar",
      "YahooProvider",
      "YahooSession",
      "assetPolicyFor",
      "compareNewsArticles",
      "createExchangeCalendar",
      "createMarketDataHandler",
      "createMarketDataService",
      "createStructuredLogger",
      "decodeCanonicalId",
      "deduplicateNewsArticles",
      "detailSectionsFor",
      "encodeCanonicalId",
      "isAssetClassEnabled",
      "isCanonicalInstrumentId",
      "isMarketDataErrorCode",
      "isNewsAggregateResponse",
      "isNewsArticle",
      "isNewsBatchResponse",
      "isNewsFeed",
      "isNewsTimestampInWindow",
      "newsArticleKey",
      "newsClockDate",
      "normalizeEnabledAssetClasses",
      "normalizeNewsText",
      "normalizeNewsUrl",
      "nyseCalendar",
      "reconcileSessionGrid",
      "selectBalancedNewsArticles",
      "sortNewsArticles",
      "ttlForMarketData",
      "validateEffectiveCapabilities",
      "validateHistorySeries",
      "validateInstrumentDescriptor",
      "validateInstrumentDetails",
      "validateMetric",
      "validateNewsAggregateResponse",
      "validateNewsArticle",
      "validateNewsBatchResponse",
      "validateNewsFeed",
      "validateQuoteSnapshot",
      "validateSessionGrid",
    ]);
  });

  it("publishes the catalog the factory accepts, so its composition slot stays usable", async () => {
    const catalog = new server.InstrumentCatalog();
    const composed = createMarketDataService({
      catalog,
      providers: [{
        id: "yahoo",
        capabilities: () => ({ news: { enabled: true } }),
        supports: (capability) => capability === "news",
        news: vi.fn(async (instrument) => feed(instrument.id)),
      }],
      resolver: descriptorResolver,
      clock: () => NOW,
      logLevel: "silent",
    });
    expect(composed.catalog).toBe(catalog);
    await expect(composed.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { instrumentId: "XNAS:AAPL" },
    });
  });
});
