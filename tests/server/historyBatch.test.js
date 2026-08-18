import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import { MarketDataError } from "../../server/errors/MarketDataError.js";
import { MarketDataOrchestrator } from "../../server/orchestration/MarketDataOrchestrator.js";
import { createMarketDataHandler } from "../../server/http/createMarketDataHandler.js";
import { catalogDescriptorResolver } from "./fixtures/market/curatedDescriptors.js";

function orchestrator() {
  return new MarketDataOrchestrator({
    providers: [{ id: "stub", capabilities: () => ({}), supports: () => false }],
    catalog: { resolve: (id) => ({ id: String(id), assetClass: "equity" }), search: () => [] },
    instrumentResolver: catalogDescriptorResolver(),
    snapshotStore: null,
    clock: () => Date.parse("2026-07-13T20:00:00.000Z"),
  });
}

const history = (id, over = {}) => ({
  data: {
    instrumentId: id, range: "1d", interval: "15m", quality: "fresh",
    bars: [{ close: 1 }], provenance: { source: "yahoo" },
    asOf: "2026-07-13T19:00:00.000Z", ...over,
  },
  nextRefreshAt: "2026-07-13T20:05:00.000Z",
});

describe("orchestrator history batch", () => {
  it("rejects a non-array current-schema batch input with a typed request error", async () => {
    const orch = orchestrator();

    await expect(orch.getHistoryBatch({ ids: ["XNAS:AAPL"] }))
      .rejects.toMatchObject({
        code: ERROR_CODES.INVALID_REQUEST,
        capability: "history",
        retryable: false,
      });
  });

  it("keeps request order and reports per-instrument failures beside the survivors", async () => {
    const orch = orchestrator();
    orch.getHistory = vi.fn(async (id, options) => {
      if (id === "NASDAQ:FAIL") {
        throw new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "no history", { instrumentId: id, retryable: true });
      }
      return {
        ...history(id, { range: options.range, interval: options.interval }),
        nextRefreshAt: id === "NASDAQ:AAPL" ? "2026-07-13T20:01:00.000Z" : "2026-07-13T20:05:00.000Z",
      };
    });

    const out = await orch.getHistoryBatch(
      ["NASDAQ:AAPL", "NASDAQ:FAIL", "NYSE:IBM"],
      { range: "1d", interval: "15m" },
    );

    expect(out.data.map((series) => series.instrumentId)).toEqual(["NASDAQ:AAPL", "NYSE:IBM"]);
    expect(out.data[0]).toMatchObject({ range: "1d", interval: "15m", quality: "fresh" });
    expect(out.errors.map((error) => error.instrumentId)).toEqual(["NASDAQ:FAIL"]);
    expect(out.nextRefreshAt).toBe("2026-07-13T20:01:00.000Z");
  });

  it("dedupes ids and respects the provider concurrency limit", async () => {
    const orch = orchestrator();
    let active = 0;
    let peak = 0;
    orch.getHistory = vi.fn(async (id, options) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return history(id, { range: options.range, interval: options.interval });
    });

    const out = await orch.getHistoryBatch(
      ["A:1", "A:2", "A:3", "A:4", "A:5", "A:6", "A:1"],
      { range: "1d", interval: "15m", maxConcurrency: 2 },
    );

    expect(out.data).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("aborts the whole batch before touching a single instrument", async () => {
    const orch = orchestrator();
    orch.getHistory = vi.fn(async (id) => history(id));
    const controller = new AbortController();
    controller.abort();

    await expect(orch.getHistoryBatch(["A:1"], { signal: controller.signal }))
      .rejects.toMatchObject({ retryable: false });
    expect(orch.getHistory).not.toHaveBeenCalled();
  });

  it("deduplicates IDs that differ only by case", async () => {
    const orch = orchestrator();
    orch.getHistory = vi.fn(async (id) => history(id));

    const out = await orch.getHistoryBatch(["A:1", "a:1", "A:1"], { range: "1d", interval: "15m" });

    expect(orch.getHistory).toHaveBeenCalledTimes(1);
    expect(out.data.map((series) => series.instrumentId)).toEqual(["A:1"]);
  });
});

describe("handler GET /history batch route", () => {
  const service = (over) => ({
    getHistoryBatch: vi.fn(async (ids, options) => ({
      data: ids.map((id) => ({
        instrumentId: id,
        range: options.range,
        interval: options.interval,
        bars: [],
        provenance: { source: "yahoo" },
      })),
      errors: [],
    })),
    ...over,
  });
  const req = (path) => new Request(`http://localhost${path}`);

  it("returns a versioned batch-history envelope", async () => {
    const core = service();
    const handler = createMarketDataHandler({ service: core, requestIdFactory: () => "req" });
    const res = await handler(req("/api/market/v1/history?ids=XNAS:AAPL,XNYS:IBM&range=1d&interval=15m"));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.data).toHaveLength(2);
    expect(payload.data[0]).toMatchObject({ range: "1d", interval: "15m" });
    expect(core.getHistoryBatch).toHaveBeenCalledWith(
      ["XNAS:AAPL", "XNYS:IBM"],
      expect.objectContaining({ range: "1d", interval: "15m" }),
    );
  });

  it("accepts 40 ids and rejects zero ids or a larger board", async () => {
    const handler = createMarketDataHandler({ service: service() });
    const none = await handler(req("/api/market/v1/history?range=1d&interval=15m"));
    const ids = Array.from({ length: 40 }, (_, i) => `XX:${i}`).join(",");
    const accepted = await handler(req(`/api/market/v1/history?ids=${ids}&range=1d&interval=15m`));
    const tooMany = await handler(req(`/api/market/v1/history?ids=${ids},XX:40&range=1d&interval=15m`));
    expect(none.status).toBe(400);
    expect(accepted.status).toBe(200);
    expect(tooMany.status).toBe(400);
  });

  it("enforces the same range/interval allowlist as single history", async () => {
    const handler = createMarketDataHandler({ service: service() });
    const bad = await handler(req("/api/market/v1/history?ids=XNAS:AAPL&range=1y&interval=1m"));
    expect(bad.status).toBe(400);
  });

  it("passes partial errors through the envelope without dropping successful series", async () => {
    const core = service({
      getHistoryBatch: vi.fn(async (ids, options) => ({
        data: [{
          instrumentId: ids[0],
          range: options.range,
          interval: options.interval,
          bars: [],
          provenance: { source: "yahoo" },
        }],
        errors: [new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "no history", { instrumentId: ids[1], retryable: true })],
      })),
    });
    const handler = createMarketDataHandler({ service: core, requestIdFactory: () => "req" });
    const res = await handler(req("/api/market/v1/history?ids=XNAS:AAPL,XNYS:IBM&range=1d&interval=15m"));
    const payload = await res.json();

    expect(payload.data).toHaveLength(1);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].instrumentId).toBe("XNYS:IBM");
  });
});
