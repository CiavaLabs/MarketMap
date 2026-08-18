import { describe, expect, it, vi } from "vitest";
import { MarketDataClient } from "../src/api/MarketDataClient.js";

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function envelope(data, errors) {
  return {
    data,
    meta: { apiVersion: "v1", schemaVersion: 2, requestId: "r", generatedAt: "2026-07-13T20:00:00.000Z", nextRefreshAt: null },
    ...(errors ? { errors } : {}),
  };
}

describe("MarketDataClient.historyBatch", () => {
  it("calls GET /history with joined ids and the range/interval pair", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const result = await client.historyBatch(["XNAS:AAPL", "XNYS:IBM"], { range: "1d", interval: "15m" });

    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain("/api/market/v1/history?");
    expect(url).toContain("ids=XNAS%3AAAPL%2CXNYS%3AIBM");
    expect(url).toContain("range=1d");
    expect(url).toContain("interval=15m");
    expect(url).toContain("priceBasis=raw");
    expect(result.data).toEqual([]);
  });

  it("chunks boards larger than 40 while leaving single history independent", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url, "https://marketmap.test");
      const ids = parsed.searchParams.get("ids")?.split(",") || [];
      return jsonResponse(envelope(ids.map((instrumentId) => ({ instrumentId, bars: [] }))));
    });
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const board = Array.from({ length: 47 }, (_, i) => `X:${i}`);
    await expect(client.historyBatch(board)).resolves.toMatchObject({ data: expect.any(Array) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.history("XNAS:AAPL", { range: "1d", interval: "5m" });
    expect(fetchImpl.mock.calls[2][0]).toContain("/api/market/v1/instruments/XNAS%3AAAPL/history");
  });

  it("surfaces partial errors from the envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope(
      [{ instrumentId: "XNAS:AAPL", bars: [], quality: "fresh", provenance: { source: "yahoo" }, asOf: "x" }],
      [{ instrumentId: "XNYS:IBM", code: "upstream_unavailable", message: "no history", retryable: true }],
    )));
    const client = new MarketDataClient({ fetchImpl, timeoutMs: 0 });

    const result = await client.historyBatch(["XNAS:AAPL", "XNYS:IBM"], { range: "1d", interval: "15m" });
    expect(result.data).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].instrumentId).toBe("XNYS:IBM");
  });
});
