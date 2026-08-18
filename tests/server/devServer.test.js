import { afterEach, describe, expect, it, vi } from "vitest";
import { startDevServer } from "../../server/dev.js";
import { deterministicReturns, historyFromReturns } from "./analytics/fixtures.js";

const runningServers = [];

function fakeMarket() {
  return {
    handleRequest: vi.fn(async () => new Response(JSON.stringify({
      data: { status: "ok" },
      meta: { generatedAt: "2026-07-13T20:00:00.000Z" },
    }), { headers: { "content-type": "application/json" } })),
    getHealth: vi.fn(() => ({
      status: "ok",
      providers: { fixture: { enabled: true } },
      persistence: { adapter: "FixtureStore" },
    })),
    close: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local full-stack server", () => {
  it("serves the UI and same-origin API while blocking private paths", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const market = fakeMarket();
    const running = await startDevServer({
      host: "127.0.0.1",
      port: 0,
      market,
    });
    runningServers.push(running);

    const page = await fetch(`${running.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await page.text()).toContain("data-marketmap-root");

    const health = await fetch(`${running.url}/api/market/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).data).toEqual({ status: "ok" });
    expect(market.handleRequest).toHaveBeenCalledOnce();
    expect((await fetch(`${running.url}/api/market/v2/health`)).status).toBe(404);
    expect(market.handleRequest).toHaveBeenCalledOnce();

    expect((await fetch(`${running.url}/.env`)).status).toBe(404);
    expect((await fetch(`${running.url}/src/%2e%2e%2f.env`)).status).toBe(403);
    expect((await fetch(`${running.url}/package.json`)).status).toBe(404);
  });

  it("allows only self and data URIs for images until a host widens the list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("MARKET_DEV_IMG_SRC", "");
    const closed = await startDevServer({ host: "127.0.0.1", port: 0, market: fakeMarket() });
    runningServers.push(closed);
    expect((await fetch(`${closed.url}/`)).headers.get("content-security-policy"))
      .toContain("img-src 'self' data:;");

    const widened = await startDevServer({
      host: "127.0.0.1",
      port: 0,
      market: fakeMarket(),
      imageSources: "'self' data: https://images.example.com",
    });
    runningServers.push(widened);
    expect((await fetch(`${widened.url}/`)).headers.get("content-security-policy"))
      .toContain("img-src 'self' data: https://images.example.com;");
  });

  it("refuses an image source list that could inject another directive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(startDevServer({
      host: "127.0.0.1",
      port: 0,
      market: fakeMarket(),
      imageSources: "'self'; script-src 'unsafe-inline'",
    })).rejects.toThrow(TypeError);
  });

  it("populates the analytics ledger only when the host configured one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const withoutAnalytics = await startDevServer({ host: "127.0.0.1", port: 0, market: fakeMarket() });
    runningServers.push(withoutAnalytics);
    expect(withoutAnalytics.analyticsReady).toBeNull();

    vi.useFakeTimers({ now: new Date("2026-07-30T23:00:00.000Z"), toFake: ["Date"] });
    const runDailyAnalytics = vi.fn(async () => ({
      status: "completed",
      completedSessionDate: "2026-07-30",
      counts: { requested: 40, available: 40 },
    }));
    const running = await startDevServer({
      host: "127.0.0.1",
      port: 0,
      analyticsDelayMs: 0,
      market: {
        ...fakeMarket(),
        runDailyAnalytics,
        getHistoryBatch: async () => ({
          data: [historyFromReturns({
            instrumentId: "ARCX:SPY",
            assetClass: "etf",
            returns: deterministicReturns(8, 0.0002),
            start: "2026-07-20T21:00:00.000Z",
          })],
        }),
      },
    });
    runningServers.push(running);

    await running.analyticsReady;
    expect(runDailyAnalytics).toHaveBeenCalledOnce();
  });

  it("supports HEAD without sending a static response body", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const running = await startDevServer({ host: "127.0.0.1", port: 0, market: fakeMarket() });
    runningServers.push(running);

    const response = await fetch(`${running.url}/css/marketmap.css`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(await response.text()).toBe("");
  });
});
