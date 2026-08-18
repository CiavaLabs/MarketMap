import { describe, expect, it, vi } from "vitest";
import { InMemorySnapshotStore } from "../../server/cache/InMemorySnapshotStore.js";
import { MemoryCache } from "../../server/cache/MemoryCache.js";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import {
  NEWS_PERSISTENCE_READ_TIMEOUT_MS,
  NEWS_SINGLE_FETCH_BUDGET_MS,
  NEWS_WINDOW_MS,
} from "../../server/contracts/core/news.js";
import { validateNewsBatchResponse } from "../../server/contracts/core/validators.js";
import { MarketDataError } from "../../server/errors/MarketDataError.js";
import {
  DEFAULT_BOARD_IDS,
  DEFAULT_EQUITY_BOARD_IDS,
  InstrumentCatalog,
} from "../../server/instruments/InstrumentCatalog.js";
import { MarketDataOrchestrator } from "../../server/orchestration/MarketDataOrchestrator.js";
import { SingleFlight } from "../../server/orchestration/SingleFlight.js";
import { FinnhubProvider } from "../../server/providers/finnhub/FinnhubProvider.js";
import { catalogDescriptorResolver as descriptorResolver } from "./fixtures/market/curatedDescriptors.js";

const START = Date.parse("2026-07-13T20:00:00.000Z");

function newsArticle(instrumentId, source = "yahoo", suffix = "1", publishedAt = START - 60_000) {
  return {
    id: `${source}:${instrumentId}:${suffix}`,
    title: `Coverage for ${instrumentId}`,
    publisher: "Publisher",
    url: `https://news.example.test/${source}/${encodeURIComponent(instrumentId)}/${suffix}`,
    publishedAt: new Date(publishedAt).toISOString(),
    instrumentIds: [instrumentId],
    provider: source,
  };
}

function newsFeed(instrumentId, source = "yahoo", { empty = false, suffix = "1", fetchedAt = START } = {}) {
  const articles = empty ? [] : [newsArticle(instrumentId, source, suffix, fetchedAt - 60_000)];
  return {
    instrumentId,
    articles,
    source,
    quality: "fresh",
    asOf: articles[0]?.publishedAt || new Date(fetchedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

function provider(id, overrides = {}) {
  return {
    id,
    capabilities: () => ({ news: { enabled: true }, quote: { enabled: true } }),
    supports: (capability) => capability === "news" || capability === "quote",
    news: vi.fn(async (instrument) => newsFeed(instrument.id, id)),
    quoteMany: vi.fn(async () => ({ data: [], errors: [] })),
    ...overrides,
  };
}

function setup({ providers, store, now = START, timeout = 1_000, breakerOptions, singleFlight } = {}) {
  let current = now;
  const clock = () => current;
  const catalog = new InstrumentCatalog();
  const snapshotStore = store || new InMemorySnapshotStore({ clock });
  const memoryCache = new MemoryCache({ clock, clone: structuredClone });
  const sharedFlight = singleFlight || new SingleFlight();
  return {
    catalog,
    clock,
    memoryCache,
    singleFlight: sharedFlight,
    store: snapshotStore,
    setNow(value) { current = value; },
    orchestrator: new MarketDataOrchestrator({
      providers: providers || [provider("yahoo")],
      catalog,
      instrumentResolver: descriptorResolver(catalog),
      snapshotStore,
      memoryCache,
      singleFlight: sharedFlight,
      clock,
      providerTimeoutMs: timeout,
      breakerOptions,
    }),
  };
}

function upstream(message = "offline") {
  return new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, message, {
    capability: "news",
    retryable: true,
  });
}

describe("provider capability declarations", () => {
  const declaring = (declaration, extra = {}) => {
    const built = provider("yahoo", { capabilities: () => declaration, ...extra });
    delete built.supports;
    return built;
  };

  it.each([
    ["an array naming the capability", ["news"], true],
    ["an array omitting it", ["quote"], false],
    ["an object declaring true", { news: true }, true],
    ["an object declaring false", { news: false }, false],
    ["an object listing the asset class", { news: ["equity"] }, true],
    ["an object listing other asset classes", { news: ["crypto"] }, false],
    ["an object with an enabled flag", { news: { enabled: true } }, true],
    ["an object with the flag switched off", { news: { enabled: false } }, false],
  ])("reads %s", async (_label, declaration, consulted) => {
    const built = declaring(declaration);
    const { orchestrator } = setup({ providers: [built] });

    const request = orchestrator.getNews("XNAS:AAPL");
    if (consulted) await expect(request).resolves.toMatchObject({ data: { source: "yahoo" } });
    else await expect(request).rejects.toMatchObject({ capability: "news" });

    expect(built.news).toHaveBeenCalledTimes(consulted ? 1 : 0);
  });

  it("falls back to the methods a provider actually exposes", async () => {
    const bare = provider("yahoo");
    delete bare.supports;
    delete bare.capabilities;
    const { orchestrator } = setup({ providers: [bare] });

    await expect(orchestrator.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "yahoo" },
    });
    expect(bare.news).toHaveBeenCalledOnce();
  });

  it("treats a provider with no declaration and no method as unable", async () => {
    const empty = provider("yahoo");
    delete empty.supports;
    delete empty.capabilities;
    delete empty.news;
    const { orchestrator } = setup({ providers: [empty] });

    await expect(orchestrator.getNews("XNAS:AAPL")).rejects.toMatchObject({ capability: "news" });
  });
});

describe("news orchestration", () => {
  it("uses Yahoo first, skips fallback on non-empty success, and serves fresh cache", async () => {
    const yahoo = provider("yahoo");
    const finnhub = provider("finnhub");
    const { orchestrator } = setup({ providers: [yahoo, finnhub] });

    const first = await orchestrator.getNews("XNAS:AAPL");
    const second = await orchestrator.getNews("XNAS:AAPL");

    expect(first).toMatchObject({ data: { source: "yahoo", quality: "fresh" }, sources: { news: ["yahoo"] } });
    expect(first.lastUpdatedAt).toBe("2026-07-13T20:00:00.000Z");
    expect(second.data).toEqual(first.data);
    expect(yahoo.news).toHaveBeenCalledOnce();
    expect(finnhub.news).not.toHaveBeenCalled();
    expect(Date.parse(first.nextRefreshAt)).toBe(START + 15 * 60_000);
  });

  it("falls back on Yahoo error and on Yahoo empty, preferring a non-empty Finnhub feed", async () => {
    const yahooError = provider("yahoo", { news: vi.fn(async () => { throw upstream(); }) });
    const finnhubAfterError = provider("finnhub");
    const first = setup({ providers: [yahooError, finnhubAfterError] }).orchestrator;
    await expect(first.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "finnhub", articles: [expect.any(Object)] },
    });

    const yahooEmpty = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true })),
    });
    const finnhubAfterEmpty = provider("finnhub");
    const second = setup({ providers: [yahooEmpty, finnhubAfterEmpty] }).orchestrator;
    await expect(second.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "finnhub", articles: [expect.any(Object)] },
    });
    expect(finnhubAfterEmpty.news).toHaveBeenCalledOnce();
  });

  it("preserves a valid Yahoo empty result when fallback is unavailable or fails", async () => {
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true })),
    });
    const disabled = provider("finnhub", {
      supports: () => false,
      news: vi.fn(),
    });
    const noFallback = setup({ providers: [yahoo, disabled] }).orchestrator;
    await expect(noFallback.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "yahoo", articles: [] },
      nextRefreshAt: new Date(START + 5 * 60_000).toISOString(),
    });
    expect(disabled.news).not.toHaveBeenCalled();

    const failingFallback = provider("finnhub", { news: vi.fn(async () => { throw upstream(); }) });
    const failureContext = setup({ providers: [
      provider("yahoo", {
        news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true })),
      }),
      failingFallback,
    ] });
    const withFailure = failureContext.orchestrator;
    const result = await withFailure.getNews("XNAS:AAPL");
    const cached = await withFailure.getNews("XNAS:AAPL");
    expect(result.data).toMatchObject({ source: "yahoo", articles: [] });
    expect(cached.data).toEqual(result.data);
    expect(failingFallback.news).toHaveBeenCalledOnce();
    expect(Date.parse(result.nextRefreshAt)).toBe(START + 60_000);

    failureContext.setNow(START + 60_001);
    await expect(withFailure.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "last-known-good", articles: [] },
    });
    await vi.waitFor(() => expect(failingFallback.news).toHaveBeenCalledTimes(2));

    const localUnsupported = provider("finnhub", {
      news: vi.fn(async () => {
        throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, "not eligible", {
          provider: "finnhub",
          capability: "news",
          retryable: false,
        });
      }),
    });
    const unsupportedResult = await setup({ providers: [
      provider("yahoo", {
        news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true })),
      }),
      localUnsupported,
    ] }).orchestrator.getNews("XNAS:AAPL");
    expect(unsupportedResult).toMatchObject({ data: { source: "yahoo", articles: [] } });
    expect(Date.parse(unsupportedResult.nextRefreshAt)).toBe(START + 5 * 60_000);
  });

  it("uses the last valid empty feed when both providers are empty and errors when both fail", async () => {
    const empty = (id) => provider(id, {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, id, { empty: true })),
    });
    const emptyResult = await setup({ providers: [empty("yahoo"), empty("finnhub")] })
      .orchestrator.getNews("XNAS:AAPL");
    expect(emptyResult.data).toMatchObject({ source: "finnhub", articles: [] });
    expect(Date.parse(emptyResult.nextRefreshAt)).toBe(START + 5 * 60_000);

    const failing = (id) => provider(id, { news: vi.fn(async () => { throw upstream(id); }) });
    await expect(setup({ providers: [failing("yahoo"), failing("finnhub")] })
      .orchestrator.getNews("XNAS:AAPL")).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        provider: "finnhub",
        capability: "news",
      });
  });

  it("serves stale immediately, retains article provider, and refreshes in the background", async () => {
    let version = 0;
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", {
        suffix: String(++version),
        fetchedAt: version === 1 ? START : START + 15 * 60_000 + 1,
      })),
    });
    const context = setup({ providers: [yahoo] });
    await context.orchestrator.getNews("XNAS:AAPL");
    context.setNow(START + 15 * 60_000 + 1);

    const stale = await context.orchestrator.getNews("XNAS:AAPL");
    expect(stale).toMatchObject({
      data: {
        source: "last-known-good",
        originalSource: "yahoo",
        quality: "stale",
        articles: [{ provider: "yahoo" }],
      },
      sources: { news: ["last-known-good"] },
    });
    expect(Date.parse(stale.nextRefreshAt)).toBe(context.clock() + 60_000);
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledTimes(2));
    await expect(context.orchestrator.getNews("XNAS:AAPL")).resolves.toMatchObject({
      data: { source: "yahoo", articles: [{ id: expect.stringContaining(":2") }] },
    });
  });

  it("prunes cached articles at the inclusive seven-day boundary and applies empty-feed TTLs", async () => {
    const yahoo = provider("yahoo");
    const context = setup({ providers: [yahoo] });
    const boundaryTime = START - NEWS_WINDOW_MS + 10 * 60_000;
    const cached = newsFeed("XNAS:AAPL", "yahoo");
    cached.articles = [
      newsArticle("XNAS:AAPL", "yahoo", "boundary", boundaryTime),
      newsArticle("XNAS:AAPL", "yahoo", "already-expired", START - NEWS_WINDOW_MS - 1),
    ];
    cached.asOf = cached.articles[0].publishedAt;
    context.memoryCache.set("news:XNAS:AAPL", cached, {
      freshTtlMs: 15 * 60_000,
      staleTtlMs: 24 * 60 * 60_000,
    });

    context.setNow(START + 10 * 60_000);
    const exactBoundary = await context.orchestrator.getNews("XNAS:AAPL");
    expect(exactBoundary).toMatchObject({
      data: { source: "yahoo", articles: [{ id: expect.stringContaining("boundary") }] },
      lastUpdatedAt: "2026-07-13T20:00:00.000Z",
    });
    expect(yahoo.news).not.toHaveBeenCalled();

    context.setNow(START + 10 * 60_000 + 1);
    const pruned = await context.orchestrator.getNews("XNAS:AAPL");
    expect(pruned).toMatchObject({
      data: {
        articles: [],
        originalSource: "yahoo",
        quality: "stale",
        source: "last-known-good",
      },
      sources: { news: ["last-known-good"] },
    });
    expect(Date.parse(pruned.nextRefreshAt)).toBe(context.clock() + 60_000);
  });

  it("prunes persistent news snapshots without leaking the pruning wrapper", async () => {
    const boundaryTime = START - NEWS_WINDOW_MS + 10 * 60_000;
    const cached = newsFeed("XNAS:AAPL", "yahoo");
    cached.articles = [
      newsArticle("XNAS:AAPL", "yahoo", "persistent-boundary", boundaryTime),
      newsArticle("XNAS:AAPL", "yahoo", "persistent-expired", START - NEWS_WINDOW_MS - 1),
    ];
    cached.asOf = cached.articles[0].publishedAt;
    const writerProvider = provider("yahoo", { news: vi.fn(async () => cached) });
    const writer = setup({ providers: [writerProvider] });
    await writer.orchestrator.getNews("XNAS:AAPL");
    await vi.waitFor(() => expect(writer.store.records.has("news:XNAS:AAPL")).toBe(true));

    let readerNow = START + 10 * 60_000;
    const readerProvider = provider("yahoo");
    const reader = new MarketDataOrchestrator({
      providers: [readerProvider],
      catalog: writer.catalog,
      instrumentResolver: descriptorResolver(writer.catalog),
      snapshotStore: writer.store,
      memoryCache: new MemoryCache({ clock: () => readerNow, clone: structuredClone }),
      clock: () => readerNow,
    });
    const exactBoundary = await reader.getNews("XNAS:AAPL");
    expect(exactBoundary.data.articles).toHaveLength(1);
    readerNow += 1;
    const result = await reader.getNews("XNAS:AAPL");
    expect(result.data).toMatchObject({
      articles: [],
      originalSource: "yahoo",
      quality: "stale",
      source: "last-known-good",
    });
    expect(result.data.value).toBeUndefined();
    expect(result.data.becameEmpty).toBeUndefined();
  });

  it("treats a pruned-to-empty snapshot older than one hour as a cache miss", async () => {
    const yahoo = provider("yahoo");
    const context = setup({ providers: [yahoo] });
    const cached = newsFeed("XNAS:AAPL", "yahoo");
    cached.articles = [newsArticle(
      "XNAS:AAPL",
      "yahoo",
      "expired",
      START - NEWS_WINDOW_MS + 1,
    )];
    cached.asOf = cached.articles[0].publishedAt;
    context.memoryCache.set("news:XNAS:AAPL", cached, {
      freshTtlMs: 15 * 60_000,
      staleTtlMs: 24 * 60 * 60_000,
    });
    context.setNow(START + 60 * 60_000 + 1);

    const result = await context.orchestrator.getNews("XNAS:AAPL");
    expect(result.data).toMatchObject({ source: "yahoo", quality: "fresh" });
    expect(yahoo.news).toHaveBeenCalledOnce();
  });

  it("uses the shorter five-minute freshness window for valid empty feeds", async () => {
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true })),
    });
    const context = setup({ providers: [yahoo] });
    await context.orchestrator.getNews("XNAS:AAPL");
    context.setNow(START + 5 * 60_000 - 1);
    const fresh = await context.orchestrator.getNews("XNAS:AAPL");
    expect(fresh.data).toMatchObject({ source: "yahoo", quality: "fresh", articles: [] });
    expect(yahoo.news).toHaveBeenCalledOnce();

    context.setNow(START + 5 * 60_000 + 1);
    const stale = await context.orchestrator.getNews("XNAS:AAPL");
    expect(stale.data).toMatchObject({
      source: "last-known-good",
      originalSource: "yahoo",
      quality: "stale",
      articles: [],
    });
    expect(Date.parse(stale.nextRefreshAt)).toBe(context.clock() + 60_000);
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledTimes(2));
  });

  it("persists valid empty feeds and discards corrupt persistent news records", async () => {
    let now = START;
    const clock = () => now;
    const store = new InMemorySnapshotStore({ clock });
    const catalog = new InstrumentCatalog();
    const emptyYahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", { empty: true, fetchedAt: now })),
    });
    const writer = new MarketDataOrchestrator({
      providers: [emptyYahoo], catalog, instrumentResolver: descriptorResolver(catalog), snapshotStore: store,
      memoryCache: new MemoryCache({ clock, clone: structuredClone }), clock,
    });
    await writer.getNews("XNAS:AAPL");

    const fromStoreProvider = provider("yahoo");
    const reader = new MarketDataOrchestrator({
      providers: [fromStoreProvider], catalog, instrumentResolver: descriptorResolver(catalog), snapshotStore: store,
      memoryCache: new MemoryCache({ clock, clone: structuredClone }), clock,
    });
    await expect(reader.getNews("XNAS:AAPL")).resolves.toMatchObject({ data: { articles: [] } });
    expect(fromStoreProvider.news).not.toHaveBeenCalled();

    const record = store.records.get("news:XNAS:AAPL");
    record.payload = newsFeed("XNAS:AAPL", "yahoo", { fetchedAt: now });
    record.payload.articles[0].url = "http://unsafe.example.test/story";
    const repairProvider = provider("yahoo");
    const repair = new MarketDataOrchestrator({
      providers: [repairProvider], catalog, instrumentResolver: descriptorResolver(catalog), snapshotStore: store,
      memoryCache: new MemoryCache({ clock, clone: structuredClone }), clock,
    });
    await repair.getNews("XNAS:AAPL");
    expect(repairProvider.news).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(store.records.get("news:XNAS:AAPL")?.payload.articles[0]?.url)
      .toContain("https://"));
    store.records.get("news:XNAS:AAPL").lastSuccessAt = "not-a-timestamp";
    const originRepairProvider = provider("yahoo");
    const originRepair = new MarketDataOrchestrator({
      providers: [originRepairProvider], catalog, instrumentResolver: descriptorResolver(catalog), snapshotStore: store,
      memoryCache: new MemoryCache({ clock, clone: structuredClone }), clock,
    });
    await originRepair.getNews("XNAS:AAPL");
    expect(originRepairProvider.news).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent cold requests per asset", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => {
        await gate;
        return newsFeed(instrument.id);
      }),
    });
    const { orchestrator } = setup({ providers: [yahoo], timeout: 10_000 });
    const requests = Array.from({ length: 50 }, () => orchestrator.getNews("XNAS:AAPL"));
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all(requests);
    expect(results).toHaveLength(50);
    expect(yahoo.news).toHaveBeenCalledOnce();
  });

  it("aborts the upstream news request when its only consumer leaves", async () => {
    let providerSignal;
    const yahoo = provider("yahoo", {
      news: vi.fn(async (_instrument, { signal }) => {
        providerSignal = signal;
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    });
    const context = setup({ providers: [yahoo], timeout: 10_000 });
    const controller = new AbortController();
    const request = context.orchestrator.getNews("XNAS:AAPL", { signal: controller.signal });
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledOnce());

    controller.abort(new DOMException("modal closed", "AbortError"));
    await expect(request).rejects.toMatchObject({
      retryable: false,
      details: { reason: "request_aborted" },
    });
    expect(providerSignal.aborted).toBe(true);
    await vi.waitFor(() => expect(context.singleFlight.size).toBe(0));
    expect(context.memoryCache.peek("news:XNAS:AAPL")).toBeNull();
  });

  it("keeps shared upstream work alive while another news consumer remains", async () => {
    let providerSignal;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument, { signal }) => {
        providerSignal = signal;
        await gate;
        return newsFeed(instrument.id);
      }),
    });
    const context = setup({ providers: [yahoo], timeout: 10_000 });
    const firstController = new AbortController();
    const first = context.orchestrator.getNews("XNAS:AAPL", { signal: firstController.signal });
    const second = context.orchestrator.getNews("XNAS:AAPL");
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledOnce());

    firstController.abort(new DOMException("first consumer left", "AbortError"));
    await expect(first).rejects.toMatchObject({ details: { reason: "request_aborted" } });
    expect(providerSignal.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ data: { source: "yahoo" } });
    expect(yahoo.news).toHaveBeenCalledOnce();
  });

  it("limits batch concurrency to five and preserves per-instrument errors", async () => {
    let active = 0;
    let peak = 0;
    const failingId = DEFAULT_EQUITY_BOARD_IDS[3];
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        if (instrument.id === failingId) throw upstream("item unavailable");
        return newsFeed(instrument.id);
      }),
    });
    const ids = DEFAULT_EQUITY_BOARD_IDS.slice(0, 10);
    const { orchestrator } = setup({ providers: [yahoo] });
    const result = await orchestrator.getNewsBatch(ids, { limit: 6, maxConcurrency: 99 });

    expect(peak).toBe(5);
    expect(yahoo.news).toHaveBeenCalledTimes(10);
    expect(result.data.articles).toHaveLength(6);
    expect(result.errors).toEqual([expect.objectContaining({ instrumentId: failingId })]);
    expect(result.sources.news).toEqual(["yahoo"]);
    expect(result.lastUpdatedAt).toBe("2026-07-13T20:00:00.000Z");
    expect(Date.parse(result.nextRefreshAt)).toBe(START + 60_000);
    expect(validateNewsBatchResponse(result, { now: START })).toBe(result);
  });

  it("returns partial batch timeout errors within the server budget", async () => {
    const ids = DEFAULT_EQUITY_BOARD_IDS.slice(0, 8);
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument, { signal }) => {
        if (instrument.id === ids[0]) return newsFeed(instrument.id);
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    });
    const { orchestrator } = setup({ providers: [yahoo], timeout: 10_000 });
    const result = await orchestrator.getNewsBatch(ids, { budgetMs: 25, limit: 8 });

    expect(result.data.articles).toHaveLength(1);
    expect(result.errors).toHaveLength(7);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: ERROR_CODES.TIMEOUT,
        retryable: true,
        details: { reason: "batch_budget_exceeded", budgetMs: 25 },
      }),
    ]));
    expect(result.lastUpdatedAt).toBe("2026-07-13T20:00:00.000Z");
    expect(validateNewsBatchResponse(result, { now: START })).toBe(result);
  });

  it("includes cold descriptor resolution in the news batch budget", async () => {
    vi.useFakeTimers();
    try {
      const resolver = {
        getDescriptor: vi.fn(() => new Promise(() => {})),
        capabilitiesFor: () => ({ news: { status: "supported" } }),
        idForProviderSymbol: () => null,
      };
      const catalog = new InstrumentCatalog();
      const orchestrator = new MarketDataOrchestrator({
        providers: [provider("yahoo")],
        catalog,
        snapshotStore: new InMemorySnapshotStore({ clock: () => START }),
        memoryCache: new MemoryCache({ clock: () => START, clone: structuredClone }),
        singleFlight: new SingleFlight(),
        instrumentResolver: resolver,
        clock: () => START,
        providerTimeoutMs: 10_000,
      });

      const request = orchestrator.getNewsBatch(["XNAS:NEWONE", "XNAS:NEWTWO"], { budgetMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      const result = await request;

      expect(resolver.getDescriptor).toHaveBeenCalledOnce();
      expect(result.data.articles).toEqual([]);
      expect(result.errors).toEqual([
        expect.objectContaining({
          instrumentId: "XNAS:NEWONE",
          code: ERROR_CODES.TIMEOUT,
          details: { reason: "batch_budget_exceeded", budgetMs: 25 },
        }),
        expect.objectContaining({
          instrumentId: "XNAS:NEWTWO",
          code: ERROR_CODES.TIMEOUT,
          details: { reason: "batch_budget_exceeded", budgetMs: 25 },
        }),
      ]);
      expect(validateNewsBatchResponse(result, { now: START })).toBe(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the oldest successful feed timestamp as conservative batch lastUpdatedAt", async () => {
    const ids = ["XNAS:AAPL", "XNAS:MSFT"];
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => newsFeed(instrument.id, "yahoo", {
        fetchedAt: instrument.id === ids[0] ? START : START - 5 * 60_000,
      })),
    });
    const context = setup({ providers: [yahoo] });
    await context.orchestrator.getNewsBatch(ids);
    context.setNow(START + 15 * 60_000 + 1);

    const stale = await context.orchestrator.getNewsBatch(ids);
    expect(stale.sources.news).toEqual(["last-known-good"]);
    expect(stale.lastUpdatedAt).toBe("2026-07-13T19:55:00.000Z");
  });

  it("honors a batch caller abort without scheduling the remaining instruments", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const yahoo = provider("yahoo", {
      news: vi.fn(async (instrument) => {
        await gate;
        return newsFeed(instrument.id);
      }),
    });
    const { orchestrator } = setup({ providers: [yahoo], timeout: 10_000 });
    const controller = new AbortController();
    const request = orchestrator.getNewsBatch(DEFAULT_EQUITY_BOARD_IDS.slice(0, 10), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(yahoo.news).toHaveBeenCalledTimes(5));
    controller.abort(new DOMException("board changed", "AbortError"));
    await expect(request).rejects.toMatchObject({
      retryable: false,
      details: { reason: "request_aborted" },
    });
    expect(yahoo.news).toHaveBeenCalledTimes(5);
    release();
  });

  it("enforces the service-level one-to-forty unique instrument boundary", async () => {
    const { orchestrator } = setup();
    await expect(orchestrator.getNewsBatch([])).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
      capability: "news",
    });
    await expect(orchestrator.getNewsBatch([...DEFAULT_BOARD_IDS, "XNAS:BND"]))
      .rejects.toMatchObject({
        code: ERROR_CODES.INVALID_REQUEST,
        capability: "news",
      });
    await expect(orchestrator.getNewsBatch(Array.from({ length: 41 }, () => "XNAS:AAPL")))
      .rejects.toMatchObject({
        code: ERROR_CODES.INVALID_REQUEST,
        capability: "news",
      });
  });

  it("settles a cold single-news fallback with persistence in under six seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    try {
      const never = () => new Promise(() => {});
      const store = {
        get: vi.fn(never),
        set: vi.fn(never),
        delete: vi.fn(async () => true),
      };
      const yahoo = provider("yahoo", { news: vi.fn(never) });
      const finnhub = provider("finnhub", { news: vi.fn(never) });
      const { orchestrator } = setup({
        providers: [yahoo, finnhub],
        store,
        timeout: 2_800,
      });
      const startedAt = Date.now();
      let settledAt = null;
      const outcome = orchestrator.getNews("XNAS:AAPL").then(
        () => ({ ok: true }),
        (error) => {
          settledAt = Date.now();
          return { ok: false, error };
        },
      );

      await vi.advanceTimersByTimeAsync(5_999);
      const result = await outcome;
      expect(result).toMatchObject({ ok: false, error: { code: ERROR_CODES.TIMEOUT } });
      expect(settledAt - startedAt).toBeLessThan(6_000);
      expect(settledAt - startedAt).toBeLessThanOrEqual(
        (2 * 2_800) + NEWS_PERSISTENCE_READ_TIMEOUT_MS,
      );
      expect(NEWS_SINGLE_FETCH_BUDGET_MS + (2 * NEWS_PERSISTENCE_READ_TIMEOUT_MS))
        .toBeLessThan(6_000);
      expect(yahoo.news).toHaveBeenCalledOnce();
      expect(finnhub.news).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips locally ineligible Finnhub news without hiding the primary retryable error", async () => {
    const catalog = new InstrumentCatalog();
    catalog.register({
      id: "XLON:VOD",
      symbol: "VOD",
      name: "Vodafone Group Plc",
      assetClass: "equity",
      exchange: "London Stock Exchange",
      mic: "XLON",
      currency: "GBP",
      country: "GB",
      status: "active",
      providerSymbols: { finnhub: "VOD.L", yahoo: "VOD.L" },
    });
    const yahoo = provider("yahoo", { news: vi.fn(async () => { throw upstream("Yahoo offline"); }) });
    const fetch = vi.fn(async () => { throw new Error("Finnhub offline"); });
    const finnhub = new FinnhubProvider({ apiKey: "secret", fetch, catalog, clock: () => START });
    const orchestrator = new MarketDataOrchestrator({
      providers: [yahoo, finnhub],
      catalog,
      instrumentResolver: descriptorResolver(catalog),
      clock: () => START,
    });

    await expect(orchestrator.getNews("XNAS:AAPL")).rejects.toMatchObject({ provider: "finnhub" });
    const before = orchestrator.getHealth().circuits["finnhub:news"];
    await expect(orchestrator.getNews("XLON:VOD")).rejects.toMatchObject({
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      provider: "yahoo",
      retryable: true,
    });
    const after = orchestrator.getHealth().circuits["finnhub:news"];
    expect(fetch).toHaveBeenCalledOnce();
    expect(finnhub.supportsInstrument("news", catalog.resolve("XLON:VOD"))).toBe(false);
    expect(before.failureCount).toBe(1);
    expect(after.failureCount).toBe(1);
  });

  it("quarantines authentication failures only for finnhub:news", async () => {
    const yahoo = provider("yahoo", { news: vi.fn(async () => { throw upstream(); }) });
    const finnhub = provider("finnhub", {
      news: vi.fn(async () => {
        throw new MarketDataError(ERROR_CODES.AUTH_FAILED, "bad key", {
          provider: "finnhub",
          capability: "news",
          retryable: false,
        });
      }),
    });
    const { orchestrator } = setup({ providers: [yahoo, finnhub] });
    await expect(orchestrator.getNews("XNAS:AAPL")).rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
    const health = orchestrator.getHealth();
    expect(health.providers.finnhub.quarantinedCapabilities).toEqual({
      news: expect.objectContaining({ code: ERROR_CODES.AUTH_FAILED }),
    });
    expect(health.providers.finnhub.capabilities.quote.enabled).toBe(true);
    expect(health.providers.finnhub.capabilities.news.enabled).toBe(true);
  });

  it("opens a schema-drift circuit for yahoo:news without affecting other capabilities", async () => {
    const yahoo = provider("yahoo", {
      news: vi.fn(async () => ({ malformed: true })),
    });
    const finnhub = provider("finnhub");
    const { orchestrator } = setup({
      providers: [yahoo, finnhub],
      breakerOptions: { failureThreshold: 1, cooldownMs: 10_000 },
    });

    await orchestrator.getNews("XNAS:AAPL");
    await orchestrator.getNews("XNAS:MSFT");
    const health = orchestrator.getHealth();
    expect(yahoo.news).toHaveBeenCalledOnce();
    expect(finnhub.news).toHaveBeenCalledTimes(2);
    expect(health.circuits["yahoo:news"].state).toBe("open");
    expect(health.providers.yahoo.capabilities.quote.enabled).toBe(true);
    expect(health.circuits["yahoo:quote"]).toBeUndefined();
  });
});
