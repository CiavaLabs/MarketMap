// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ touched: [] }));

vi.mock("../src/react/gridStore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    createGridStore: () => {
      const store = actual.createGridStore();
      return {
        ...store,
        getSnapshot: (instrumentId) => {
          probe.touched.push(instrumentId);
          return store.getSnapshot(instrumentId);
        },
      };
    },
  };
});

const { mountAssetGrid } = await import("../src/react/assetGrid.entry.jsx");

const INSTRUMENTS = ["aapl", "msft", "nvda", "googl", "amzn", "meta", "tsla", "avgo"];

beforeEach(() => { probe.touched = []; });
afterEach(() => document.body.replaceChildren());

function mountBoard() {
  document.body.innerHTML = '<div id="react-asset-grid" data-mm-react-root></div>';
  const island = document.querySelector("#react-asset-grid");
  const { setOrder, setIndexById, setTiers, applyBatch, root } = mountAssetGrid(island, {});
  setOrder(INSTRUMENTS);
  setIndexById(new Map(INSTRUMENTS.map((id, index) => [id, index])));
  setTiers(new Map(INSTRUMENTS.map((id) => [id, "compact"])));
  applyBatch(INSTRUMENTS.map((id) => ({
    instrumentId: id,
    viewModel: {
      displaySymbol: id.toUpperCase(),
      name: id,
      formattedValue: "$100.00",
      changePercent: 1,
      assetClass: "equity",
      footerLabel: "Technology",
    },
    quality: "fresh",
    designSystemQuality: "current",
    derivedState: "gaining",
    ariaLabel: `Open ${id} details.`,
    sparklineData: [],
  })));
  return { island, root };
}

describe("AssetGrid render cost", () => {
  it("re-renders only the cells a reorder frame actually changes", async () => {
    const { island } = mountBoard();
    const handle = island.querySelector('[data-reorder-handle="aapl"]');

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();

    probe.touched = [];
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();

    const rerendered = new Set(probe.touched);
    expect(rerendered.size).toBeGreaterThan(0);
    expect(rerendered.size).toBeLessThanOrEqual(2);
    expect(rerendered.size).toBeLessThan(INSTRUMENTS.length);
  });

  it("skips every cell when only the live-region announcement changes", async () => {
    const { island } = mountBoard();
    const handle = island.querySelector('[data-reorder-handle="aapl"]');
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();

    probe.touched = [];
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();
    expect(probe.touched).toEqual([]);
  });
});
