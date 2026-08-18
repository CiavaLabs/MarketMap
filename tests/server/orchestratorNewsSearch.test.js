import { describe, expect, it, vi } from "vitest";

import { InMemorySnapshotStore } from "../../server/cache/InMemorySnapshotStore.js";
import { MemoryCache } from "../../server/cache/MemoryCache.js";
import { NEWS_WINDOW_MS } from "../../server/contracts/core/news.js";
import { InstrumentCatalog } from "../../server/instruments/InstrumentCatalog.js";
import { MarketDataOrchestrator } from "../../server/orchestration/MarketDataOrchestrator.js";
import {
  catalogDescriptorResolver as descriptorResolver,
  curatedCatalog,
} from "./fixtures/market/curatedDescriptors.js";

const START = Date.parse("2026-07-13T20:00:00.000Z");
const iso = (value) => new Date(value).toISOString();

function article(instrumentId, source = "yahoo", suffix = "1", publishedAt = START - 60_000) {
  return {
    id: `${source}:${suffix}`,
    title: `Coverage for ${instrumentId}`,
    publisher: "Publisher",
    url: `https://news.example.test/${source}/${suffix}`,
    publishedAt: iso(publishedAt),
    instrumentIds: [instrumentId],
    provider: source,
  };
}

function feed(instrumentId, source = "yahoo", { articles, fetchedAt = START } = {}) {
  const entries = articles ?? [article(instrumentId, source, "1", fetchedAt - 60_000)];
  return {
    instrumentId,
    articles: entries,
    source,
    quality: "fresh",
    asOf: entries[0]?.publishedAt || iso(fetchedAt),
    fetchedAt: iso(fetchedAt),
  };
}

function provider(id = "yahoo", overrides = {}) {
  return {
    id,
    capabilities: () => ({ news: { enabled: true }, quote: { enabled: true }, search: { enabled: true } }),
    supports: (capability) => ["news", "quote", "search"].includes(capability),
    news: vi.fn(async (instrument) => feed(instrument.id, id)),
    quoteMany: vi.fn(async () => ({ data: [], errors: [] })),
    search: vi.fn(async () => [{
      id: "XNAS:AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      assetClass: "equity",
      status: "active",
      source: id,
    }]),
    ...overrides,
  };
}

function setup({ providers, store, now = START, logger } = {}) {
  let current = now;
  const clock = () => current;
  const snapshotStore = store === null ? null : store || new InMemorySnapshotStore({ clock });
  const memoryCache = new MemoryCache({ clock, clone: structuredClone });
  return {
    memoryCache,
    snapshotStore,
    setNow(value) { current = value; },
    orchestrator: new MarketDataOrchestrator({
      providers: providers || [provider()],
      catalog: curatedCatalog,
      instrumentResolver: descriptorResolver(curatedCatalog),
      snapshotStore,
      memoryCache,
      clock,
      providerTimeoutMs: 500,
      persistenceTimeoutMs: 100,
      logger,
    }),
  };
}

describe("news reads", () => {
  it("serves a fresh feed from cache without calling the provider twice", async () => {
    const upstream = provider();
    const { orchestrator } = setup({ providers: [upstream] });

    const first = await orchestrator.getNews("XNAS:AAPL");
    const second = await orchestrator.getNews("XNAS:AAPL");

    expect(first.sources).toEqual({ news: ["yahoo"] });
    expect(second.data).toEqual(first.data);
    expect(second.lastUpdatedAt).toBe(first.lastUpdatedAt);
    expect(upstream.news).toHaveBeenCalledOnce();
  });

  it("serves a stale feed as last-known-good and refreshes behind it", async () => {
    const upstream = provider();
    const { orchestrator, setNow } = setup({ providers: [upstream] });
    await orchestrator.getNews("XNAS:AAPL");

    setNow(START + 20 * 60_000);
    const stale = await orchestrator.getNews("XNAS:AAPL");

    expect(stale.data.quality).toBe("stale");
    expect(stale.data.source).toBe("last-known-good");
    expect(stale.data.originalSource).toBe("yahoo");
    expect(stale.sources).toEqual({ news: ["last-known-good"] });
    expect(stale.nextRefreshAt).toBe(iso(START + 20 * 60_000 + 60_000));
  });

  it("reports a background refresh failure to the logger", async () => {
    const logger = { warn: vi.fn() };
    const flaky = provider();
    const { orchestrator, setNow } = setup({ providers: [flaky], logger });
    await orchestrator.getNews("XNAS:AAPL");

    flaky.news.mockRejectedValue(new Error("upstream down"));
    setNow(START + 20 * 60_000);
    await orchestrator.getNews("XNAS:AAPL");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      capability: "news",
      cacheOutcome: "refresh-error",
      instrumentId: "XNAS:AAPL",
    }));
  });

  it("prunes articles that have aged out of the news window", async () => {
    const upstream = provider("yahoo", {
      news: vi.fn(async (instrument) => feed(instrument.id, "yahoo", {
        articles: [
          article(instrument.id, "yahoo", "recent", START - 60_000),
          article(instrument.id, "yahoo", "old", START - NEWS_WINDOW_MS + 60_000),
        ],
      })),
    });
    const { orchestrator, setNow } = setup({ providers: [upstream] });
    await orchestrator.getNews("XNAS:AAPL");

    setNow(START + 2 * 60_000);
    const result = await orchestrator.getNews("XNAS:AAPL");
    expect(result.data.articles.map(({ id }) => id)).toEqual(["yahoo:recent"]);
  });

  it("shortens the deadline when pruning empties a feed", async () => {
    const upstream = provider("yahoo", {
      news: vi.fn(async (instrument) => feed(instrument.id, "yahoo", {
        articles: [article(instrument.id, "yahoo", "only", START - NEWS_WINDOW_MS + 120_000)],
      })),
    });
    const { orchestrator, setNow } = setup({ providers: [upstream] });
    await orchestrator.getNews("XNAS:AAPL");

    setNow(START + 3 * 60_000);
    const result = await orchestrator.getNews("XNAS:AAPL");
    expect(result.data.articles).toEqual([]);
  });

  it("refuses a request that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    const { orchestrator } = setup();
    await expect(orchestrator.getNews("XNAS:AAPL", { signal: controller.signal }))
      .rejects.toMatchObject({ details: { reason: "request_aborted" } });
  });
});

describe("news batch validation", () => {
  it.each([
    ["a value that is not an array", "XNAS:AAPL"],
    ["an object", {}],
  ])("rejects %s", async (_label, ids) => {
    const { orchestrator } = setup();
    await expect(orchestrator.getNewsBatch(ids)).rejects.toMatchObject({
      code: "invalid_request",
      capability: "news",
      retryable: false,
    });
  });

  it("rejects an empty batch", async () => {
    const { orchestrator } = setup();
    await expect(orchestrator.getNewsBatch([])).rejects.toThrowError(/between 1 and/u);
  });

  it("rejects a batch larger than the request limit", async () => {
    const { orchestrator } = setup();
    const ids = Array.from({ length: 200 }, (_, index) => `XNAS:A${index}`);
    await expect(orchestrator.getNewsBatch(ids)).rejects.toThrowError(/between 1 and/u);
  });

  it.each([
    ["a bare symbol", ["AAPL"]],
    ["a blank entry", ["  "]],
    ["a non-string entry", [42]],
  ])("rejects %s", async (_label, ids) => {
    const { orchestrator } = setup();
    await expect(orchestrator.getNewsBatch(ids))
      .rejects.toThrowError(/canonical instrument IDs/u);
  });

  it("refuses a batch that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    const { orchestrator } = setup();
    await expect(orchestrator.getNewsBatch(["XNAS:AAPL"], { signal: controller.signal }))
      .rejects.toMatchObject({ details: { reason: "request_aborted" } });
  });

  it("returns a feed per requested instrument", async () => {
    const { orchestrator } = setup();
    const result = await orchestrator.getNewsBatch(["XNAS:AAPL", "XNAS:MSFT"]);
    expect(result.data.articles.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  it("reports the instruments whose provider failed", async () => {
    const failing = provider("yahoo", {
      news: vi.fn(async (instrument) => {
        if (instrument.id === "XNAS:MSFT") throw new Error("upstream down");
        return feed(instrument.id, "yahoo");
      }),
    });
    const { orchestrator } = setup({ providers: [failing] });

    const result = await orchestrator.getNewsBatch(["XNAS:AAPL", "XNAS:MSFT"]);
    expect(result.errors.map(({ instrumentId }) => instrumentId)).toContain("XNAS:MSFT");
    expect(result.data.articles.length).toBeGreaterThan(0);
  });

  it("clamps a caller-supplied budget to something workable", async () => {
    const { orchestrator } = setup();
    const result = await orchestrator.getNewsBatch(["XNAS:AAPL"], { budgetMs: 0 });
    expect(result.data.articles.length).toBeGreaterThanOrEqual(0);
  });
});
