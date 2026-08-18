import { describe, expect, it } from "vitest";
import { computeTiers, HERO_COUNT, WIDE_COUNT } from "../src/ui/models/tileTiering.js";

function sample(instrumentId, changePercent) {
  return { instrumentId, changePercent };
}

describe("computeTiers", () => {
  it("ranks by absolute change percent and assigns hero/wide/compact by rank", () => {
    const tiers = computeTiers([
      sample("a", 0.5), sample("b", -8), sample("c", 6), sample("d", -5),
      sample("e", 4), sample("f", -3.5), sample("g", 3), sample("h", -2),
      sample("i", 1.5), sample("j", -0.2),
    ]);
    expect([tiers.get("b"), tiers.get("c"), tiers.get("d")]).toEqual(["hero", "hero", "hero"]);
    expect([tiers.get("e"), tiers.get("f"), tiers.get("g"), tiers.get("h"), tiers.get("i")])
      .toEqual(["wide", "wide", "wide", "wide", "wide"]);
    expect([tiers.get("a"), tiers.get("j")]).toEqual(["compact", "compact"]);
    expect(HERO_COUNT).toBe(3);
    expect(WIDE_COUNT).toBe(8);
  });

  it("promotes immediately when a tile crosses into a bigger tier", () => {
    const tiers = computeTiers(
      [sample("z", 12), sample("y", 1), sample("x", 0.9)],
      new Map([["z", "compact"]]),
    );
    expect(tiers.get("z")).toBe("hero");
  });

  it("keeps a hero inside the demotion margin, then demotes it past the margin", () => {
    const previous = new Map([["z", "hero"]]);
    const held = computeTiers([
      sample("a", 10), sample("b", 9), sample("c", 8), sample("z", 7), sample("d", 6),
    ], previous);
    expect(held.get("z")).toBe("hero");

    const demoted = computeTiers([
      sample("a", 10), sample("b", 9), sample("c", 8), sample("d", 7), sample("e", 6), sample("z", 5),
    ], previous);
    expect(demoted.get("z")).toBe("wide");
  });

  it("keeps a wide tile inside its demotion margin, then drops it to compact", () => {
    const held = computeTiers(
      Array.from({ length: 10 }, (_, index) => sample(`t${index}`, 10 - index)),
      new Map([["t9", "wide"]]),
    );
    expect(held.get("t9")).toBe("wide");

    const demoted = computeTiers(
      Array.from({ length: 11 }, (_, index) => sample(`t${index}`, 10 - index)),
      new Map([["t10", "wide"]]),
    );
    expect(demoted.get("t10")).toBe("compact");
  });

  it("treats missing movement as zero and skips samples without an id", () => {
    const tiers = computeTiers([sample("a", null), { changePercent: 5 }, sample("b", -1)]);
    expect([...tiers.keys()]).toEqual(["b", "a"]);
  });
});
