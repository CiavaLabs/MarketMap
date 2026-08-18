import { describe, expect, it } from "vitest";
import { FixedHistory } from "../src/core/FixedHistory.js";

describe("FixedHistory", () => {
  it("keeps insertion order while overwriting the oldest value", () => {
    const history = new FixedHistory(3, [1, 2]);
    history.push(3);
    history.push(4);

    expect(history.length).toBe(3);
    expect(history.toArray()).toEqual([2, 3, 4]);
  });

  it("clears without changing capacity", () => {
    const history = new FixedHistory(2, [1, 2]);
    history.clear();
    history.push(3);

    expect(history.toArray()).toEqual([3]);
    expect(history.capacity).toBe(2);
  });
});
