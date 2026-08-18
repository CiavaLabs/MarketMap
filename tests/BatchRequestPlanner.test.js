import { describe, expect, it, vi } from "vitest";
import {
  BatchRequestPlanner,
  DEFAULT_BATCH_CHUNK_SIZE,
  DEFAULT_BATCH_CONCURRENCY,
} from "../src/api/BatchRequestPlanner.js";

describe("BatchRequestPlanner", () => {
  it("deduplicates in board order and splits 47 items into 40 + 7", async () => {
    const planner = new BatchRequestPlanner({ chunkSize: 40 });
    const board = Array.from({ length: 47 }, (_, index) => `X:${index}`);
    const worker = vi.fn(async (chunk) => [...chunk]);

    const results = await planner.execute([
      board[0],
      ...board,
      board[19],
    ], worker);

    expect(worker).toHaveBeenCalledTimes(2);
    expect(results.map(({ items }) => items.length)).toEqual([40, 7]);
    expect(results.flatMap(({ items }) => items)).toEqual(board);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("bounds worker concurrency while returning chunk results in plan order", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const started = [];
    const planner = new BatchRequestPlanner({ chunkSize: 1, concurrency: 2 });

    const running = planner.execute(["A", "B", "C", "D"], async (chunk, { chunkIndex }) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(chunkIndex);
      await gate;
      active -= 1;
      return chunk[0].toLowerCase();
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    release();
    const results = await running;

    expect(peak).toBe(2);
    expect(results.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(results.map(({ value }) => value)).toEqual(["a", "b", "c", "d"]);
  });

  it("fans caller abort out to active workers and stops scheduling chunks", async () => {
    const planner = new BatchRequestPlanner({ chunkSize: 1, concurrency: 2 });
    const controller = new AbortController();
    const reason = new DOMException("board changed", "AbortError");
    const workerSignals = [];
    const started = [];

    const running = planner.execute(["A", "B", "C", "D"], (chunk, context) => {
      started.push(chunk[0]);
      workerSignals.push(context.signal);
      return new Promise((_, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    }, { signal: controller.signal });

    await vi.waitFor(() => expect(workerSignals).toHaveLength(2));
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(workerSignals.every((signal) => signal.aborted && signal.reason === reason)).toBe(true);
    expect(started).toEqual(["A", "B"]);
  });

  it("keeps item payloads opaque and isolates a rejected chunk", async () => {
    const planner = new BatchRequestPlanner({ chunkSize: 2, concurrency: 2 });
    const chunkFailure = new Error("chunk offline");

    const results = await planner.execute(["A", "B", "C", "D", "E"], async (chunk, { chunkIndex }) => {
      if (chunkIndex === 0) {
        return {
          data: [chunk[0]],
          errors: [{ item: chunk[1], code: "item_unavailable" }],
        };
      }
      if (chunkIndex === 1) throw chunkFailure;
      return { data: chunk, errors: [] };
    });

    expect(results.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[0].value).toEqual({
      data: ["A"],
      errors: [{ item: "B", code: "item_unavailable" }],
    });
    expect(results[1]).toMatchObject({
      chunkIndex: 1,
      items: ["C", "D"],
      reason: chunkFailure,
    });
    expect(results[2].value).toEqual({ data: ["E"], errors: [] });
  });

  it("applies an overall timeout and aborts every active chunk", async () => {
    vi.useFakeTimers();
    try {
      const planner = new BatchRequestPlanner({ chunkSize: 1, concurrency: 2 });
      const signals = [];
      const running = planner.execute(["A", "B", "C"], (_chunk, { signal }) => {
        signals.push(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }, { timeoutMs: 250 });

      await vi.waitFor(() => expect(signals).toHaveLength(2));
      const rejected = expect(running).rejects.toMatchObject({
        name: "TimeoutError",
        code: "timeout",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(250);

      await rejected;
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(signals).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BatchRequestPlanner argument validation", () => {
  it.each([
    ["a zero chunk size", { chunkSize: 0 }, /chunkSize must be a positive integer/u],
    ["a fractional chunk size", { chunkSize: 2.5 }, /chunkSize/u],
    ["a zero concurrency", { concurrency: 0 }, /concurrency must be a positive integer/u],
    ["a non-function keyOf", { keyOf: "id" }, /keyOf must be a function/u],
  ])("refuses to build a planner with %s", (_label, options, pattern) => {
    expect(() => new BatchRequestPlanner(options)).toThrowError(pattern);
  });

  it("defaults to forty-item chunks and two workers", () => {
    const planner = new BatchRequestPlanner();
    expect(planner.chunkSize).toBe(DEFAULT_BATCH_CHUNK_SIZE);
    expect(planner.concurrency).toBe(DEFAULT_BATCH_CONCURRENCY);
  });

  it("rejects items that are not an array", () => {
    expect(() => new BatchRequestPlanner().plan("XNAS:AAPL"))
      .toThrowError(/items must be an array/u);
  });

  it("honours a per-call chunk size and keyOf", () => {
    const planner = new BatchRequestPlanner({ chunkSize: 10 });
    const items = [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "c" }];

    const chunks = planner.plan(items, { chunkSize: 2, keyOf: (item) => item.id });

    expect(chunks).toHaveLength(2);
    expect(chunks.flat().map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["a per-call chunk size", { chunkSize: 0 }, /chunkSize/u],
    ["a per-call keyOf", { keyOf: 42 }, /keyOf must be a function/u],
  ])("rejects %s", (_label, options, pattern) => {
    expect(() => new BatchRequestPlanner().plan(["a"], options)).toThrowError(pattern);
  });

  it("plans nothing for an empty list", () => {
    expect(new BatchRequestPlanner().plan([])).toEqual([]);
  });

  it("rejects a worker that is not a function", async () => {
    await expect(new BatchRequestPlanner().execute(["a"], "worker"))
      .rejects.toThrowError(/worker must be a function/u);
  });

  it.each([
    ["a plain object", {}],
    ["a partial signal", { aborted: false, addEventListener() {} }],
  ])("rejects %s as a signal", async (_label, signal) => {
    await expect(new BatchRequestPlanner().execute(["a"], () => {}, { signal }))
      .rejects.toThrowError(/signal must be an AbortSignal/u);
  });

  it("accepts an absent signal", async () => {
    const results = await new BatchRequestPlanner()
      .execute(["a"], async () => "ok", { signal: null });
    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok" });
  });

  it.each([
    ["a negative timeout", -1],
    ["a non-finite timeout", Number.NaN],
  ])("rejects %s", async (_label, timeoutMs) => {
    await expect(new BatchRequestPlanner().execute(["a"], async () => "ok", { timeoutMs }))
      .rejects.toThrowError(/non-negative finite number/u);
  });

  it("treats a zero timeout as no deadline at all", async () => {
    const results = await new BatchRequestPlanner()
      .execute(["a"], async () => "ok", { timeoutMs: 0 });
    expect(results[0].value).toBe("ok");
  });

  it("returns nothing without running a worker when there is nothing to do", async () => {
    const worker = vi.fn();
    expect(await new BatchRequestPlanner().execute([], worker)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("refuses work whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    const worker = vi.fn();

    await expect(new BatchRequestPlanner()
      .execute(["a"], worker, { signal: controller.signal }))
      .rejects.toThrowError("caller went away");
    expect(worker).not.toHaveBeenCalled();
  });

  it("raises an AbortError when the caller aborts without a reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await new BatchRequestPlanner()
      .execute(["a"], vi.fn(), { signal: controller.signal })
      .catch((caught) => caught);
    expect(error.name).toBe("AbortError");
  });

  it("caps worker count at the number of chunks", async () => {
    let peak = 0;
    let active = 0;
    const planner = new BatchRequestPlanner({ chunkSize: 1, concurrency: 8 });
    await planner.execute(["a", "b"], async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return "ok";
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
