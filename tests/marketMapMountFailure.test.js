// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketMap } from "../src/app/createMarketMap.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { GridBridgeRenderer } from "../src/render/GridBridgeRenderer.js";
import { StateManager } from "../src/core/StateManager.js";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  mic: "XNAS",
  currency: "USD",
  status: "active",
});

const UNSUPPORTED = Object.freeze({
  id: "XNAS:VFIAX",
  symbol: "VFIAX",
  name: "Vanguard 500 Index Fund",
  assetClass: "mutual_fund",
  mic: "XNAS",
  currency: "USD",
  status: "active",
});

function envelope(data) {
  return {
    data,
    meta: {
      apiVersion: "v1",
      schemaVersion: 1,
      requestId: "req-mount-test",
      generatedAt: "2026-07-13T14:30:01.000Z",
      nextRefreshAt: null,
    },
  };
}

function fakeClient() {
  return {
    apiBaseUrl: "/api/market/v1",
    snapshot: vi.fn(async () => envelope([])),
    history: vi.fn(async () => envelope({ bars: [] })),
    search: vi.fn(async () => envelope([])),
    health: vi.fn(async () => envelope({ status: "ok" })),
  };
}

function shell() {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false });
  return root;
}

describe("mount failure and malformed board instruments", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("paints every healthy tile when one instrument cannot be presented", () => {
    const state = new StateManager([AAPL, UNSUPPORTED]);
    const applied = [];
    const renderer = new GridBridgeRenderer({
      state,
      assets: [AAPL, UNSUPPORTED],
      assetIndexLookup: new Map([[AAPL.id, 0], [UNSUPPORTED.id, 1]]),
      historySeries: new Map(),
      gridApi: { applyBatch: (entries) => applied.push(...entries) },
    });

    expect(() => renderer.renderAll()).not.toThrow();
    expect(applied.map((entry) => entry.instrumentId)).toEqual([AAPL.id]);
  });

  it("leaves the root remountable when mounting throws", () => {
    const root = shell();

    expect(() => createMarketMap({
      root,
      instruments: [AAPL],
      client: fakeClient(),
      reactIslands: {
        mountAssetGrid: () => { throw new Error("island bundle is unavailable"); },
      },
    })).toThrow("island bundle is unavailable");

    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.classList.contains("marketmap-app")).toBe(false);
    expect(root.dataset.dsRoot).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();

    const runtime = createMarketMap({ root, instruments: [AAPL], client: fakeClient() });
    expect(root.dataset.marketmapMounted).toBe("true");
    runtime.destroy();
  });

  it("tears down a fully built graph when the last mount step throws", () => {
    vi.useFakeTimers();
    try {
      const root = shell();

      expect(() => createMarketMap({
        root,
        instruments: [AAPL],
        client: fakeClient(),
        reactIslands: {
          mountToolbar: () => { throw new Error("toolbar bundle is unavailable"); },
        },
      })).toThrow("toolbar bundle is unavailable");

      expect(vi.getTimerCount()).toBe(0);
      expect(root.dataset.marketmapMounted).toBeUndefined();
      expect(root.classList.contains("marketmap-app")).toBe(false);

      const runtime = createMarketMap({ root, instruments: [AAPL], client: fakeClient() });
      expect(root.dataset.marketmapMounted).toBe("true");
      runtime.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a host marker the root already carried", () => {
    const root = shell();
    root.dataset.marketmapMounted = "false";

    const runtime = createMarketMap({ root, instruments: [AAPL], client: fakeClient() });
    expect(root.dataset.marketmapMounted).toBe("true");

    runtime.destroy();
    expect(root.dataset.marketmapMounted).toBe("false");
  });

  it("returns the root to its pre-mount state on destroy", () => {
    const root = shell();
    const runtime = createMarketMap({ root, instruments: [AAPL], client: fakeClient() });

    expect(root.classList.contains("marketmap-app")).toBe(true);
    expect(root.dataset.theme).toBeTruthy();

    runtime.destroy();

    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.classList.contains("marketmap-app")).toBe(false);
    expect(root.dataset.marketmapTheme).toBeUndefined();
    expect(root.dataset.dsRoot).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.dataset.feedQuality).toBeUndefined();
  });
});
