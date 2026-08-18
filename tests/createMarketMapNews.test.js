// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketMap } from "../src/app/createMarketMap.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { mountAssetGrid } from "../src/react/assetGrid.entry.jsx";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  exchange: "NASDAQ",
  currency: "USD",
});
const MSFT = Object.freeze({ ...AAPL, id: "XNAS:MSFT", symbol: "MSFT", name: "Microsoft" });
const GENERATED_AT = "2026-07-15T16:15:00.000Z";

function baseEnvelope(data) {
  return { data, errors: [], meta: { generatedAt: GENERATED_AT, nextRefreshAt: null } };
}

function quote(instrumentId) {
  return {
    instrumentId,
    price: 200,
    change: 2,
    changePercent: 1,
    asOf: "2026-07-15T16:14:00.000Z",
    fetchedAt: GENERATED_AT,
    currency: "USD",
    quality: "fresh",
    source: "yahoo",
  };
}

function article(instrument) {
  return {
    id: `yahoo:${instrument.symbol.toLowerCase()}-1`,
    title: `${instrument.symbol} launches a new service`,
    publisher: "Reuters",
    url: `https://news.example/${instrument.symbol.toLowerCase()}`,
    publishedAt: "2026-07-15T16:10:00.000Z",
    instrumentIds: [instrument.id],
    provider: "yahoo",
  };
}

function boardNewsEnvelope(instrument) {
  return {
    data: { articles: [article(instrument)] },
    errors: [],
    sources: { news: ["yahoo"] },
    meta: { generatedAt: GENERATED_AT, nextRefreshAt: null },
  };
}

function singleNewsEnvelope(instrument) {
  return {
    data: {
      instrumentId: instrument.id,
      articles: [article(instrument)],
      source: "yahoo",
      quality: "fresh",
      asOf: "2026-07-15T16:10:00.000Z",
      fetchedAt: GENERATED_AT,
    },
    sources: { news: ["yahoo"] },
    meta: { generatedAt: GENERATED_AT, nextRefreshAt: null },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolve_) => { resolve = resolve_; });
  return { promise, resolve };
}

function client(overrides = {}) {
  return {
    snapshot: vi.fn(async (ids) => baseEnvelope(ids.map(quote))),
    historyBatch: vi.fn(async () => baseEnvelope({ histories: [] })),
    profile: vi.fn(async (id) => baseEnvelope({ instrument: { id }, metrics: [] })),
    history: vi.fn(async (id) => baseEnvelope({ instrumentId: id, bars: [] })),
    news: vi.fn(async (id) => singleNewsEnvelope(id === MSFT.id ? MSFT : AAPL)),
    newsBatch: vi.fn(async (ids) => boardNewsEnvelope(ids.includes(MSFT.id) ? MSFT : AAPL)),
    search: vi.fn(async () => baseEnvelope([])),
    ...overrides,
  };
}

function root() {
  document.body.innerHTML = '<main data-root></main>';
  const element = document.querySelector("[data-root]");
  renderMarketMapShell(element, { footer: false });
  return element;
}

async function flush(count = 6) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe("createMarketMap news API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("keeps ready independent, exposes newsReady/refreshNews, and renders the board feed", async () => {
    const pendingNews = deferred();
    const fakeClient = client({
      newsBatch: vi.fn(() => pendingNews.promise),
    });
    const runtime = createMarketMap({
      root: root(),
      instruments: [AAPL],
      client: fakeClient,
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });
    let newsSettled = false;
    runtime.newsReady.then(() => { newsSettled = true; });

    await runtime.ready;
    await flush();
    expect(fakeClient.snapshot).toHaveBeenCalledOnce();
    expect(fakeClient.newsBatch).toHaveBeenCalledOnce();
    expect(newsSettled).toBe(false);
    expect(runtime.views.boardNewsView).toBeDefined();
    expect(runtime.root.querySelector('[data-cell="news"]').textContent)
      .toContain("Loading recent coverage…");

    pendingNews.resolve(boardNewsEnvelope(AAPL));
    await runtime.newsReady;
    expect(runtime.root.querySelector('[data-cell="news"]').textContent)
      .toContain("AAPL launches a new service");
    expect(runtime.getState().news).toMatchObject({
      status: "ready",
      articles: [expect.objectContaining({ id: "yahoo:aapl-1" })],
    });

    fakeClient.newsBatch.mockResolvedValueOnce(boardNewsEnvelope(AAPL));
    await runtime.refreshNews();
    expect(fakeClient.newsBatch).toHaveBeenCalledTimes(2);
    await expect(runtime.app.getNews(AAPL.id)).resolves.toEqual(singleNewsEnvelope(AAPL));
    expect(fakeClient.news).toHaveBeenCalledWith(AAPL.id, {});

    runtime.destroy();
    await expect(runtime.refreshNews()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates on a real board-set change and coordinates pause/auto-refresh lifecycle", async () => {
    const fakeClient = client();
    const runtime = createMarketMap({
      root: root(),
      instruments: [AAPL],
      client: fakeClient,
      refreshPolicy: "automatic",
      pauseWhenHidden: false,
      reactIslands: { mountAssetGrid },
    });
    await runtime.ready;
    await runtime.newsReady;

    expect(runtime.pause("host")).toBe(true);
    expect(runtime.app.newsController.refreshCoordinator.getState().paused).toBe(true);
    runtime.updateInstruments([MSFT]);
    await flush();
    expect(fakeClient.newsBatch).toHaveBeenCalledTimes(1);
    expect(runtime.resume("host")).toBe(true);
    await flush();
    expect(fakeClient.newsBatch).toHaveBeenCalledTimes(2);
    expect(fakeClient.newsBatch.mock.calls[1][0]).toEqual([MSFT.id]);
    expect(runtime.root.querySelector('[data-cell="news"]').textContent)
      .toContain("MSFT launches a new service");

    expect(runtime.setAutoRefresh(false)).toBe(true);
    expect(runtime.app.newsController.refreshCoordinator.getState().refreshPolicy).toBe("manual");
    runtime.updateInstruments([MSFT]);
    await flush();
    expect(fakeClient.newsBatch).toHaveBeenCalledTimes(2);

    runtime.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
