// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketMap } from "../src/app/createMarketMap.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { mountConsoleActions } from "../src/react/consoleActions.entry.jsx";
import { mountAssetGrid } from "../src/react/assetGrid.entry.jsx";

const AS_OF = "2026-07-13T14:30:00.000Z";
const FETCHED_AT = "2026-07-13T14:30:01.000Z";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  exchange: "NASDAQ",
  mic: "XNAS",
  currency: "USD",
  sector: "Technology",
  status: "active",
});

const MSFT = Object.freeze({
  id: "XNAS:MSFT",
  symbol: "MSFT",
  name: "Microsoft Corporation",
  assetClass: "equity",
  exchange: "NASDAQ",
  mic: "XNAS",
  currency: "USD",
  sector: "Technology",
  status: "active",
});

function quote(instrument, overrides = {}) {
  return {
    instrumentId: instrument.id,
    price: instrument.id === AAPL.id ? 232.41 : 506.17,
    change: 2.12,
    changePercent: 0.92,
    open: 230.1,
    previousClose: 230.29,
    dayHigh: 233.05,
    dayLow: 229.84,
    bid: 232.35,
    ask: 232.46,
    volume: 38_410_000,
    averageVolume3m: 49_820_000,
    marketState: "regular",
    asOf: AS_OF,
    fetchedAt: FETCHED_AT,
    currency: "USD",
    quality: "fresh",
    source: "yahoo",
    ...overrides,
  };
}

function envelope(data, errors = []) {
  return {
    data,
    meta: {
      apiVersion: "v1",
      schemaVersion: 1,
      requestId: "req-client-test",
      generatedAt: FETCHED_AT,
      nextRefreshAt: null,
    },
    ...(errors.length ? { errors } : {}),
  };
}

function fakeClient(overrides = {}) {
  const instruments = new Map([AAPL, MSFT].map((instrument) => [instrument.id, instrument]));
  return {
    apiBaseUrl: "/api/market/v1",
    snapshot: vi.fn(async (ids) => envelope(ids.map((id) => quote(instruments.get(id))))),
    profile: vi.fn(async (id) => envelope({
      instrument: instruments.get(id),
      source: "yahoo",
      quality: "fresh",
      asOf: AS_OF,
      metrics: [],
    })),
    history: vi.fn(async (id, options = {}) => envelope({
      instrumentId: id,
      range: options.range || "1d",
      interval: options.interval || "5m",
      bars: [],
    })),
    search: vi.fn(async () => envelope([])),
    health: vi.fn(async () => envelope({ status: "ok" })),
    ...overrides,
  };
}

function fullShell(options = {}) {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false, ...options });
  return root;
}

async function settle(runtime) {
  await runtime.ready;
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe("createMarketMap real-market runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("mounts canonical instruments, paints only API quotes, and destroys every loop", async () => {
    const root = fullShell();
    const client = fakeClient();
    const runtime = createMarketMap({
      root,
      instruments: [AAPL, MSFT],
      client,
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });

    await settle(runtime);

    expect(client.apiBaseUrl).toBe("/api/market/v1");
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(client.snapshot.mock.calls[0][0]).toEqual([AAPL.id, MSFT.id]);
    expect(client.snapshot.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(client.health).toBeTypeOf("function");

    const tiles = root.querySelectorAll(".asset-tile:not(.add-tile)");
    expect(tiles).toHaveLength(2);
    expect(tiles[0].dataset.instrumentId).toBe(AAPL.id);
    expect(tiles[0].dataset.quality).toBe("fresh");
    expect(tiles[0].textContent).toContain("AAPL");
    expect(tiles[0].textContent).toContain("232.41");
    expect(tiles[0].textContent).toContain("Technology");
    expect(tiles[0].getAttribute("aria-label")).toContain("Data current");
    const localUpdateTime = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(FETCHED_AT));
    expect(root.querySelector("#feed-status-copy")?.textContent).toBe(`Last updated ${localUpdateTime}`);

    const state = runtime.getState();
    expect(state.board.map(({ id }) => id)).toEqual([AAPL.id, MSFT.id]);
    expect(state.market.tiles[0]).toMatchObject({
      instrumentId: AAPL.id,
      price: 232.41,
      changePercent: 0.92,
      quality: "fresh",
      source: "yahoo",
    });
    expect(runtime.app.tileRegistry.getQuoteHistory(AAPL.id)).toEqual([
      expect.objectContaining({ price: 232.41, asOf: AS_OF, source: "yahoo" }),
    ]);
    runtime.destroy();
    runtime.destroy();

    expect(runtime.app.destroyed).toBe(true);
    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.querySelector("#marketmap")?.children).toHaveLength(0);
    expect(runtime.setTheme("light")).toBe(false);
    expect(root.dataset.marketmapTheme).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports a grid-only embed and can remount it after teardown", async () => {
    document.body.innerHTML = '<section data-embed><div id="marketmap"></div></section>';
    const root = document.querySelector("[data-embed]");
    const first = createMarketMap({
      root,
      instruments: [AAPL],
      client: fakeClient(),
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });
    await settle(first);

    expect(root.classList.contains("marketmap-app")).toBe(true);
    const firstTile = root.querySelector(".asset-tile:not(.add-tile)");
    expect(firstTile?.textContent).toContain("AAPL");
    expect(firstTile?.textContent).toContain("232.41");
    first.destroy();
    expect(vi.getTimerCount()).toBe(0);

    const second = createMarketMap({
      root,
      instruments: [MSFT],
      client: fakeClient(),
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });
    await settle(second);

    expect(root.querySelectorAll(".asset-tile:not(.add-tile)")).toHaveLength(1);
    expect(root.querySelector(".asset-tile:not(.add-tile)")?.textContent).toContain("MSFT");
    second.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an invalid initial board without claiming or clearing the host root", async () => {
    const root = fullShell();
    const originalShell = root.innerHTML;

    expect(() => createMarketMap({
      root,
      instruments: [AAPL, { ...AAPL, name: "Duplicate Apple" }],
      client: fakeClient(),
      refreshPolicy: "manual",
    })).toThrow("Duplicate canonical instrument id: XNAS:AAPL");

    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.classList.contains("marketmap-app")).toBe(false);
    expect(root.innerHTML).toBe(originalShell);
    expect(vi.getTimerCount()).toBe(0);

    const runtime = createMarketMap({
      root,
      instruments: [AAPL],
      client: fakeClient(),
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });
    await settle(runtime);
    runtime.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a non-canonical initial id before claiming the host root", () => {
    const root = fullShell();
    const originalShell = root.innerHTML;

    expect(() => createMarketMap({
      root,
      instruments: [{ ...AAPL, id: "xnas:aapl" }],
      client: fakeClient(),
      refreshPolicy: "manual",
    })).toThrow("Board instruments require canonical id and symbol");

    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.classList.contains("marketmap-app")).toBe(false);
    expect(root.innerHTML).toBe(originalShell);
  });

  it("delegates board controls and keeps theme changes scoped to its root", async () => {
    const root = fullShell();
    const clearAllTickers = vi.fn();
    const restoreDefaultTickers = vi.fn();
    const runtime = createMarketMap({
      root,
      instruments: [AAPL],
      client: fakeClient(),
      refreshPolicy: "manual",
      actions: { clearAllTickers, restoreDefaultTickers },
      reactIslands: { mountConsoleActions, mountAssetGrid },
    });
    await settle(runtime);

    root.querySelector("#btn-clear-all").click();
    root.querySelector("#btn-restore-defaults").click();

    expect(clearAllTickers).toHaveBeenCalledOnce();
    expect(restoreDefaultTickers).toHaveBeenCalledOnce();
    expect(runtime.setTheme("light")).toBe(true);
    expect(root.dataset.marketmapTheme).toBe("light");
    expect(document.body.dataset.marketmapTheme).toBeUndefined();
    expect(runtime.setTheme("sepia")).toBe(false);
    expect(runtime.pause("test")).toBe(true);
    expect(runtime.resume("test")).toBe(true);

    runtime.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves failed instruments unavailable instead of fabricating neutral prices", async () => {
    const root = fullShell();
    const client = fakeClient({
      snapshot: vi.fn(async () => envelope([], [{
        instrumentId: AAPL.id,
        code: "provider_unavailable",
        message: "The quote provider is unavailable",
        retryable: true,
      }])),
    });
    const runtime = createMarketMap({
      root,
      instruments: [AAPL],
      client,
      refreshPolicy: "manual",
      reactIslands: { mountAssetGrid },
    });

    await settle(runtime);

    const tileState = runtime.app.state.getTile(AAPL.id);
    const tile = root.querySelector(`[data-instrument-id="${AAPL.id}"]`);
    expect(tileState).toMatchObject({
      instrumentId: AAPL.id,
      price: null,
      change: null,
      changePercent: null,
      quality: "unavailable",
      source: null,
      hasInfo: false,
    });
    expect(tileState.error).toMatchObject({ code: "provider_unavailable" });
    expect(tile?.textContent).toContain("—");
    expect(tile?.dataset.quality).toBe("unavailable");
    expect(runtime.app.tileRegistry.getHistory(AAPL.id)).toEqual([]);
    expect(runtime.getState().feed).toMatchObject({ available: 0, total: 1, quality: "unavailable" });

    runtime.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
