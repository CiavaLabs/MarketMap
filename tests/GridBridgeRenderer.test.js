import { describe, expect, it, vi } from "vitest";
import { GridBridgeRenderer } from "../src/render/GridBridgeRenderer.js";

function tile(over = {}) {
  return {
    instrumentId: "equity:AAPL:XNAS",
    symbol: "AAPL",
    assetClass: "equity",
    price: 232.4,
    changePercent: 1.23,
    quality: "fresh",
    asOf: "2026-07-13T10:00:00.000Z",
    dirty: true,
    ...over,
  };
}

function makeRenderer({ tiles = new Map(), assets, historySeries = new Map() } = {}) {
  const assetIndexLookup = new Map(assets.map((asset, index) => [asset.id, index]));
  const state = {
    getTile: (identity) => tiles.get(identity),
    resolveInstrumentId: (identity) => identity,
  };
  const gridApi = { applyBatch: vi.fn() };
  const renderer = new GridBridgeRenderer({ state, assets, assetIndexLookup, historySeries, gridApi });
  return { renderer, gridApi };
}

describe("GridBridgeRenderer", () => {
  it("builds a view-model entry and pushes it through gridApi.applyBatch", () => {
    const assets = [{ id: "equity:AAPL:XNAS", name: "Apple Inc." }];
    const tiles = new Map([["equity:AAPL:XNAS", tile()]]);
    const { renderer, gridApi } = makeRenderer({ tiles, assets });

    renderer.renderTile("equity:AAPL:XNAS", 0);

    expect(gridApi.applyBatch).toHaveBeenCalledOnce();
    const [[entries]] = gridApi.applyBatch.mock.calls;
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.instrumentId).toBe("equity:AAPL:XNAS");
    expect(entry.index).toBe(0);
    expect(entry.viewModel.displaySymbol).toBe("AAPL");
    expect(entry.viewModel.changePercent).toBe(1.23);
    expect(entry.quality).toBe("fresh");
    expect(entry.designSystemQuality).toBe("current");
    expect(entry.derivedState).toBe("gaining");
    expect(entry.ariaLabel).toContain("Apple Inc. (AAPL)");
    expect(entry.ariaLabel).toContain("Data current.");
  });

  it("marks the tile clean (dirty: false) after building its entry", () => {
    const assets = [{ id: "equity:AAPL:XNAS", name: "Apple Inc." }];
    const theTile = tile();
    const tiles = new Map([["equity:AAPL:XNAS", theTile]]);
    const { renderer } = makeRenderer({ tiles, assets });

    renderer.renderTile("equity:AAPL:XNAS", 0);
    expect(theTile.dirty).toBe(false);
  });

  it("filters non-finite sparkline values but leaves gaps bridged (no null entries survive)", () => {
    const assets = [{ id: "equity:AAPL:XNAS", name: "Apple Inc." }];
    const tiles = new Map([["equity:AAPL:XNAS", tile()]]);
    const historySeries = new Map([["equity:AAPL:XNAS", [100, null, 102, NaN, 104]]]);
    const { renderer, gridApi } = makeRenderer({ tiles, assets, historySeries });

    renderer.renderTile("equity:AAPL:XNAS", 0);
    const entry = gridApi.applyBatch.mock.calls[0][0][0];
    expect(entry.sparklineData).toEqual([100, 102, 104]);
  });

  it("returns an empty sparkline for unavailable-quality tiles even with history present", () => {
    const assets = [{ id: "equity:AAPL:XNAS", name: "Apple Inc." }];
    const tiles = new Map([["equity:AAPL:XNAS", tile({ quality: "unavailable", price: null, changePercent: null })]]);
    const historySeries = new Map([["equity:AAPL:XNAS", [100, 101, 102]]]);
    const { renderer, gridApi } = makeRenderer({ tiles, assets, historySeries });

    renderer.renderTile("equity:AAPL:XNAS", 0);
    const entry = gridApi.applyBatch.mock.calls[0][0][0];
    expect(entry.sparklineData).toEqual([]);
    expect(entry.derivedState).toBe("unavailable");
    expect(entry.designSystemQuality).toBe("unavailable");
  });

  it("renderBatch resolves each item's index and pushes one combined batch", () => {
    const assets = [
      { id: "equity:AAPL:XNAS", name: "Apple Inc." },
      { id: "equity:MSFT:XNAS", name: "Microsoft Corp." },
    ];
    const tiles = new Map([
      ["equity:AAPL:XNAS", tile()],
      ["equity:MSFT:XNAS", tile({ instrumentId: "equity:MSFT:XNAS", symbol: "MSFT", changePercent: -0.5 })],
    ]);
    const { renderer, gridApi } = makeRenderer({ tiles, assets });

    renderer.renderBatch([
      { instrumentId: "equity:AAPL:XNAS", index: 0 },
      { instrumentId: "equity:MSFT:XNAS", index: 1 },
    ]);

    expect(gridApi.applyBatch).toHaveBeenCalledOnce();
    const entries = gridApi.applyBatch.mock.calls[0][0];
    expect(entries.map((entry) => entry.instrumentId)).toEqual(["equity:AAPL:XNAS", "equity:MSFT:XNAS"]);
  });

  it("renderAll paints every asset in the registry's order", () => {
    const assets = [
      { id: "equity:AAPL:XNAS", name: "Apple Inc." },
      { id: "equity:MSFT:XNAS", name: "Microsoft Corp." },
    ];
    const tiles = new Map([
      ["equity:AAPL:XNAS", tile()],
      ["equity:MSFT:XNAS", tile({ instrumentId: "equity:MSFT:XNAS", symbol: "MSFT" })],
    ]);
    const { renderer, gridApi } = makeRenderer({ tiles, assets });

    renderer.renderAll();
    const entries = gridApi.applyBatch.mock.calls[0][0];
    expect(entries).toHaveLength(2);
  });

  it("silently skips an identity with no matching tile", () => {
    const assets = [{ id: "equity:AAPL:XNAS", name: "Apple Inc." }];
    const { renderer, gridApi } = makeRenderer({ tiles: new Map(), assets });
    renderer.renderTile("equity:AAPL:XNAS", 0);
    expect(gridApi.applyBatch).not.toHaveBeenCalled();
  });
});
