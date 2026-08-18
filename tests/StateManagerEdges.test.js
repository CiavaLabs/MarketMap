import { describe, expect, it, vi } from "vitest";

import { StateManager } from "../src/core/StateManager.js";

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

const instrument = (id, patch = {}) => ({
  id,
  symbol: id.split(":").at(-1),
  name: `${id} Inc.`,
  assetClass: "equity",
  currency: "USD",
  status: "active",
  ...patch,
});

const AAPL = instrument("XNAS:AAPL");
const MSFT = instrument("XNAS:MSFT");

const manager = (instruments = [AAPL, MSFT], options = {}) =>
  new StateManager(instruments, { clock: () => NOW, ...options });

const quote = (instrumentId, patch = {}) => ({
  instrumentId,
  price: 100,
  change: 1,
  changePercent: 1,
  previousClose: 99,
  open: 99.5,
  dayHigh: 101,
  dayLow: 98,
  bid: 99.9,
  ask: 100.1,
  volume: 1_000,
  averageVolume3m: 900,
  marketState: "regular",
  asOf: new Date(NOW).toISOString(),
  fetchedAt: new Date(NOW).toISOString(),
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
  ...patch,
});

describe("instrument normalization", () => {
  it.each([
    ["no id at all", { symbol: "AAPL" }],
    ["a non-canonical id", { id: "AAPL", symbol: "AAPL" }],
    ["a blank id", { id: "   ", symbol: "AAPL" }],
  ])("refuses an instrument with %s", (_label, candidate) => {
    expect(() => manager([candidate])).toThrowError(/canonical id/u);
  });

  it("refuses an instrument with no symbol", () => {
    expect(() => manager([{ id: "XNAS:AAPL" }])).toThrowError(/requires a symbol/u);
  });

  it.each([
    ["a nested instrument", { instrument: AAPL }],
    ["a flat instrumentId", { instrumentId: "XNAS:AAPL", symbol: "AAPL" }],
    ["a ticker alias", { id: "XNAS:AAPL", ticker: "AAPL" }],
  ])("accepts %s", (_label, candidate) => {
    expect(manager([candidate]).getAllTiles().size).toBe(1);
  });

  it("names an instrument after its symbol when it has no name", () => {
    const state = manager([{ id: "XNAS:AAPL", symbol: "aapl " }]);
    expect(state.getTile("XNAS:AAPL")).toMatchObject({ symbol: "aapl", name: "aapl" });
  });

  it("defaults an unstated status to unknown", () => {
    const state = manager([{ id: "XNAS:AAPL", symbol: "AAPL" }]);
    expect(state.getTile("XNAS:AAPL").instrument.status).toBe("unknown");
  });

  it("refuses a duplicate canonical id", () => {
    expect(() => manager([AAPL, AAPL])).toThrowError(/Duplicate canonical instrument id/u);
  });

  it("refuses a board that is not an array", () => {
    expect(() => manager()).not.toThrow();
    expect(() => manager([]).reconcileTiles("AAPL")).toThrowError(/must be an array/u);
  });
});

describe("identity resolution", () => {
  it.each([
    ["a canonical id", "XNAS:AAPL"],
    ["a bare symbol", "AAPL"],
    ["a lowercase symbol", "aapl"],
    ["an object with instrumentId", { instrumentId: "XNAS:AAPL" }],
    ["an object with id", { id: "XNAS:AAPL" }],
    ["an object with symbol", { symbol: "AAPL" }],
    ["an object with ticker", { ticker: "AAPL" }],
  ])("resolves %s", (_label, identity) => {
    expect(manager().resolveInstrumentId(identity)).toBe("XNAS:AAPL");
  });

  it.each([
    ["an unknown symbol", "ZZZZ"],
    ["an empty string", "  "],
    ["null", null],
    ["a number", 42],
    ["an empty object", {}],
  ])("does not resolve %s", (_label, identity) => {
    expect(manager().resolveInstrumentId(identity)).toBeNull();
  });

  it("refuses to guess when two instruments share a symbol", () => {
    const state = manager([
      instrument("XNAS:AAPL"),
      { ...instrument("XLON:AAPL"), symbol: "AAPL" },
    ]);
    expect(state.resolveInstrumentId("AAPL")).toBeNull();
    expect(state.resolveInstrumentId("XNAS:AAPL")).toBe("XNAS:AAPL");
  });

  it("reports the board position, and -1 for anything off the board", () => {
    const state = manager();
    expect(state.getInstrumentIndex("XNAS:MSFT")).toBe(1);
    expect(state.getInstrumentIndex("ZZZZ")).toBe(-1);
  });

  it("returns nothing for a tile it does not hold", () => {
    expect(manager().getTile("ZZZZ")).toBeUndefined();
  });
});

describe("board reconciliation", () => {
  it("keeps quote data when asked to preserve it", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));

    state.reconcileTiles([AAPL], { preserveExistingData: true });
    expect(state.getTile("XNAS:AAPL")).toMatchObject({ price: 100, quality: "fresh" });
  });

  it("drops quote data when asked to rebuild", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));

    state.reinitializeTiles([AAPL]);
    expect(state.getTile("XNAS:AAPL").price).toBeNull();
  });

  it("refreshes identity fields on a preserved tile", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));

    state.reconcileTiles([instrument("XNAS:AAPL", { name: "Apple", sector: "Technology" })], {
      preserveExistingData: true,
    });
    expect(state.getTile("XNAS:AAPL")).toMatchObject({
      name: "Apple",
      sector: "Technology",
      price: 100,
    });
  });

  it("keeps a currency the quote established over the instrument's own", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", { currency: "GBP" }));

    state.reconcileTiles([instrument("XNAS:AAPL", { currency: "USD" })], {
      preserveExistingData: true,
    });
    expect(state.getTile("XNAS:AAPL").currency).toBe("GBP");
  });

  it("falls back to the category when the instrument states no sector", () => {
    const state = manager([instrument("XNAS:AAPL", { category: "Common Stock" })]);
    expect(state.getTile("XNAS:AAPL").sector).toBe("Common Stock");
  });

  it("announces a reconciliation unless told not to", () => {
    const state = manager();
    const listener = vi.fn();
    state.on("tiles:reinitialized", listener);

    state.reconcileTiles([AAPL]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      count: 1,
      instrumentIds: ["XNAS:AAPL"],
    }));

    state.reconcileTiles([AAPL, MSFT], { emit: false });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("quote application", () => {
  it.each([
    ["a non-object", null],
    ["a string", "quote"],
  ])("refuses %s", (_label, value) => {
    expect(() => manager().applyQuoteSnapshot(value)).toThrowError(/must be an object/u);
  });

  it("refuses a quote with no instrument id", () => {
    expect(() => manager().applyQuoteSnapshot({ quality: "fresh" }))
      .toThrowError(/requires instrumentId/u);
  });

  it("refuses a quote for an instrument that is not on the board", () => {
    expect(() => manager().applyQuoteSnapshot(quote("XNAS:ZZZZ")))
      .toThrowError(/Unknown canonical instrument id/u);
  });

  it("drops an unknown instrument silently when asked to", () => {
    expect(manager().applyQuoteSnapshot(quote("XNAS:ZZZZ"), { ignoreUnknown: true })).toBeNull();
  });

  it("refuses a quote addressed by symbol rather than canonical id", () => {
    expect(() => manager().applyQuoteSnapshot(quote("AAPL")))
      .toThrowError(/Unknown canonical instrument id/u);
  });

  it.each([
    ["an unsupported quality", { quality: "cached" }, /Unsupported quote quality/u],
    ["an unsupported market state", { marketState: "auction" }, /Unsupported market state/u],
    ["a non-numeric price", { price: "100" }, /must be a finite number or null/u],
    ["a non-finite price", { price: Number.NaN }, /must be a finite number or null/u],
    ["an unreadable asOf", { asOf: "recently" }, /must be a valid timestamp or null/u],
    ["an unreadable fetchedAt", { fetchedAt: 42 }, /must be a valid timestamp or null/u],
  ])("refuses %s", (_label, patch, pattern) => {
    expect(() => manager().applyQuoteSnapshot(quote("XNAS:AAPL", patch))).toThrowError(pattern);
  });

  it("reads the session phase in preference to the legacy market state", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      marketState: "regular",
      session: { model: "exchange_hours", phase: "closed" },
    }));
    expect(state.getTile("XNAS:AAPL").marketState).toBe("closed");
  });

  it("reports the price it replaced alongside the new one", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", { price: 100 }));
    const payload = state.applyQuoteSnapshot(quote("XNAS:AAPL", { price: 120 }));

    expect(payload).toMatchObject({ oldPrice: 100, newPrice: 120, index: 0 });
  });

  it.each([
    ["an unavailable quality", { quality: "unavailable" }],
    ["no price at all", { price: null }],
    ["an unusable data quality", { dataQuality: { status: "unusable", issues: [] } }],
    ["a not-applicable value", { fieldAvailability: { value: { status: "not_applicable" } } }],
    ["an unsupported value", { fieldAvailability: { value: { status: "unsupported" } } }],
    ["a temporarily unavailable value", { fieldAvailability: { price: { status: "temporarily_unavailable" } } }],
    ["an invalid value", { fieldAvailability: { value: "invalid" } }],
  ])("marks a tile as carrying no information for %s", (_label, patch) => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", patch));
    expect(state.getTile("XNAS:AAPL").hasInfo).toBe(false);
  });

  it("marks a usable quote as carrying information", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      fieldAvailability: { value: { status: "available" } },
      dataQuality: { status: "usable", issues: [] },
    }));
    expect(state.getTile("XNAS:AAPL").hasInfo).toBe(true);
  });

  it("prefers the v2 value over the legacy price", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", { value: 250, price: 100 }));
    expect(state.getTile("XNAS:AAPL")).toMatchObject({ value: 250, price: 100 });
  });

  it("reads provenance in preference to the legacy source", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      source: "yahoo",
      provenance: { source: "finnhub", fallback: true },
    }));
    expect(state.getTile("XNAS:AAPL").source).toBe("finnhub");
  });

  it("defaults the price unit from the instrument, then to currency", () => {
    const priced = manager([instrument("XNAS:AAPL", { priceUnit: "index_points" })]);
    priced.applyQuoteSnapshot(quote("XNAS:AAPL"));
    expect(priced.getTile("XNAS:AAPL").priceUnit).toBe("index_points");

    const plain = manager();
    plain.applyQuoteSnapshot(quote("XNAS:AAPL"));
    expect(plain.getTile("XNAS:AAPL").priceUnit).toBe("currency");
  });

  it("updates a tile addressed by symbol", () => {
    const state = manager();
    const payload = state.updateTile("AAPL", quote("XNAS:AAPL", { price: 111 }));
    expect(payload.newPrice).toBe(111);
  });

  it("declines to update a tile it does not hold", () => {
    expect(manager().updateTile("ZZZZ", {})).toBeNull();
  });
});

describe("batch application", () => {
  it("refuses a batch that is not an array", () => {
    expect(() => manager().applyQuoteBatch("quotes")).toThrowError(/must be an array/u);
  });

  it("keeps a malformed quote from degrading the rest of the batch", () => {
    const state = manager();
    const payload = state.applyQuoteBatch([
      quote("XNAS:AAPL"),
      quote("XNAS:MSFT", { quality: "cached" }),
    ]);

    expect(payload.instrumentIds).toContain("XNAS:AAPL");
    expect(payload.errors.some((error) => error.code === "schema_invalid")).toBe(true);
    expect(state.getTile("XNAS:MSFT").quality).toBe("unavailable");
  });

  it("marks the instruments a caller reported as failed", () => {
    const state = manager();
    const payload = state.applyQuoteBatch([quote("XNAS:AAPL")], {
      errors: [{ instrumentId: "XNAS:MSFT", code: "timeout", message: "slow", retryable: true }],
    });

    expect(state.getTile("XNAS:MSFT")).toMatchObject({ quality: "unavailable", hasInfo: false });
    expect(payload.instrumentIds).toEqual(["XNAS:AAPL", "XNAS:MSFT"]);
  });

  it("does not mark an instrument that the same batch already delivered", () => {
    const state = manager();
    state.applyQuoteBatch([quote("XNAS:AAPL")], {
      errors: [{ instrumentId: "XNAS:AAPL", code: "timeout", message: "slow" }],
    });
    expect(state.getTile("XNAS:AAPL").quality).toBe("fresh");
  });

  it("marks an instrument once even when a batch reports it twice", () => {
    const state = manager();
    const payload = state.applyQuoteBatch([], {
      errors: [
        { instrumentId: "XNAS:MSFT", code: "timeout", message: "slow" },
        { instrumentId: "XNAS:MSFT", code: "rate_limited", message: "slow down" },
      ],
    });
    expect(payload.instrumentIds).toEqual(["XNAS:MSFT"]);
  });

  it("ignores an error for an instrument that is not on the board", () => {
    const state = manager();
    const payload = state.applyQuoteBatch([], {
      errors: [{ instrumentId: "XNAS:ZZZZ", code: "timeout", message: "slow" }],
    });
    expect(payload.instrumentIds).toEqual([]);
  });

  it("ignores an errors option that is not an array", () => {
    const state = manager();
    expect(state.applyQuoteBatch([quote("XNAS:AAPL")], { errors: "boom" }).errors).toEqual([]);
  });

  it("drops unknown instruments from a batch when asked to", () => {
    const state = manager();
    const payload = state.applyQuoteBatch([quote("XNAS:ZZZZ")], { ignoreUnknown: true });
    expect(payload.instrumentIds).toEqual([]);
    expect(payload.errors).toEqual([]);
  });

  it("announces the batch once", () => {
    const state = manager();
    const listener = vi.fn();
    state.on("tiles:batch_updated", listener);
    state.applyQuoteBatch([quote("XNAS:AAPL"), quote("XNAS:MSFT")]);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("unavailability and errors", () => {
  it("declines to mark a tile it does not hold", () => {
    expect(manager().markUnavailable("ZZZZ")).toBeNull();
  });

  it("clears every reading it had", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));
    state.markUnavailable("XNAS:AAPL", new Error("upstream down"));

    expect(state.getTile("XNAS:AAPL")).toMatchObject({
      price: null,
      value: null,
      marketState: "unknown",
      quality: "unavailable",
      hasInfo: false,
      lastTradeTs: 0,
    });
  });

  it.each([
    ["an Error", Object.assign(new Error("boom"), { code: "timeout", retryable: true }), {
      name: "Error",
      code: "timeout",
      message: "boom",
      retryable: true,
    }],
    ["a bare Error", new Error("boom"), { code: "unknown_error", retryable: false }],
    ["a string", "boom", { code: "unknown_error", message: "boom" }],
    ["a plain object", { code: "custom", message: "boom" }, { code: "custom", message: "boom" }],
  ])("records %s", (_label, error, expected) => {
    const state = manager();
    state.markUnavailable("XNAS:AAPL", error);
    expect(state.getTile("XNAS:AAPL").error).toMatchObject(expected);
  });

  it("records no error when there is none", () => {
    const state = manager();
    state.resetTileInfo("XNAS:AAPL");
    expect(state.getTile("XNAS:AAPL").error).toBeNull();
  });

  it("stamps the fetch time the caller supplies", () => {
    const state = manager();
    const at = new Date(NOW).toISOString();
    state.markUnavailable("XNAS:AAPL", null, { fetchedAt: at });
    expect(state.getTile("XNAS:AAPL").fetchedAt).toBe(at);
  });

  it("resets the whole board with one announcement", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));
    const reset = vi.fn();
    const updated = vi.fn();
    state.on("tiles:reset", reset);
    state.on("tile:updated", updated);

    state.resetAllTiles();

    expect(reset).toHaveBeenCalledWith({ instrumentIds: ["XNAS:AAPL", "XNAS:MSFT"] });
    expect(updated).not.toHaveBeenCalled();
    expect(state.getTile("XNAS:AAPL").price).toBeNull();
  });
});

describe("market status", () => {
  it("reports an exchange it has never been told about as unknown", () => {
    expect(manager().getMarketStatus("XNAS")).toBeNull();
  });

  it("announces only a genuine change", () => {
    const state = manager();
    const listener = vi.fn();
    state.on("market:status", listener);

    state.setMarketStatus("XNAS", true);
    state.setMarketStatus("XNAS", true);
    state.setMarketStatus("XNAS", false);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(state.getMarketStatus("XNAS")).toBe(false);
  });

  it("distinguishes a false status from an unknown one", () => {
    const state = manager();
    state.setMarketStatus("XNAS", false);
    expect(state.getMarketStatus("XNAS")).toBe(false);
    expect(state.getMarketStatus("XNYS")).toBeNull();
  });
});

describe("trade staleness", () => {
  it.each([
    ["a tile it does not hold", "ZZZZ", {}],
    ["a stale quote", "XNAS:AAPL", { quality: "stale" }],
    ["an unavailable quote", "XNAS:AAPL", { quality: "unavailable" }],
    ["a quote with no trade time", "XNAS:AAPL", { asOf: null }],
  ])("treats %s as stale", (_label, identity, patch) => {
    const state = manager();
    if (identity !== "ZZZZ") state.applyQuoteSnapshot(quote(identity, patch));
    expect(state.isTradeStale(identity)).toBe(true);
  });

  it("treats a recent fresh trade as current", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL"));
    expect(state.isTradeStale("XNAS:AAPL")).toBe(false);
  });

  it("treats a trade older than the threshold as stale", () => {
    const state = manager();
    state.applyQuoteSnapshot(quote("XNAS:AAPL", {
      asOf: new Date(NOW - 10 * 60_000).toISOString(),
    }));
    expect(state.isTradeStale("XNAS:AAPL")).toBe(true);
    expect(state.isTradeStale("XNAS:AAPL", 20 * 60_000)).toBe(false);
  });
});

describe("serialization", () => {
  it("round-trips a board through serialize and deserialize", () => {
    const source = manager();
    source.applyQuoteSnapshot(quote("XNAS:AAPL", { price: 123.45 }));
    const snapshot = source.serialize();

    const target = manager();
    expect(target.deserialize(snapshot)).toBe(true);
    expect(target.getTile("XNAS:AAPL")).toMatchObject({
      price: 123.45,
      quality: "fresh",
      hasInfo: true,
    });
    expect(snapshot.timestamp).toBe(NOW);
  });

  it.each([
    ["a non-object", null],
    ["a snapshot with no tiles", {}],
    ["a snapshot whose tiles are not an array", { tiles: "none" }],
  ])("refuses %s", (_label, snapshot) => {
    expect(manager().deserialize(snapshot)).toBe(false);
  });

  it("skips an entry for an instrument that is not on the board", () => {
    const state = manager();
    const restored = vi.fn();
    state.on("state:restored", restored);

    expect(state.deserialize({ tiles: [{ instrumentId: "XNAS:ZZZZ", price: 1 }] })).toBe(true);
    expect(restored.mock.calls[0][0].instrumentIds).toEqual([]);
  });

  it("skips a corrupt entry without failing the restore", () => {
    const state = manager();
    const ok = state.deserialize({
      tiles: [
        { instrumentId: "XNAS:AAPL", price: "not-a-number" },
        { instrumentId: "XNAS:MSFT", price: 50, quality: "fresh", asOf: new Date(NOW).toISOString() },
      ],
    });

    expect(ok).toBe(true);
    expect(state.getTile("XNAS:AAPL").price).toBeNull();
    expect(state.getTile("XNAS:MSFT").price).toBe(50);
  });

  it.each([
    ["an unsupported market state", { marketState: "auction" }, "marketState", "unknown"],
    ["an unsupported quality", { quality: "cached" }, "quality", "unavailable"],
  ])("falls back for %s", (_label, patch, field, expected) => {
    const state = manager();
    state.deserialize({ tiles: [{ instrumentId: "XNAS:AAPL", ...patch }] });
    expect(state.getTile("XNAS:AAPL")[field]).toBe(expected);
  });

  it("falls back to the instrument currency when the snapshot has none", () => {
    const state = manager();
    state.deserialize({ tiles: [{ instrumentId: "XNAS:AAPL" }] });
    expect(state.getTile("XNAS:AAPL").currency).toBe("USD");
  });

  it("restores an instrument addressed by symbol", () => {
    const state = manager();
    state.deserialize({ tiles: [{ instrumentId: "AAPL", price: 10, quality: "fresh" }] });
    expect(state.getTile("XNAS:AAPL").price).toBe(10);
  });

  it("hands out copies of a tile rather than the tile itself", () => {
    const state = manager();
    const payload = state.applyQuoteSnapshot(quote("XNAS:AAPL"));
    payload.tile.price = 999;
    payload.tile.instrument.symbol = "MUTATED";

    expect(state.getTile("XNAS:AAPL").price).toBe(100);
    expect(state.getTile("XNAS:AAPL").instrument.symbol).toBe("AAPL");
  });
});
