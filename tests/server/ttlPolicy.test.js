import { describe, expect, it } from "vitest";

import { DEFAULT_TTL_POLICY, ttlFor } from "../../server/orchestration/ttlPolicy.js";

describe("v2 asset-aware TTL policy", () => {
  it.each([
    ["exchange open", { assetClass: "equity", session: { model: "exchange_hours", phase: "regular" } }, "quote"],
    ["exchange closed", { assetClass: "equity", session: { model: "exchange_hours", phase: "closed" } }, "quoteClosed"],
    ["FX open", { assetClass: "fx", session: { model: "24x5", phase: "continuous" } }, "quote24x5"],
    ["FX weekend", { assetClass: "fx", session: { model: "24x5", phase: "closed" } }, "quoteClosed"],
    ["crypto", { assetClass: "crypto", session: { model: "24x7", phase: "continuous" } }, "quote24x7"],
    ["index", { assetClass: "index", session: { model: "publisher_schedule", phase: "closed" } }, "quotePublisher"],
    ["future", { assetClass: "commodity_future", session: { model: "provider_schedule", phase: "closed" } }, "quoteFuture"],
  ])("uses a separate %s policy", (_label, quote, policyKey) => {
    expect(ttlFor("quote", quote)).toBe(DEFAULT_TTL_POLICY[policyKey]);
  });

  it("keeps details and intraday/daily history on separate policies", () => {
    expect(ttlFor("details", {})).toBe(DEFAULT_TTL_POLICY.profile);
    expect(ttlFor("history", { interval: "5m" })).toBe(DEFAULT_TTL_POLICY.historyIntraday);
    expect(ttlFor("history", { interval: "1d" })).toBe(DEFAULT_TTL_POLICY.historyDaily);
  });
});
