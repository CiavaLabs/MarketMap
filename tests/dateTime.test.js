import { describe, expect, it } from "vitest";
import { MARKETMAP_TIME_ZONE, formatMarketMapTime } from "../src/utils/dateTime.js";

describe("Market Map presentation time", () => {
  it("uses the visitor zone by default and respects an explicit override", () => {
    expect(MARKETMAP_TIME_ZONE).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(formatMarketMapTime("2026-07-15T16:15:00.000Z", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      timeZone: "America/New_York",
    })).toBe("12:15:00");
  });

  it("keeps invalid instants honest", () => {
    expect(formatMarketMapTime("not-a-timestamp", { hour: "2-digit" })).toBe("—");
  });
});
