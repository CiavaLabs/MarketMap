import { describe, expect, it } from "vitest";
import { computeRangePosition } from "../src/ui/models/detailViewModel.js";

describe("detailViewModel.computeRangePosition", () => {
  it("normalises and clamps to 0–1 for day and 52-week rails", () => {
    expect(computeRangePosition(150, 100, 200)).toBe(0.5);
    expect(computeRangePosition(250, 100, 200)).toBe(1);
    expect(computeRangePosition(50, 100, 200)).toBe(0);
    expect(computeRangePosition(150, 200, 200)).toBe(null);
  });

  it("returns null for non-finite inputs", () => {
    expect(computeRangePosition(null, 100, 200)).toBe(null);
    expect(computeRangePosition(150, Number.NaN, 200)).toBe(null);
    expect(computeRangePosition(150, 100, undefined)).toBe(null);
  });
});
