import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../server/cache/MemoryCache.js";

describe("MemoryCache", () => {
  it("distinguishes fresh, stale, and expired entries", () => {
    let now = 1_000;
    const cache = new MemoryCache({ clock: () => now });
    cache.set("quote:XNAS:AAPL", { price: 225 }, {
      freshTtlMs: 100,
      staleTtlMs: 500,
    });

    expect(cache.read("quote:XNAS:AAPL")).toMatchObject({
      state: "fresh",
      ageMs: 0,
      value: { price: 225 },
    });

    now = 1_100;
    expect(cache.read("quote:XNAS:AAPL")).toMatchObject({ state: "stale" });
    expect(cache.read("quote:XNAS:AAPL", { allowStale: false })).toBeNull();

    now = 1_501;
    expect(cache.get("quote:XNAS:AAPL")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry at its configured bound", () => {
    const cache = new MemoryCache({ maxEntries: 2, clock: () => 10 });
    cache.set("a", 1, { staleTtlMs: 100 });
    cache.set("b", 2, { staleTtlMs: 100 });
    cache.get("a");
    cache.set("c", 3, { staleTtlMs: 100 });

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(3);
  });

  it("supports injected cloning at cache boundaries", () => {
    const cache = new MemoryCache({
      clock: () => 0,
      clone: (value) => structuredClone(value),
    });
    const value = { nested: { price: 10 } };
    cache.set("quote", value, { staleTtlMs: 100 });
    value.nested.price = 20;
    const cached = cache.get("quote");
    cached.nested.price = 30;

    expect(cache.get("quote")).toEqual({ nested: { price: 10 } });
  });
});
