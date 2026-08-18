import { describe, it, expect } from "vitest";
import { UpdateScheduler } from "../src/core/UpdateScheduler.js";

function createScheduler(collector) {
  return new UpdateScheduler(
    (batch) => {
      collector.push(batch);
    },
    { perfLabel: "testScheduler" },
  );
}

describe("UpdateScheduler", () => {
  it("queues unique tickers and flushes immediately", () => {
    const batches = [];
    const scheduler = createScheduler(batches);

    scheduler.request("AAA", 0);
    scheduler.request("AAA", 1);
    scheduler.request("BBB", 2);

    expect(batches.length).toBe(0);

    scheduler.flushImmediate();

    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual([
      { ticker: "AAA", index: 1 },
      { ticker: "BBB", index: 2 },
    ]);
  });

  it("cancels a pending ticker", () => {
    const batches = [];
    const scheduler = createScheduler(batches);

    scheduler.request("AAA", 0);
    scheduler.cancel("AAA");
    scheduler.flushImmediate();

    expect(batches[0]).toEqual([]);
  });

  it("does not accept work after destroy", () => {
    const batches = [];
    const scheduler = createScheduler(batches);
    scheduler.destroy();
    scheduler.request("AAA", 0);
    scheduler.flushImmediate();
    expect(batches).toEqual([]);
  });
});
