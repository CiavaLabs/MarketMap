// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketMap } from "../src/app/createMarketMap.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";

const AS_OF = "2026-07-13T14:30:00.000Z";
const AAPL = Object.freeze({
  id: "XNAS:AAPL", symbol: "AAPL", name: "Apple Inc.", assetClass: "equity",
  exchange: "NASDAQ", mic: "XNAS", currency: "USD", sector: "Technology", status: "active",
});
const MSFT = Object.freeze({ ...AAPL, id: "XNAS:MSFT", symbol: "MSFT", name: "Microsoft Corporation" });

function envelope(data) {
  return {
    data,
    meta: { apiVersion: "v1", schemaVersion: 1, requestId: "req", generatedAt: AS_OF, nextRefreshAt: null },
  };
}

function fakeClient() {
  return {
    apiBaseUrl: "/api/market/v1",
    snapshot: vi.fn(async (ids) => envelope(ids.map((id) => ({
      instrumentId: id, price: 100, change: 1, changePercent: 1, asOf: AS_OF,
      fetchedAt: AS_OF, currency: "USD", quality: "fresh", source: "yahoo",
    })))),
    profile: vi.fn(async (id) => envelope({ instrument: { id }, source: "yahoo", quality: "fresh", asOf: AS_OF, metrics: [] })),
    history: vi.fn(async (id, options = {}) => envelope({ instrumentId: id, range: options.range || "1d", interval: options.interval || "5m", bars: [] })),
    search: vi.fn(async () => envelope([])),
    health: vi.fn(async () => envelope({ status: "ok" })),
  };
}

function trackListeners(target) {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const live = [];
  target.addEventListener = (type, handler, opts) => {
    const signal = opts && typeof opts === "object" ? opts.signal : undefined;
    live.push({ type, handler, signal, removed: false });
    return add(type, handler, opts);
  };
  target.removeEventListener = (type, handler, opts) => {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      if (!live[i].removed && live[i].type === type && live[i].handler === handler) {
        live[i].removed = true;
        break;
      }
    }
    return remove(type, handler, opts);
  };
  return {
    restore() { target.addEventListener = add; target.removeEventListener = remove; },
    outstanding() {
      return live
        .filter((l) => !l.removed && !(l.signal && l.signal.aborted))
        .map((l) => l.type);
    },
  };
}

function fullShell() {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false });
  return root;
}

async function settle(runtime) {
  await runtime.ready;
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe("mount/destroy/remount leak balance (objective #16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("attaches document/window listeners on mount and removes every one on destroy", async () => {
    const docTrack = trackListeners(document);
    const winTrack = trackListeners(window);
    const root = fullShell();

    const runtime = createMarketMap({
      root, instruments: [AAPL, MSFT], client: fakeClient(),
      refreshPolicy: "automatic", pauseWhenHidden: true,
    });
    await settle(runtime);

    const mounted = docTrack.outstanding();
    expect(mounted).toContain("keydown");
    expect(mounted).toContain("visibilitychange");

    runtime.destroy();

    expect(docTrack.outstanding()).toEqual([]);
    expect(winTrack.outstanding()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    docTrack.restore();
    winTrack.restore();
  });

  it("does not accumulate listeners or timers across a destroy/remount cycle on the same root", async () => {
    const docTrack = trackListeners(document);
    const winTrack = trackListeners(window);
    const root = fullShell();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const runtime = createMarketMap({
        root, instruments: cycle % 2 ? [MSFT] : [AAPL, MSFT], client: fakeClient(),
        refreshPolicy: "automatic", pauseWhenHidden: true,
      });
      await settle(runtime);
      expect(root.dataset.marketmapMounted).toBe("true");
      runtime.destroy();
      expect(root.dataset.marketmapMounted).toBeUndefined();
      expect(docTrack.outstanding()).toEqual([]);
      expect(winTrack.outstanding()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }

    docTrack.restore();
    winTrack.restore();
  });
});
