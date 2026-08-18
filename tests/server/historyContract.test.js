import { describe, expect, it } from "vitest";
import {
  HISTORY_DEFAULT_INTERVALS,
  historyStartDate,
  isHistoryRangeIntervalSupported,
} from "../../server/contracts/core/history.js";

describe("public history contract", () => {
  it("supports five years only at daily-or-coarser resolutions", () => {
    expect(HISTORY_DEFAULT_INTERVALS["5y"]).toBe("1wk");
    expect(isHistoryRangeIntervalSupported("5y", "1d")).toBe(true);
    expect(isHistoryRangeIntervalSupported("5y", "1wk")).toBe(true);
    expect(isHistoryRangeIntervalSupported("5y", "1mo")).toBe(true);
    expect(isHistoryRangeIntervalSupported("5y", "5m")).toBe(false);
  });

  it("uses calendar boundaries without overflowing leap days or month ends", () => {
    expect(historyStartDate("5y", "2024-02-29T12:00:00.000Z")?.toISOString())
      .toBe("2019-02-28T12:00:00.000Z");
    expect(historyStartDate("1m", "2025-03-31T12:00:00.000Z")?.toISOString())
      .toBe("2025-02-28T12:00:00.000Z");
    expect(historyStartDate("unknown", "2025-03-31T12:00:00.000Z")).toBeNull();
  });
});
