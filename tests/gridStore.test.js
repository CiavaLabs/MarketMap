import { describe, expect, it, vi } from "vitest";
import { createGridStore } from "../src/react/gridStore.js";

describe("gridStore", () => {
  it("returns a stable empty snapshot for an instrument that never received an update", () => {
    const store = createGridStore();
    const first = store.getSnapshot("aapl");
    const second = store.getSnapshot("aapl");
    expect(first).toBe(second);
    expect(first.viewModel).toBeNull();
  });

  it("notifies only listeners subscribed to the touched instrumentId", () => {
    const store = createGridStore();
    const aaplListener = vi.fn();
    const msftListener = vi.fn();
    store.subscribe("aapl", aaplListener);
    store.subscribe("msft", msftListener);

    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);

    expect(aaplListener).toHaveBeenCalledOnce();
    expect(msftListener).not.toHaveBeenCalled();
  });

  it("bumps the version and replaces the snapshot reference on each update", () => {
    const store = createGridStore();
    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);
    const first = store.getSnapshot("aapl");
    expect(first.version).toBe(1);

    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$2" } }]);
    const second = store.getSnapshot("aapl");
    expect(second.version).toBe(2);
    expect(second).not.toBe(first);
    expect(second.viewModel.formattedValue).toBe("$2");
  });

  it("supports unsubscribing without affecting other listeners", () => {
    const store = createGridStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("aapl", listener);
    unsubscribe();
    store.applyBatch([{ instrumentId: "aapl", viewModel: {} }]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("removes an entry so a later snapshot goes back to empty", () => {
    const store = createGridStore();
    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);
    store.remove("aapl");
    expect(store.getSnapshot("aapl").viewModel).toBeNull();
  });

  it("ignores batch entries with no instrumentId", () => {
    const store = createGridStore();
    store.applyBatch([{ viewModel: { formattedValue: "$1" } }]);
    expect(store.getSnapshot(undefined).viewModel).toBeNull();
  });

  it("keeps independent state across separate store instances", () => {
    const storeA = createGridStore();
    const storeB = createGridStore();
    storeA.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);
    expect(storeB.getSnapshot("aapl").viewModel).toBeNull();
  });

  it("keeps a re-added instrument live when the previous cell unsubscribes late", () => {
    const store = createGridStore();
    const stale = vi.fn();
    const live = vi.fn();

    const unsubscribeStale = store.subscribe("aapl", stale);
    store.remove("aapl");
    store.subscribe("aapl", live);
    unsubscribeStale();

    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);

    expect(live).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it("leaves a still-mounted subscriber attached across a remove", () => {
    const store = createGridStore();
    const listener = vi.fn();
    store.subscribe("aapl", listener);

    store.remove("aapl");
    store.applyBatch([{ instrumentId: "aapl", viewModel: { formattedValue: "$1" } }]);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
