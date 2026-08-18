import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter.js";

describe("EventEmitter one-shot handlers", () => {
  it("fires a once handler exactly once", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();

    emitter.once("tick", handler);
    emitter.emit("tick", 1);
    emitter.emit("tick", 2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
    expect(emitter.listenerCount("tick")).toBe(0);
  });

  it("still unsubscribes a once handler that throws", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn(() => { throw new Error("boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    emitter.once("tick", handler);
    emitter.emit("tick", 1);
    emitter.emit("tick", 2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("tick")).toBe(0);
    vi.restoreAllMocks();
  });

  it("isolates a throwing handler from the rest of the batch", () => {
    const emitter = new EventEmitter();
    const survivor = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    emitter.on("tick", () => { throw new Error("boom"); });
    emitter.on("tick", survivor);
    emitter.emit("tick", 1);

    expect(survivor).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("binds each disposer to its own registration when one handler is registered twice", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    const offFirst = emitter.on("tick", handler);
    const offSecond = emitter.on("tick", handler);

    offSecond();
    offSecond();

    expect(emitter.listenerCount("tick")).toBe(1);
    emitter.emit("tick", 1);
    expect(handler).toHaveBeenCalledTimes(1);

    offFirst();
    expect(emitter.listenerCount("tick")).toBe(0);
  });

  it("keeps the emitted batch stable when a handler unsubscribes during emit", () => {
    const emitter = new EventEmitter();
    const second = vi.fn();
    const off = emitter.on("tick", () => off());
    emitter.on("tick", second);

    emitter.emit("tick", 1);

    expect(second).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("tick")).toBe(1);
  });
});
