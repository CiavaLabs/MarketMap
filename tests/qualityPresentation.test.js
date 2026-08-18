import { describe, expect, it } from "vitest";
import {
  presentAggregateCopy,
  shouldPulse,
  presentTileQuality,
} from "../src/ui/models/qualityPresentation.js";

describe("presentAggregateCopy", () => {
  it("maps every aggregate state to a single line of copy, including 'partial'", () => {
    const time = "14:32";
    expect(presentAggregateCopy("current", { time })).toBe("Last updated 14:32");
    expect(presentAggregateCopy("confirmed", { time })).toBe("Last confirmed 14:32");
    expect(presentAggregateCopy("partial", { time })).toBe("Partial update 14:32");
    expect(presentAggregateCopy("unavailable", { time })).toBe("Update unavailable");
    expect(presentAggregateCopy("empty")).toBe("No instruments");
  });

  it("omits the time when none is available", () => {
    expect(presentAggregateCopy("current")).toBe("Last updated");
  });

  it("never uses the forbidden vocabulary on the main surface", () => {
    for (const state of ["current", "partial", "confirmed", "unavailable", "empty"]) {
      const copy = presentAggregateCopy(state, { time: "10:00" }).toLowerCase();
      expect(copy).not.toContain("stale");
      expect(copy).not.toContain("source unavailable as of");
    }
  });
});

describe("shouldPulse", () => {
  it("pulses only when the state is current", () => {
    expect(shouldPulse("current")).toBe(true);
    for (const state of ["partial", "confirmed", "unavailable", "empty"]) {
      expect(shouldPulse(state)).toBe(false);
    }
  });
});

describe("presentTileQuality", () => {
  it("prefers 'Last confirmed' over 'stale' and falls back to Unavailable", () => {
    expect(presentTileQuality("fresh")).toBe("Fresh");
    expect(presentTileQuality("delayed")).toBe("Delayed");
    expect(presentTileQuality("stale")).toBe("Last confirmed");
    expect(presentTileQuality("unavailable")).toBe("Unavailable");
    expect(presentTileQuality("nonsense")).toBe("Unavailable");
  });
});
