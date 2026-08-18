import { describe, expect, it } from "vitest";

import {
  ASSET_CLASSES,
  buildAssetPresentationPolicy,
  resolvePresentationState,
} from "../src/ui/models/assetPresentationPolicy.js";

const matrix = [
  ["equity", "currency", "company", "exchange_traded", true],
  ["etf", "currency", "fund", "exchange_traded", true],
  ["index", "index_points", "index", "provider_reported", false],
  ["fx", "currency_per_unit", "currency_pair", "not_applicable", false],
  ["crypto", "currency", "crypto_asset", "provider_aggregate", false],
  ["commodity_future", "currency", "future_contract", "provider_reported", false],
  ["rate_index", "percent_yield", "rate_index", "not_applicable", false],
];

const sections = {
  equity: ["company_profile", "equity_fundamentals", "analyst_outlook"],
  etf: ["fund_profile", "fund_composition", "fund_stats"],
  index: ["index_metadata", "market_stats"],
  fx: ["pair_metadata"],
  crypto: ["crypto_metadata", "crypto_market_stats"],
  commodity_future: ["future_contract", "future_market_stats", "rollover_notice"],
  rate_index: ["index_metadata", "market_stats"],
};

function capabilities(assetClass) {
  return {
    quote: { status: "supported" },
    history: {
      status: "supported",
      ranges: { "1m": ["1d"] },
      priceBases: assetClass === "equity" || assetClass === "etf"
        ? ["raw", "provider_adjusted"]
        : ["raw"],
    },
    details: { status: "partial", sections: sections[assetClass] },
    news: { status: assetClass === "equity" ? "supported" : "unsupported" },
    analytics: { status: "unsupported", reason: "not_available_in_current_release" },
  };
}

describe("buildAssetPresentationPolicy", () => {
  it.each(matrix)("maps %s product semantics", (assetClass, priceUnit, detailKind, volume, relative) => {
    const policy = buildAssetPresentationPolicy({
      instrument: { id: assetClass, assetClass, priceUnit },
      capabilities: capabilities(assetClass),
    });

    expect(policy).toMatchObject({
      assetClass,
      priceUnit,
      detailKind,
      volumeSemantics: volume,
      supportsRelativeVolume: relative,
    });
    expect(policy.applicableDetailSections).toEqual(sections[assetClass]);
    expect(policy.capabilities.details).toMatchObject({ status: "partial", requestable: true });
  });

  it("covers exactly the seven Fetching v2 asset classes", () => {
    expect(ASSET_CLASSES).toEqual(matrix.map(([assetClass]) => assetClass));
  });

  it("intersects server declarations with applicable sections and history bases", () => {
    const policy = buildAssetPresentationPolicy({
      instrument: { assetClass: "fx", priceUnit: "currency_per_unit" },
      capabilities: {
        ...capabilities("fx"),
        details: { status: "supported", sections: ["company_profile", "pair_metadata"] },
        history: {
          status: "partial",
          ranges: { "1m": ["1d"] },
          priceBases: ["raw", "provider_adjusted"],
        },
        news: { status: "supported" },
      },
    });

    expect(policy.capabilities.details.sections).toEqual(["pair_metadata"]);
    expect(policy.capabilities.history).toMatchObject({ status: "partial", priceBases: ["raw"] });
    expect(policy.capabilities.news).toEqual({
      status: "unsupported",
      requestable: false,
      reason: "asset_class",
    });
  });

  it("fails closed for absent or structurally empty capabilities", () => {
    const policy = buildAssetPresentationPolicy({ assetClass: "equity", priceUnit: "currency" });
    expect(policy.capabilities.quote).toMatchObject({ status: "unsupported", requestable: false });

    const invalidHistory = buildAssetPresentationPolicy(
      { assetClass: "equity" },
      { ...capabilities("equity"), history: { status: "supported", ranges: {}, priceBases: [] } },
    );
    expect(invalidHistory.capabilities.history).toMatchObject({
      status: "unsupported",
      reason: "no_supported_semantics",
    });
  });

  it("exposes only quote fields that apply to the asset semantics", () => {
    const equity = buildAssetPresentationPolicy({
      instrument: { assetClass: "equity" }, capabilities: capabilities("equity"),
    });
    const fx = buildAssetPresentationPolicy({
      instrument: { assetClass: "fx" }, capabilities: capabilities("fx"),
    });
    const rate = buildAssetPresentationPolicy({
      instrument: { assetClass: "rate_index" }, capabilities: capabilities("rate_index"),
    });
    expect(equity.applicableQuoteFields).toEqual(expect.arrayContaining(["bid", "volume", "averageVolume3m"]));
    expect(fx.applicableQuoteFields).toEqual(expect.arrayContaining(["bid", "ask"]));
    expect(fx.applicableQuoteFields).not.toContain("volume");
    expect(rate.applicableQuoteFields).not.toEqual(expect.arrayContaining(["bid", "volume"]));
  });

  it("rejects asset classes outside the v2 taxonomy", () => {
    expect(() => buildAssetPresentationPolicy({ assetClass: "bond" })).toThrow(RangeError);
  });
});

describe("resolvePresentationState", () => {
  const supported = { status: "supported", requestable: true };

  it.each([
    ["unsupported capability", { capability: { status: "unsupported", requestable: false } }, "hidden"],
    ["loading", { capability: supported, requestState: { quote: "loading" }, operation: "quote" }, "loading"],
    ["not applicable", { capability: supported, availability: { status: "not_applicable" } }, "hidden"],
    ["temporary gap", { capability: supported, availability: { status: "temporarily_unavailable" } }, "unavailable"],
    ["stale observation", { capability: supported, availability: { status: "stale" }, hasValue: true }, "stale"],
    ["stale LKG after an error", { capability: supported, requestState: "error", quality: "stale", hasValue: true }, "stale"],
    ["available observation", { capability: supported, availability: { status: "available" }, hasValue: true }, "ready"],
    ["successful empty response", { capability: supported, requestState: "success" }, "empty"],
  ])("resolves %s", (_, input, expected) => {
    expect(resolvePresentationState(input)).toBe(expected);
  });
});
