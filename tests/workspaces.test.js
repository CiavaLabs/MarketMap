import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ID,
  STARTER_INSTRUMENTS,
  STARTER_WORKSPACE,
  WORKSPACES,
  getWorkspace,
} from "../src/data/workspaces.js";
import {
  DEFAULT_BOARD_IDS,
  DEFAULT_EQUITY_BOARD_IDS,
  InstrumentCatalog,
} from "../server/instruments/InstrumentCatalog.js";

describe("market workspaces", () => {
  it("defines a 40-instrument cross-asset board with canonical ids", () => {
    expect(STARTER_INSTRUMENTS).toHaveLength(40);
    expect(new Set(STARTER_INSTRUMENTS.map(({ id }) => id)).size).toBe(40);

    STARTER_INSTRUMENTS.forEach((instrument) => {
      expect(instrument.id).toMatch(/^[A-Z0-9]{2,6}:[A-Z0-9.^=_-]+$/);
      expect(instrument.status).toBe("active");
      expect(instrument.name).toBeTruthy();
      expect(instrument.symbol).toBeTruthy();
    });

    expect(new Set(STARTER_INSTRUMENTS.map(({ assetClass }) => assetClass))).toEqual(new Set([
      "equity",
      "etf",
      "index",
      "fx",
      "crypto",
      "rate_index",
      "commodity_future",
    ]));
  });

  it("interleaves the classes instead of grouping them", () => {
    const classes = STARTER_INSTRUMENTS.map(({ assetClass }) => assetClass);
    const lastOther = classes.reduce((last, c, i) => (c === "equity" ? last : i), -1);
    expect(lastOther).toBeLessThan(Math.ceil(classes.length * 2 / 3));

    for (let i = 0; i + 6 <= lastOther; i += 1) {
      expect(classes.slice(i, i + 6).every((c) => c === "equity")).toBe(false);
    }
  });

  it("keeps every equity carrying its exchange identity and sector", () => {
    STARTER_INSTRUMENTS.filter(({ assetClass }) => assetClass === "equity").forEach((instrument) => {
      expect(instrument.id).toBe(`${instrument.mic}:${instrument.symbol}`);
      expect(instrument).toMatchObject({ currency: "USD", country: "US" });
      expect(["NASDAQ", "NYSE"]).toContain(instrument.exchange);
      expect(instrument.sector).toBeTruthy();
    });
  });

  it("contains metadata only and never seeds market values", () => {
    const forbiddenMarketFields = [
      "price",
      "basePrice",
      "change",
      "changePercent",
      "open",
      "previousClose",
      "dayHigh",
      "dayLow",
      "volume",
      "fundamentals",
    ];

    STARTER_INSTRUMENTS.forEach((instrument) => {
      forbiddenMarketFields.forEach((field) => {
        expect(instrument).not.toHaveProperty(field);
      });
    });
  });

  it("exports immutable workspace metadata and a stable default lookup", () => {
    expect(DEFAULT_WORKSPACE_ID).toBe("us-equities");
    expect(WORKSPACES).toEqual([STARTER_WORKSPACE]);
    expect(STARTER_WORKSPACE.instrumentIds).toEqual(
      STARTER_INSTRUMENTS.map(({ id }) => id),
    );
    expect(getWorkspace()).toBe(STARTER_WORKSPACE);
    expect(getWorkspace("missing")).toBeNull();
    expect(Object.isFrozen(WORKSPACES)).toBe(true);
    expect(Object.isFrozen(STARTER_WORKSPACE)).toBe(true);
    expect(Object.isFrozen(STARTER_INSTRUMENTS)).toBe(true);
    expect(STARTER_INSTRUMENTS.every(Object.isFrozen)).toBe(true);
  });

  it("uses the same canonical sector taxonomy as the server catalog", () => {
    const catalog = new InstrumentCatalog();

    expect(DEFAULT_BOARD_IDS).toEqual(STARTER_WORKSPACE.instrumentIds);
    expect(DEFAULT_EQUITY_BOARD_IDS).toEqual(
      STARTER_INSTRUMENTS.filter(({ assetClass }) => assetClass === "equity").map(({ id }) => id),
    );
    for (const instrument of STARTER_INSTRUMENTS.filter(({ assetClass }) => assetClass === "equity")) {
      expect(catalog.resolve(instrument.id).sector).toBe(instrument.sector);
    }
  });
});
