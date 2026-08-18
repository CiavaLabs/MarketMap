import { describe, expect, it } from "vitest";
import { TileRegistry } from "../src/registry/TileRegistry.js";

const assets = [
  { id: "XNAS:AAPL", symbol: "AAPL" },
  { id: "XNYS:IBM", symbol: "IBM" },
];

describe("TileRegistry real history series", () => {
  it("stores close values from bars and keeps invalid points as null gaps", () => {
    const registry = new TileRegistry(assets, { root: null });
    const usable = registry.setHistorySeries("XNAS:AAPL", [
      { close: 1 }, { close: 2 }, { close: null }, { close: 3 },
    ]);
    expect(usable).toBe(3);
    expect(registry.getHistorySeries("XNAS:AAPL")).toEqual([1, 2, null, 3]);
  });

  it("uses v2 displayClose and never fills an adjusted gap with raw close", () => {
    const registry = new TileRegistry(assets, { root: null });
    registry.setHistorySeries("XNAS:AAPL", [
      { close: 100, adjustedClose: 50, displayClose: 50 },
      { close: 101, adjustedClose: null, displayClose: null },
    ]);

    expect(registry.getHistorySeries("XNAS:AAPL")).toEqual([50, null]);
  });

  it("resolves by symbol and returns an empty series for unknown instruments", () => {
    const registry = new TileRegistry(assets, { root: null });
    registry.setHistorySeries("AAPL", [{ close: 5 }, { close: 6 }]);
    expect(registry.getHistorySeries("XNAS:AAPL")).toEqual([5, 6]);
    expect(registry.getHistorySeries("NOPE:X")).toEqual([]);
  });

  it("keeps the sparkline history separate from the session-sampled quoteHistory", () => {
    const registry = new TileRegistry(assets, { root: null });
    registry.setHistorySeries("XNAS:AAPL", [{ close: 10 }, { close: 11 }]);
    expect(registry.getQuoteHistory("XNAS:AAPL")).toEqual([]);
    expect(registry.getHistorySeries("XNAS:AAPL")).toEqual([10, 11]);
  });

  it("drops history for instruments removed from the board", () => {
    const registry = new TileRegistry(assets, { root: null });
    registry.setHistorySeries("XNAS:AAPL", [{ close: 10 }, { close: 11 }]);
    registry.setAssets([assets[1]]);

    expect(registry.historySeries.has("XNAS:AAPL")).toBe(false);
    expect(registry.getHistorySeries("XNYS:IBM")).toEqual([]);
  });
});
