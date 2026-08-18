import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

describe("package entrypoint", () => {
  it("exports a version that matches the manifest", async () => {
    const api = await import("../src/index.js?version");

    expect(api.MARKETMAP_VERSION).toBe(manifest.version);
  });

  it("exports the public client surface", async () => {
    const api = await import("../src/index.js?exports");

    expect(api.createMarketMap).toBeTypeOf("function");
    expect(api.createMarketMapExperience).toBeTypeOf("function");
    expect(api.renderMarketMapShell).toBeTypeOf("function");
    expect(api.MarketDataClient).toBeTypeOf("function");
    expect(api.RefreshCoordinator).toBeTypeOf("function");
    expect(api.StateManager).toBeTypeOf("function");
    expect(api.STARTER_WORKSPACE.instruments[0].id).toContain(":");
    expect(api.formatNewsTimestamp).toBeTypeOf("function");
    expect(api.renderNewsList).toBeUndefined();
  });

  it("does not attach diagnostics or provider credentials to the host window", async () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    vi.resetModules();

    try {
      await import("../src/index.js?entrypoint");
      expect(window.__marketmapPerf).toBeUndefined();
      expect(window.showMarketMapPerf).toBeUndefined();
      expect(window.FINNHUB_API_KEY).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  });
});
