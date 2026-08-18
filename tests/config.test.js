import { describe, expect, it } from "vitest";
import {
  CONFIG,
  MAX_TOTAL_TICKERS,
  getApiBaseUrl,
  normalizeMaxBoardSize,
} from "../src/config.js";
import {
  DEFAULT_WORKSPACE_ID,
  STARTER_WORKSPACE,
  STARTER_INSTRUMENTS,
  getWorkspace,
} from "../src/data/workspaces.js";

describe("real-only client configuration", () => {
  it("uses the versioned same-origin API and server-directed refresh policy", () => {
    expect(CONFIG.API).toEqual({
      BASE_URL: "/api/market/v1",
      MAX_BATCH_IDS: 40,
      BATCH_CONCURRENCY: 2,
      REQUEST_TIMEOUT_MS: 6_000,
      HISTORY_BATCH_TIMEOUT_MS: 30_000,
      NEWS_BATCH_TIMEOUT_MS: 30_000,
    });
    expect(CONFIG.ENABLED_ASSET_CLASSES).toEqual([
      "equity",
      "etf",
      "index",
      "fx",
      "crypto",
      "commodity_future",
      "rate_index",
    ]);
    expect(CONFIG.BOARD).toEqual({ DEFAULT_MAX_SIZE: 60, HARD_MAX_SIZE: 100 });
    expect(CONFIG.STORAGE.BOARD_V2).toBe("marketmap-board-v2");
    expect(CONFIG.STORAGE.BOARDS_V3).toBe("marketmap-boards-v3");
    expect(CONFIG.REFRESH).toEqual({
      POLICY: "automatic",
      MINIMUM_MS: 5_000,
      HISTORY_MS: 5 * 60_000,
    });
    expect(CONFIG.NEWS).toEqual({
      BOARD_LIMIT: 12,
      MODAL_LIMIT: 4,
    });
    expect(getApiBaseUrl()).toBe("/api/market/v1");
    expect(getApiBaseUrl(" /custom/market/v1/// ")).toBe("/custom/market/v1");
    expect(Object.isFrozen(CONFIG)).toBe(true);
    expect(Object.isFrozen(CONFIG.API)).toBe(true);
  });

  it("keeps provider credentials out of client configuration", () => {
    expect(CONFIG).not.toHaveProperty("API_KEY");
    expect(JSON.stringify(CONFIG)).not.toMatch(/api.?key/i);
  });

  it("defines a canonical 40-instrument starter board within a separate 60-slot product limit", () => {
    expect(MAX_TOTAL_TICKERS).toBe(60);
    expect(DEFAULT_WORKSPACE_ID).toBe("us-equities");
    expect(getWorkspace(DEFAULT_WORKSPACE_ID)).toBe(STARTER_WORKSPACE);
    expect(STARTER_INSTRUMENTS).toHaveLength(40);
    expect(STARTER_INSTRUMENTS.length).toBeLessThanOrEqual(MAX_TOTAL_TICKERS);

    const ids = STARTER_INSTRUMENTS.map((instrument) => instrument.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STARTER_INSTRUMENTS.every((instrument) => (
      /^[A-Z0-9]{2,6}:[A-Z0-9.^=_-]+$/.test(instrument.id)
      && instrument.symbol
      && !Object.hasOwn(instrument, "price")
      && !Object.hasOwn(instrument, "change")
      && !Object.hasOwn(instrument, "basePrice")
    ))).toBe(true);
  });

  it("accepts custom board sizes within the operational ceiling", () => {
    expect(normalizeMaxBoardSize(20)).toBe(20);
    expect(normalizeMaxBoardSize(80)).toBe(80);
    expect(() => normalizeMaxBoardSize(101)).toThrow(/between 1 and 100/);
  });
});
