import { beforeEach, describe, expect, it } from "vitest";
import { TileRegistry } from "../src/registry/TileRegistry.js";

const sampleInstruments = [
  { id: "XNAS:AAA", symbol: "AAA", name: "AAA Inc." },
  { id: "XNAS:BBB", symbol: "BBB", name: "BBB Inc." },
];

const quote = (price, minute, overrides = {}) => ({
  price,
  changePercent: 1,
  asOf: `2026-07-13T14:${String(minute).padStart(2, "0")}:00Z`,
  fetchedAt: `2026-07-13T14:${String(minute).padStart(2, "0")}:01Z`,
  quality: "fresh",
  source: "yahoo",
  ...overrides,
});

describe("TileRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new TileRegistry(sampleInstruments, { historyLength: 3 });
  });

  it("maps canonical ids and unique symbol aliases to indexes", () => {
    expect(registry.getAssetIndex("XNAS:AAA")).toBe(0);
    expect(registry.getAssetIndex("aaa")).toBe(0);
    expect(registry.getAssetIndex("BBB")).toBe(1);
    expect(registry.getAssetIndex("ZZZ")).toBe(-1);

    registry.setAssets([
      { id: "XNAS:AAA", symbol: "AAA" },
      { id: "XLON:AAA", symbol: "AAA" },
    ]);
    expect(registry.getAssetIndex("AAA")).toBe(-1);
    expect(registry.getAssetIndex("XLON:AAA")).toBe(1);
  });

  it("keeps a bounded chronological buffer of timestamped real quotes", () => {
    expect(registry.getQuoteHistory("AAA")).toEqual([]);
    registry.appendQuote("AAA", quote(11, 30));
    registry.appendQuote("XNAS:AAA", quote(12, 31));
    registry.appendQuote("AAA", quote(13, 32));
    const length = registry.appendQuote("AAA", quote(14, 33));

    expect(length).toBe(3);
    expect(registry.getHistory("AAA")).toEqual([12, 13, 14]);
    expect(registry.getQuoteHistory("AAA")[2]).toMatchObject({
      price: 14,
      asOf: "2026-07-13T14:33:00Z",
      source: "yahoo",
    });
  });

  it("does not append unavailable, untimestamped, or out-of-order values", () => {
    registry.appendQuote("AAA", quote(12, 32));
    expect(registry.appendQuote("AAA", quote(11, 31))).toBe(1);
    expect(registry.appendQuote("AAA", { price: 13, quality: "fresh" })).toBe(0);
    expect(registry.appendQuote("AAA", quote(13, 33, { quality: "unavailable" }))).toBe(0);
    expect(registry.getHistory("AAA")).toEqual([12]);
  });

  it("replaces a quote with the same provider timestamp instead of duplicating it", () => {
    registry.appendQuote("AAA", quote(11, 30));
    registry.appendQuote("AAA", quote(12, 30, { quality: "delayed", source: "finnhub" }));
    expect(registry.getQuoteHistory("AAA")).toEqual([
      expect.objectContaining({ price: 12, quality: "delayed", source: "finnhub" }),
    ]);
  });
});
