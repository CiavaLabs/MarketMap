// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";
import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(gridApi) {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  return new AppController(STARTER_INSTRUMENTS.slice(0, 12), {
    root: document.querySelector("[data-marketmap-root]"),
    client: {
      snapshot: vi.fn(async () => ({ data: [], errors: [], meta: { nextRefreshAt: null } })),
      historyBatch: vi.fn(async () => ({ data: [], meta: { nextRefreshAt: null } })),
    },
    gridApi,
    pauseWhenHidden: false,
  });
}

describe("AppController bento tiers", () => {
  it("publishes a tier map only when the ranking actually changed", () => {
    vi.useFakeTimers();
    const setTiers = vi.fn();
    const app = mount({ setOrder: vi.fn(), setIndexById: vi.fn(), setTiers });

    vi.advanceTimersByTime(45_000);
    expect(setTiers).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(45_000 * 3);
    expect(setTiers).toHaveBeenCalledTimes(1);

    app.state.getTile(STARTER_INSTRUMENTS[11].id).changePercent = 42;
    vi.advanceTimersByTime(45_000);
    expect(setTiers).toHaveBeenCalledTimes(2);
    expect(setTiers.mock.lastCall[0].get(STARTER_INSTRUMENTS[11].id)).toBe("hero");

    app.destroy();
  });
});
