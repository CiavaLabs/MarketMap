import {
  MARKET_ASSET_CLASSES,
  DEFAULT_ENABLED_ASSET_CLASSES,
  DETAIL_SECTIONS_BY_KIND,
} from "../contracts/market/constants.js";
import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";

const ASSET_POLICIES = Object.freeze({
  equity: Object.freeze({
    priceUnit: "currency",
    allowNegativePrices: false,
    volume: "exchange_traded",
    zeroVolumeIsPlaceholder: false,
    bidAsk: "supported",
    sessionModel: "exchange_hours",
    detailKind: "company",
    history: Object.freeze({
      priceBases: Object.freeze(["raw", "provider_adjusted"]),
      corporateActions: true,
    }),
    news: true,
  }),
  etf: Object.freeze({
    priceUnit: "currency",
    allowNegativePrices: false,
    volume: "exchange_traded",
    zeroVolumeIsPlaceholder: false,
    bidAsk: "supported",
    sessionModel: "exchange_hours",
    detailKind: "fund",
    history: Object.freeze({
      priceBases: Object.freeze(["raw", "provider_adjusted"]),
      corporateActions: true,
    }),
    news: false,
  }),
  index: Object.freeze({
    priceUnit: "index_points",
    allowNegativePrices: false,
    volume: "provider_reported",
    zeroVolumeIsPlaceholder: true,
    bidAsk: "not_applicable",
    sessionModel: "publisher_schedule",
    detailKind: "index",
    history: Object.freeze({
      priceBases: Object.freeze(["raw"]),
      corporateActions: false,
    }),
    news: false,
  }),
  fx: Object.freeze({
    priceUnit: "currency_per_unit",
    allowNegativePrices: false,
    volume: "not_applicable",
    zeroVolumeIsPlaceholder: true,
    bidAsk: "partial",
    sessionModel: "24x5",
    detailKind: "currency_pair",
    history: Object.freeze({
      priceBases: Object.freeze(["raw"]),
      corporateActions: false,
    }),
    news: false,
  }),
  crypto: Object.freeze({
    priceUnit: "currency",
    allowNegativePrices: false,
    volume: "provider_aggregate",
    zeroVolumeIsPlaceholder: true,
    bidAsk: "partial",
    sessionModel: "24x7",
    detailKind: "crypto_asset",
    history: Object.freeze({
      priceBases: Object.freeze(["raw"]),
      corporateActions: false,
    }),
    news: false,
  }),
  commodity_future: Object.freeze({
    priceUnit: "currency",
    allowNegativePrices: true,
    volume: "provider_reported",
    zeroVolumeIsPlaceholder: true,
    bidAsk: "partial",
    sessionModel: "provider_schedule",
    detailKind: "future_contract",
    history: Object.freeze({
      priceBases: Object.freeze(["raw"]),
      corporateActions: false,
    }),
    news: false,
  }),
  rate_index: Object.freeze({
    priceUnit: "percent_yield",
    allowNegativePrices: true,
    volume: "not_applicable",
    zeroVolumeIsPlaceholder: true,
    bidAsk: "not_applicable",
    sessionModel: "publisher_schedule",
    detailKind: "rate_index",
    history: Object.freeze({
      priceBases: Object.freeze(["raw"]),
      corporateActions: false,
    }),
    news: false,
  }),
});

export function assetPolicyFor(assetClass) {
  const policy = ASSET_POLICIES[assetClass];
  if (!policy) {
    throw new MarketDataError(
      ERROR_CODES.UNSUPPORTED_ASSET,
      `No asset policy is defined for ${String(assetClass)}`,
      { retryable: false, details: { assetClass } },
    );
  }
  return policy;
}

export function detailSectionsFor(assetClass) {
  return DETAIL_SECTIONS_BY_KIND[assetPolicyFor(assetClass).detailKind];
}

export function normalizeEnabledAssetClasses(value = DEFAULT_ENABLED_ASSET_CLASSES) {
  if (!Array.isArray(value) || !value.length) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      "enabledAssetClasses must be a non-empty array",
      { retryable: false },
    );
  }
  const normalized = [...new Set(value)];
  for (const assetClass of normalized) {
    if (!MARKET_ASSET_CLASSES.includes(assetClass)) {
      throw new MarketDataError(
        ERROR_CODES.UNSUPPORTED_ASSET,
        `Asset class cannot be enabled: ${String(assetClass)}`,
        { retryable: false, details: { assetClass, allowed: MARKET_ASSET_CLASSES } },
      );
    }
  }
  return Object.freeze(normalized);
}

export function isAssetClassEnabled(assetClass, enabledAssetClasses = DEFAULT_ENABLED_ASSET_CLASSES) {
  return enabledAssetClasses.includes(assetClass);
}

export const ALL_ASSET_POLICIES = ASSET_POLICIES;
