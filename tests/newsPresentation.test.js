import { describe, expect, it } from "vitest";
import {
  formatNewsSourceNames,
  formatNewsTimestamp,
  MAX_VISIBLE_INSTRUMENTS,
} from "../src/ui/models/newsPresentation.js";

function localTimestamp(value) {
  return new Intl.DateTimeFormat("en-US", {
    hourCycle: "h23",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

describe("news presentation", () => {
  it("renders a publication time in the visitor's locale and marks an unusable one", () => {
    expect(formatNewsTimestamp("2026-07-15T16:10:00.000Z"))
      .toBe(localTimestamp("2026-07-15T16:10:00.000Z"));
    expect(formatNewsTimestamp("invalid")).toBe("—");
    expect(formatNewsTimestamp(null)).toBe("—");
  });

  it("names only the providers that published, once each, whichever side reported them", () => {
    expect(formatNewsSourceNames([], ["yahoo"])).toBe("Yahoo Finance");
    expect(formatNewsSourceNames([{ provider: "finnhub" }], ["yahoo"]))
      .toBe("Yahoo Finance and Finnhub");
    expect(formatNewsSourceNames([{ provider: "yahoo" }], ["yahoo", "yahoo"]))
      .toBe("Yahoo Finance");
  });

  it("drops sources that are not news providers, and falls back when none remain", () => {
    expect(formatNewsSourceNames([], ["last-known-good"])).toBe("news providers");
    expect(formatNewsSourceNames([{ provider: "cache" }], ["yahoo", "last-known-good"]))
      .toBe("Yahoo Finance");
    expect(formatNewsSourceNames(null, null)).toBe("news providers");
  });

  it("caps how many instruments an article lists before it counts the rest", () => {
    expect(MAX_VISIBLE_INSTRUMENTS).toBe(3);
  });
});
