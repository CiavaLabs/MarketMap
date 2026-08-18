import { describe, expect, it } from "vitest";
import {
  selectBoardSamples,
  selectBoardSnapshot,
  selectAggregateQuality,
  selectFilteredInstrumentIds,
} from "../src/ui/models/boardSelectors.js";

const instrument = (over) => ({
  id: over.id, symbol: over.symbol || over.id, name: over.name || over.id,
  sector: over.sector, exchange: over.exchange, assetClass: over.assetClass,
});

const sample = (over) => ({
  instrumentId: over.id, instrument: instrument(over), sector: over.sector || "Other",
  quality: over.quality || "fresh", change: over.change ?? null, price: over.price ?? null,
  tile: null,
});

describe("selectBoardSamples", () => {
  it("derives samples from state without touching the DOM, resolving by id or symbol", () => {
    const tiles = new Map([
      ["XNAS:AAPL", { price: 100, changePercent: 2, change: 2, quality: "fresh", hasInfo: true }],
      ["JPM", { price: 50, changePercent: -1, change: -0.5, quality: "stale", hasInfo: true }],
    ]);
    const getTile = (identity) => tiles.get(identity);
    const instruments = [
      { id: "XNAS:AAPL", symbol: "AAPL", sector: "Technology" },
      { id: "XNYS:JPM", symbol: "JPM", sector: "Financials" },
      { id: "XNAS:BAD", symbol: "BAD", sector: "Technology" },
    ];

    const samples = selectBoardSamples({ instruments, getTile });
    expect(samples.map((s) => s.quality)).toEqual(["fresh", "stale", "unavailable"]);
    expect(samples.map((s) => s.change)).toEqual([2, -1, null]);
    expect(samples[2].price).toBe(null);
  });

  it("treats hasInfo:false or non-finite price as unavailable", () => {
    const getTile = () => ({ price: null, changePercent: 3, quality: "fresh", hasInfo: false });
    const [s] = selectBoardSamples({ instruments: [{ id: "X", symbol: "X" }], getTile });
    expect(s.quality).toBe("unavailable");
    expect(s.change).toBe(3);
  });

  it("resolves sector to 'Other' rather than assetClass for an instrument with no real classification", () => {
    const getTile = () => ({ price: 100, changePercent: 1, quality: "fresh", hasInfo: true });
    const [s] = selectBoardSamples({ instruments: [{ id: "X", symbol: "X", assetClass: "equity" }], getTile });
    expect(s.sector).toBe("Other");
  });
});

describe("selectBoardSnapshot formulas", () => {
  it("uses 0 (not ±0.5) for advancing/declining and population stdev for dispersion", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", change: 2, sector: "Tech" }),
      sample({ id: "B", change: -1, sector: "Fin" }),
      sample({ id: "C", change: 0.2, sector: "Tech" }),
    ]);
    expect(snap.advancing).toBe(2);
    expect(snap.declining).toBe(1);
    expect(snap.unchanged).toBe(0);
    expect(snap.sampleCount).toBe(3);
    expect(snap.average).toBeCloseTo((2 - 1 + 0.2) / 3, 10);
    const mean = (2 - 1 + 0.2) / 3;
    const variance = ((2 - mean) ** 2 + (-1 - mean) ** 2 + (0.2 - mean) ** 2) / 3;
    expect(snap.dispersion).toBeCloseTo(Math.sqrt(variance), 10);
    expect(snap.breadth).toBeCloseTo(((2 - 1) / 3) * 100, 10);
  });

  it("counts exact zero as unchanged, not advancing or declining", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", change: 0 }),
      sample({ id: "B", change: 0 }),
    ]);
    expect(snap).toMatchObject({ advancing: 0, declining: 0, unchanged: 2, breadth: 0 });
    expect(snap.dispersion).toBe(0);
  });

  it("ignores non-finite changes and returns nulls for an empty comparable set", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", change: null, quality: "unavailable" }),
      sample({ id: "B", change: undefined }),
    ]);
    expect(snap).toMatchObject({
      advancing: 0, declining: 0, unchanged: 0, sampleCount: 0,
      breadth: null, average: null, dispersion: null, leadingSector: null, topMover: null,
    });
  });

  it("picks the leading sector by equal-weight average, breaking ties alphabetically", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", change: 4, sector: "Energy" }),
      sample({ id: "B", change: 2, sector: "Energy" }),
      sample({ id: "C", change: 3, sector: "Health" }),
      sample({ id: "D", change: -5, sector: "Tech" }),
    ]);
    expect(snap.leadingSector).toEqual({ sector: "Energy", average: 3, count: 2 });
  });

  it("excludes unavailable components from the leading sector average", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", change: 2, sector: "Tech" }),
      sample({ id: "B", change: null, quality: "unavailable", sector: "Tech" }),
      sample({ id: "C", change: -1, sector: "Fin" }),
    ]);
    expect(snap.leadingSector).toEqual({ sector: "Tech", average: 2, count: 1 });
  });

  it("picks the top mover by absolute change, keeping the earlier sample on ties", () => {
    const snap = selectBoardSnapshot([
      sample({ id: "A", symbol: "AAA", change: 2 }),
      sample({ id: "B", symbol: "BBB", change: -3.5 }),
      sample({ id: "C", symbol: "CCC", change: 3.5 }),
      sample({ id: "D", symbol: "DDD", change: null, quality: "unavailable" }),
    ]);
    expect(snap.topMover).toEqual({ instrumentId: "B", symbol: "BBB", change: -3.5 });
  });
});

describe("selectAggregateQuality states", () => {
  const q = (quality) => sample({ id: quality + Math.random(), quality });
  it("returns empty for no instruments", () => {
    expect(selectAggregateQuality([]).state).toBe("empty");
  });
  it("returns unavailable when nothing is usable", () => {
    expect(selectAggregateQuality([q("unavailable"), q("unavailable")]).state).toBe("unavailable");
  });
  it("returns confirmed when only last-known-good (stale) data is usable", () => {
    expect(selectAggregateQuality([q("stale"), q("stale"), q("unavailable")]).state).toBe("confirmed");
  });
  it("returns partial when some are live but others unavailable", () => {
    expect(selectAggregateQuality([q("fresh"), q("delayed"), q("unavailable")]).state).toBe("partial");
  });
  it("returns current when every instrument is usable and at least one is live", () => {
    expect(selectAggregateQuality([q("fresh"), q("delayed"), q("stale")]).state).toBe("current");
  });
});

describe("selectFilteredInstrumentIds", () => {
  const board = [
    sample({ id: "AAPL", symbol: "AAPL", name: "Apple", sector: "Technology", change: 2, price: 200, quality: "fresh" }),
    sample({ id: "JPM", symbol: "JPM", name: "JPMorgan", sector: "Financials", change: -1, price: 150, quality: "stale" }),
    sample({ id: "BAD", symbol: "BAD", name: "Broken", sector: "Technology", change: null, price: null, quality: "unavailable" }),
  ];

  it("filters by free text across symbol/name/sector", () => {
    expect(selectFilteredInstrumentIds(board, { search: "apple" })).toEqual(["AAPL"]);
    expect(selectFilteredInstrumentIds(board, { search: "financ" })).toEqual(["JPM"]);
  });
  it("filters by category and movement", () => {
    expect(selectFilteredInstrumentIds(board, { category: "Technology" })).toEqual(["AAPL", "BAD"]);
    expect(selectFilteredInstrumentIds(board, { movement: "gaining" })).toEqual(["AAPL"]);
    expect(selectFilteredInstrumentIds(board, { movement: "available" })).toEqual(["AAPL", "JPM"]);
    expect(selectFilteredInstrumentIds(board, { movement: "unavailable" })).toEqual(["BAD"]);
  });
  it("separates the pulse cohorts from the narrower gainers and losers", () => {
    const drifting = [
      sample({ id: "UP", symbol: "UP", change: 0.2, price: 10, quality: "fresh" }),
      sample({ id: "DOWN", symbol: "DOWN", change: -0.2, price: 10, quality: "fresh" }),
      sample({ id: "FLAT", symbol: "FLAT", change: 0, price: 10, quality: "fresh" }),
    ];

    expect(selectFilteredInstrumentIds(drifting, { movement: "advancing" })).toEqual(["UP"]);
    expect(selectFilteredInstrumentIds(drifting, { movement: "declining" })).toEqual(["DOWN"]);
    expect(selectFilteredInstrumentIds(drifting, { movement: "gaining" })).toEqual([]);
    expect(selectFilteredInstrumentIds(drifting, { movement: "losing" })).toEqual([]);
  });
  it("keeps a tile with no reading out of both pulse cohorts", () => {
    expect(selectFilteredInstrumentIds(board, { movement: "advancing" })).toEqual(["AAPL"]);
    expect(selectFilteredInstrumentIds(board, { movement: "declining" })).toEqual(["JPM"]);
  });
  it("sorts stably, keeping board order as the tiebreak and pushing nulls last", () => {
    expect(selectFilteredInstrumentIds(board, { sort: "change-desc" })).toEqual(["AAPL", "JPM", "BAD"]);
    expect(selectFilteredInstrumentIds(board, { sort: "price-asc" })).toEqual(["JPM", "AAPL", "BAD"]);
    expect(selectFilteredInstrumentIds(board, { sort: "ticker" })).toEqual(["AAPL", "BAD", "JPM"]);
    expect(selectFilteredInstrumentIds(board, { sort: "default" })).toEqual(["AAPL", "JPM", "BAD"]);
  });
});
