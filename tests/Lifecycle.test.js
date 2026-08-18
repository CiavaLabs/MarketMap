import { describe, expect, it, vi } from "vitest";
import { Lifecycle } from "../src/core/Lifecycle.js";

describe("Lifecycle", () => {
  it("removes listeners and timers on destroy", () => {
    vi.useFakeTimers();
    const lifecycle = new Lifecycle();
    const target = new EventTarget();
    const listener = vi.fn();
    const timer = vi.fn();

    lifecycle.listen(target, "tick", listener);
    lifecycle.timeout(timer, 10);
    lifecycle.interval(timer, 10);
    target.dispatchEvent(new Event("tick"));
    lifecycle.destroy();
    target.dispatchEvent(new Event("tick"));
    vi.advanceTimersByTime(100);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(timer).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("can cancel owned timers before teardown", () => {
    vi.useFakeTimers();
    const lifecycle = new Lifecycle();
    const callback = vi.fn();
    const timeout = lifecycle.timeout(callback, 10);
    const interval = lifecycle.interval(callback, 10);

    expect(lifecycle.clearTimeout(timeout)).toBe(true);
    expect(lifecycle.clearTimeout(timeout)).toBe(false);
    expect(lifecycle.clearInterval(interval)).toBe(true);
    vi.advanceTimersByTime(100);

    expect(callback).not.toHaveBeenCalled();
    lifecycle.destroy();
    vi.useRealTimers();
  });
});
