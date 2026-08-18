import { describe, expect, it } from "vitest";
import {
  ALL_ASSET_POLICIES,
  assetPolicyFor,
  detailSectionsFor,
  isAssetClassEnabled,
  normalizeEnabledAssetClasses,
} from "../../../server/instruments/assetPolicies.js";
import {
  MARKET_ASSET_CLASSES,
  DETAIL_KINDS,
  DETAIL_SECTIONS_BY_KIND,
  PRICE_BASES,
  PRICE_UNITS,
  SESSION_MODELS,
  VOLUME_SEMANTICS,
} from "../../../server/contracts/market/constants.js";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { MarketDataError } from "../../../server/errors/MarketDataError.js";

describe("asset policies", () => {
  it.each(MARKET_ASSET_CLASSES.map((assetClass) => [assetClass]))(
    "defines a complete policy for %s",
    (assetClass) => {
      const policy = assetPolicyFor(assetClass);
      expect(PRICE_UNITS).toContain(policy.priceUnit);
      expect(typeof policy.allowNegativePrices).toBe("boolean");
      expect(VOLUME_SEMANTICS).toContain(policy.volume);
      expect(typeof policy.zeroVolumeIsPlaceholder).toBe("boolean");
      expect(["supported", "partial", "not_applicable"]).toContain(policy.bidAsk);
      expect(SESSION_MODELS).toContain(policy.sessionModel);
      expect(DETAIL_KINDS).toContain(policy.detailKind);
      expect(policy.history.priceBases.length).toBeGreaterThan(0);
      for (const basis of policy.history.priceBases) expect(PRICE_BASES).toContain(basis);
      expect(typeof policy.history.corporateActions).toBe("boolean");
      expect(typeof policy.news).toBe("boolean");
      expect(detailSectionsFor(assetClass)).toBe(DETAIL_SECTIONS_BY_KIND[policy.detailKind]);
    },
  );

  it("covers exactly the v2 asset classes", () => {
    expect(Object.keys(ALL_ASSET_POLICIES).sort()).toEqual([...MARKET_ASSET_CLASSES].sort());
  });

  it("pins the semantics the plan mandates", () => {
    expect(assetPolicyFor("fx").volume).toBe("not_applicable");
    expect(assetPolicyFor("rate_index").priceUnit).toBe("percent_yield");
    expect(assetPolicyFor("rate_index").allowNegativePrices).toBe(true);
    expect(assetPolicyFor("commodity_future").allowNegativePrices).toBe(true);
    expect(assetPolicyFor("crypto").sessionModel).toBe("24x7");
    expect(assetPolicyFor("fx").sessionModel).toBe("24x5");
    expect(assetPolicyFor("equity").history.priceBases).toContain("provider_adjusted");
    expect(assetPolicyFor("index").history.priceBases).toEqual(["raw"]);
    expect(assetPolicyFor("equity").news).toBe(true);
    expect(assetPolicyFor("etf").news).toBe(false);
  });

  it("rejects legacy classes instead of guessing", () => {
    for (const legacy of ["bond", "mutual_fund", "commodity_proxy", "warrant"]) {
      expect(() => assetPolicyFor(legacy)).toThrowError(MarketDataError);
      try {
        assetPolicyFor(legacy);
      } catch (error) {
        expect(error.code).toBe(ERROR_CODES.UNSUPPORTED_ASSET);
      }
    }
  });
});

describe("feature policy", () => {
  it("defaults to every asset class whose rollout gate is complete", () => {
    expect(normalizeEnabledAssetClasses()).toEqual([
      "equity",
      "etf",
      "index",
      "fx",
      "crypto",
      "commodity_future",
      "rate_index",
    ]);
    expect(isAssetClassEnabled("equity")).toBe(true);
    expect(isAssetClassEnabled("etf")).toBe(true);
  });

  it("normalizes and validates custom configurations", () => {
    expect(normalizeEnabledAssetClasses(["equity", "etf", "equity"])).toEqual(["equity", "etf"]);
    expect(() => normalizeEnabledAssetClasses([])).toThrowError(MarketDataError);
    expect(() => normalizeEnabledAssetClasses(["mutual_fund"])).toThrowError(MarketDataError);
    expect(() => normalizeEnabledAssetClasses(["bond"])).toThrowError(MarketDataError);
  });
});
