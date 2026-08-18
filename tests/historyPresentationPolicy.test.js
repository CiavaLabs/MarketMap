import { describe, expect, it } from "vitest";
import { selectHistoryPriceBasis } from "../src/ui/models/historyPresentationPolicy.js";

describe("history presentation policy", () => {
  const priceBases = ["raw", "provider_adjusted"];

  it("keeps intraday equity ranges raw because Yahoo exposes no adjusted-close rows", () => {
    expect(selectHistoryPriceBasis({ assetClass: "equity", range: "1d", interval: "5m", priceBases })).toBe("raw");
    expect(selectHistoryPriceBasis({ assetClass: "equity", range: "5d", interval: "15m", priceBases })).toBe("raw");
  });

  it("uses provider-adjusted equity history at daily resolution", () => {
    expect(selectHistoryPriceBasis({ assetClass: "equity", range: "1m", interval: "1d", priceBases }))
      .toBe("provider_adjusted");
    expect(selectHistoryPriceBasis({ assetClass: "etf", range: "6m", interval: "1d", priceBases }))
      .toBe("provider_adjusted");
  });

  it("never invents a basis outside the declared capability", () => {
    expect(selectHistoryPriceBasis({ assetClass: "fx", range: "1m", interval: "1d", priceBases: ["raw"] }))
      .toBe("raw");
  });
});
