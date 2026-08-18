// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";
import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";

const BOARD = STARTER_INSTRUMENTS.slice(0, 3);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount() {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  let releaseSnapshot;
  const snapshotStarted = [];
  const client = {
    snapshot: vi.fn((_ids, { signal } = {}) => new Promise((resolveSnapshot, rejectSnapshot) => {
      releaseSnapshot = resolveSnapshot;
      snapshotStarted.push(true);
      signal?.addEventListener(
        "abort",
        () => rejectSnapshot(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    })),
    historyBatch: vi.fn(async () => ({ data: [], meta: { nextRefreshAt: null } })),
  };
  const app = new AppController(BOARD, {
    root: document.querySelector("[data-marketmap-root]"),
    client,
    pauseWhenHidden: false,
    refreshPolicy: "manual",
  });
  return { app, client, snapshotStarted, release: (value) => releaseSnapshot(value) };
}

describe("AppController superseded refresh", () => {
  it("does not record a board change as a refresh failure", async () => {
    const { app, snapshotStarted } = mount();
    const inFlight = app.refreshNow().catch(() => null);
    await Promise.resolve();
    expect(snapshotStarted).toHaveLength(1);

    app.applyExternalAssets(BOARD.slice(0, 2), { refresh: false });
    await inFlight;
    await Promise.resolve();

    const refresh = app.getRefreshState();
    expect(refresh.failureCount).toBe(0);
    expect(refresh.lastError).toBeNull();
    expect(app.getState().feed.error).toBeNull();
    app.destroy();
  });

  it("leaves the feed status where it was rather than stuck on loading", async () => {
    const { app } = mount();
    expect(app.getState().feed.status).toBe("idle");

    const inFlight = app.refreshNow().catch(() => null);
    await Promise.resolve();
    expect(app.getState().feed.status).toBe("loading");

    app.applyExternalAssets([], { refresh: false });
    await inFlight;
    await Promise.resolve();

    expect(app.getState().feed.status).toBe("idle");
    app.destroy();
  });

  it("keeps auto-refresh scheduled when the very first refresh is superseded", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<main data-marketmap-root></main>';
      let releaseSnapshot = null;
      const snapshot = vi.fn((_ids, { signal } = {}) => new Promise((resolveSnapshot, rejectSnapshot) => {
        releaseSnapshot = resolveSnapshot;
        signal?.addEventListener(
          "abort",
          () => rejectSnapshot(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      }));
      const app = new AppController(BOARD, {
        root: document.querySelector("[data-marketmap-root]"),
        client: {
          snapshot,
          historyBatch: vi.fn(async () => ({ data: [], meta: { nextRefreshAt: null } })),
        },
        pauseWhenHidden: false,
        refreshPolicy: "automatic",
        minimumRefreshMs: 1_000,
      });

      const ready = app.init();
      await Promise.resolve();
      expect(snapshot).toHaveBeenCalledTimes(1);

      app.applyExternalAssets(BOARD.slice(0, 2), { refresh: false });
      await ready;
      await vi.advanceTimersByTimeAsync(0);

      expect(app.getRefreshState().nextRefreshAt).not.toBeNull();

      releaseSnapshot?.({ data: [], errors: [], meta: { nextRefreshAt: null } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(snapshot.mock.calls.length).toBeGreaterThan(1);
      app.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still records a genuine refresh failure", async () => {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const app = new AppController(BOARD, {
      root: document.querySelector("[data-marketmap-root]"),
      client: {
        snapshot: vi.fn(async () => { throw new Error("offline"); }),
        historyBatch: vi.fn(async () => ({ data: [], meta: { nextRefreshAt: null } })),
      },
      pauseWhenHidden: false,
      refreshPolicy: "manual",
    });

    await app.refreshNow().catch(() => null);

    const refresh = app.getRefreshState();
    expect(refresh.failureCount).toBe(1);
    expect(refresh.lastError?.message).toBe("offline");
    expect(app.getState().feed.status).toBe("error");
    app.destroy();
  });
});
