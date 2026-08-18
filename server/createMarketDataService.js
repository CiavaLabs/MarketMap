import { YahooClient } from "./providers/yahoo/yahooClient.js";

import { clonePlain } from "../shared/clonePlain.js";
import { AnalyticsEngine } from "./analytics/AnalyticsEngine.js";
import { DailyAnalyticsRunner } from "./analytics/DailyAnalyticsRunner.js";
import { readMovementSnapshot } from "./analytics/readMovementSnapshot.js";
import { InMemorySnapshotStore } from "./cache/InMemorySnapshotStore.js";
import { MemoryCache } from "./cache/MemoryCache.js";
import { createMarketDataHandler } from "./http/createMarketDataHandler.js";
import { InstrumentCatalog } from "./instruments/InstrumentCatalog.js";
import { InstrumentResolver } from "./instruments/InstrumentResolver.js";
import { normalizeEnabledAssetClasses } from "./instruments/assetPolicies.js";
import { YAHOO_CAPABILITY_MANIFEST } from "./providers/yahoo/capabilityManifest.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "./providers/finnhub/capabilityManifest.js";
import { MarketDataOrchestrator } from "./orchestration/MarketDataOrchestrator.js";
import { Telemetry } from "./observability/Telemetry.js";
import { createStructuredLogger } from "./observability/StructuredLogger.js";
import { FinnhubProvider } from "./providers/finnhub/FinnhubProvider.js";
import { YahooProvider } from "./providers/yahoo/YahooProvider.js";

const clone = clonePlain;

async function closeResources(resources) {
  const results = await Promise.allSettled(resources.map(({ close }) => (
    Promise.resolve().then(close)
  )));
  const failures = results
    .map((result, index) => ({ result, resource: resources[index].name }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length === 1) throw failures[0].result.reason;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map(({ result }) => result.reason),
      `Failed to close market data resources: ${failures.map(({ resource }) => resource).join(", ")}`,
    );
  }
}

export function createMarketDataService(options = {}) {
  const clock = options.clock || (() => Date.now());
  const catalog = options.catalog || new InstrumentCatalog();
  const telemetry = options.telemetry || new Telemetry({ clock });
  const logger = options.logger || createStructuredLogger({
    enabled: options.logLevel !== "silent",
    context: { component: "market-data" },
  });
  const memoryCache = options.memoryCache || new MemoryCache({
    clock,
    clone,
    maxEntries: options.maxMemoryEntries || 2_000,
  });
  const snapshotStore = options.snapshotStore || new InMemorySnapshotStore({ clock });
  const instrumentCatalogStore = options.instrumentCatalogStore || null;

  let ownedYahooClient = null;
  const providers = options.providers || (() => {
    const yahooClient = options.yahooClient
      || (ownedYahooClient = new YahooClient({
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
        clock,
      }));
    return [
      options.yahooProvider || new YahooProvider({ client: yahooClient, clock }),
      options.finnhubProvider || new FinnhubProvider({
        apiKey: options.finnhubApiKey || "",
        fetch: options.fetch || globalThis.fetch,
        clock,
        maxConcurrency: options.finnhubMaxConcurrency,
      }),
    ];
  })();

  const enabledAssetClasses = normalizeEnabledAssetClasses(options.enabledAssetClasses);
  const yahooProvider = providers.find((provider) => provider.id === "yahoo");
  const resolver = options.resolver || new InstrumentResolver({
    catalog,
    yahooProvider,
    store: instrumentCatalogStore,
    manifests: [YAHOO_CAPABILITY_MANIFEST, FINNHUB_CAPABILITY_MANIFEST],
    enabledAssetClasses,
    clock,
    telemetry,
    logger,
    maxResolvedDescriptors: options.maxResolvedDescriptors,
  });

  const orchestrator = options.orchestrator || new MarketDataOrchestrator({
    providers,
    memoryCache,
    snapshotStore,
    telemetry,
    logger,
    clock,
    ttlPolicy: options.ttlPolicy,
    providerTimeoutMs: options.providerTimeoutMs || 2_800,
    persistenceTimeoutMs: options.persistenceTimeoutMs,
    historyBatchConcurrency: options.historyBatchConcurrency,
    breakerOptions: options.breakerOptions,
    instrumentResolver: resolver,
    fallbackPolicy: options.fallbackPolicy,
  });
  const analyticsStore = options.analyticsStore || null;
  let analytics = null;
  if (analyticsStore) {
    const analyticsConfig = options.analyticsConfig || {};
    const runner = new DailyAnalyticsRunner({
      historyService: {
        getHistoryBatch: orchestrator.getHistoryBatch.bind(orchestrator),
      },
      analyticsStore,
      equityInstrumentIds: analyticsConfig.equityInstrumentIds,
      engine: analyticsConfig.engine || new AnalyticsEngine(),
      clock: analyticsConfig.clock || (() => new Date(clock())),
    });
    analytics = {
      runDailyAnalytics: (runOptions) => runner.run(runOptions),
      getAnalyticsSnapshot: (ids, readOptions) => (
        readMovementSnapshot(analyticsStore, ids, readOptions)
      ),
    };
  }

  const apiService = Object.freeze({
    getHealth: orchestrator.getHealth.bind(orchestrator),
    getSnapshot: orchestrator.getSnapshot.bind(orchestrator),
    getHistory: orchestrator.getHistory.bind(orchestrator),
    getHistoryBatch: orchestrator.getHistoryBatch.bind(orchestrator),
    getDetails: orchestrator.getDetails.bind(orchestrator),
    getNews: orchestrator.getNews.bind(orchestrator),
    getNewsBatch: orchestrator.getNewsBatch.bind(orchestrator),
    ...(analytics ? { getAnalyticsSnapshot: analytics.getAnalyticsSnapshot } : {}),
  });
  const searchInstruments = resolver.searchInstruments.bind(resolver);
  const handleRequest = createMarketDataHandler({
    service: apiService,
    resolver,
    basePath: options.basePath,
    clock,
    requestIdFactory: options.requestIdFactory,
    logger,
    telemetry,
    enabledAssetClasses,
    maxBatchIds: options.maxBatchIds,
    quota: options.quota,
    exposeHealthInternals: options.exposeHealthInternals,
  });

  const closeTargets = [{
    name: "snapshot store",
    close: orchestrator.close.bind(orchestrator),
  }];
  if (ownedYahooClient) {
    closeTargets.push({
      name: "yahoo session",
      close: ownedYahooClient.close.bind(ownedYahooClient),
    });
  }
  if (
    instrumentCatalogStore
    && instrumentCatalogStore !== snapshotStore
    && instrumentCatalogStore !== orchestrator
    && typeof instrumentCatalogStore.close === "function"
  ) {
    closeTargets.push({
      name: "instrument catalog store",
      close: instrumentCatalogStore.close.bind(instrumentCatalogStore),
    });
  }
  if (
    analyticsStore
    && analyticsStore !== snapshotStore
    && analyticsStore !== instrumentCatalogStore
    && analyticsStore !== orchestrator
    && typeof analyticsStore.close === "function"
  ) {
    closeTargets.push({
      name: "analytics store",
      close: analyticsStore.close.bind(analyticsStore),
    });
  }
  let closePromise = null;
  const close = () => {
    if (!closePromise) closePromise = closeResources(closeTargets);
    return closePromise;
  };

  return Object.freeze({
    catalog,
    providers,
    orchestrator,
    resolver,
    telemetry,
    enabledAssetClasses,
    handleRequest,
    getSnapshot: apiService.getSnapshot,
    searchInstruments,
    getDetails: apiService.getDetails,
    getHistory: apiService.getHistory,
    getHistoryBatch: apiService.getHistoryBatch,
    getNews: apiService.getNews,
    getNewsBatch: apiService.getNewsBatch,
    getHealth: apiService.getHealth,
    ...(analytics
      ? {
        runDailyAnalytics: analytics.runDailyAnalytics,
        getAnalyticsSnapshot: analytics.getAnalyticsSnapshot,
      }
      : {}),
    close,
  });
}
