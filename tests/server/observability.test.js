import { describe, expect, it, vi } from "vitest";
import { Telemetry, createStructuredLogger } from "../../server/observability/index.js";

describe("server observability", () => {
  it("aggregates counters and durations without retaining payloads", () => {
    const telemetry = new Telemetry({ clock: () => 1_000 });
    telemetry.increment("cache_hit", { layer: "memory" });
    telemetry.observe("provider_latency_ms", 20, { provider: "primary" });
    telemetry.observe("provider_latency_ms", 40, { provider: "primary" });
    const snapshot = telemetry.snapshot();
    expect(snapshot.counters["cache_hit{layer=memory}"]).toBe(1);
    expect(snapshot.durations["provider_latency_ms{provider=primary}"].average).toBe(30);
  });

  it("redacts secrets in structured logs", () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createStructuredLogger({ sink });
    logger.info({
      endpoint: "health",
      apiKey: "do-not-log",
      nested: { token: "secret" },
      url: "https://finnhub.io/api/v1/quote?symbol=AAPL&token=url-secret",
      message: "Authorization: Bearer bearer-secret",
    });
    const entry = JSON.parse(sink.log.mock.calls[0][0]);
    expect(entry.apiKey).toBe("[REDACTED]");
    expect(entry.nested.token).toBe("[REDACTED]");
    expect(entry.url).toContain("token=[REDACTED]");
    expect(entry.url).not.toContain("url-secret");
    expect(entry.message).toContain("Bearer [REDACTED]");
    expect(entry.message).not.toContain("bearer-secret");
  });
});
