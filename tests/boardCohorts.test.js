import { describe, expect, it } from "vitest";

import { selectEligibleBoardCohort } from "../src/ui/models/boardCohorts.js";

const ASSET_CLASSES = [
  "equity",
  "etf",
  "index",
  "fx",
  "crypto",
  "commodity_future",
  "rate_index",
];

function sample(assetClass, overrides = {}) {
  return {
    instrument: { id: assetClass, assetClass },
    capabilities: {
      quote: { status: "supported" },
      history: { status: "supported" },
      details: { status: "unsupported" },
      news: { status: assetClass === "equity" ? "supported" : "unsupported" },
    },
    quote: {
      value: 100,
      changePercent: 1,
      quality: "fresh",
      dataQuality: { status: "usable" },
    },
    ...overrides,
  };
}

describe("selectEligibleBoardCohort", () => {
  it("keeps the pulse equity-only on a seven-class board", () => {
    const samples = ASSET_CLASSES.map((assetClass) => sample(assetClass));
    const cohort = selectEligibleBoardCohort(samples, "pulse");
    expect(cohort).toEqual([samples[0]]);
  });

  it("uses the whole quote-capable board for aggregate quality", () => {
    const samples = ASSET_CLASSES.map((assetClass) => sample(assetClass));
    expect(selectEligibleBoardCohort(samples, "aggregate_quality")).toEqual(samples);

    samples[3].capabilities.quote = { status: "unsupported" };
    expect(selectEligibleBoardCohort(samples, "quality")).not.toContain(samples[3]);
  });

  it("requires a finite, usable percent change for the equity pulse", () => {
    const valid = sample("equity");
    const staleButUsable = sample("equity", { quote: {
      value: 100,
      changePercent: -0.5,
      quality: "stale",
      dataQuality: { status: "usable_with_warnings" },
      fieldAvailability: { changePercent: { status: "stale" } },
    } });
    const unavailable = sample("equity", { quote: { value: null, changePercent: 2, quality: "unavailable" } });
    const invalid = sample("equity", { quote: {
      value: 100,
      changePercent: 2,
      quality: "fresh",
      fieldAvailability: { changePercent: { status: "temporarily_unavailable" } },
    } });
    const notFinite = sample("equity", { quote: { value: 100, changePercent: Number.NaN, quality: "fresh" } });

    expect(selectEligibleBoardCohort(
      [valid, staleButUsable, unavailable, invalid, notFinite],
      "equity_pulse",
    )).toEqual([valid, staleButUsable]);
  });

  it("supports the existing board-sample shape during migration", () => {
    const legacyShape = {
      instrument: { id: "XNAS:AAPL", assetClass: "equity" },
      quality: "fresh",
      change: 0.75,
      tile: { price: 200, changePercent: 0.75, quality: "fresh" },
    };
    expect(selectEligibleBoardCohort([legacyShape], "pulse")).toEqual([legacyShape]);
    expect(selectEligibleBoardCohort([legacyShape], "board_status")).toEqual([legacyShape]);
  });

  it("selects operation-specific cohorts and rejects typos", () => {
    const equity = sample("equity");
    const fx = sample("fx");
    expect(selectEligibleBoardCohort([equity, fx], "news")).toEqual([equity]);
    expect(() => selectEligibleBoardCohort([equity], "pluse")).toThrow(RangeError);
  });
});
