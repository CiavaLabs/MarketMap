import { HISTORY_ALLOWLIST } from "../contracts/core/history.js";
import { validateEffectiveCapabilities } from "../contracts/market/capabilities.js";
import { DEFAULT_ENABLED_ASSET_CLASSES } from "../contracts/market/constants.js";
import { assetPolicyFor, detailSectionsFor } from "./assetPolicies.js";

const UNSUPPORTED = (reason) => ({ status: "unsupported", ...(reason ? { reason } : {}) });

function manifestEntry(manifests, assetClass, operation) {
  for (const manifest of manifests) {
    const entry = manifest.assets[assetClass]?.[operation];
    if (entry && entry.support !== "unsupported") return entry;
  }
  return null;
}

export function buildEffectiveCapabilities({
  assetClass,
  manifests,
  enabledAssetClasses = DEFAULT_ENABLED_ASSET_CLASSES,
}) {
  const policy = assetPolicyFor(assetClass);
  if (!enabledAssetClasses.includes(assetClass)) {
    const capabilities = {
      quote: UNSUPPORTED("asset_class_disabled"),
      history: UNSUPPORTED("asset_class_disabled"),
      details: UNSUPPORTED("asset_class_disabled"),
      news: UNSUPPORTED("asset_class_disabled"),
      analytics: UNSUPPORTED("asset_class"),
    };
    return validateEffectiveCapabilities(capabilities);
  }

  const quote = manifestEntry(manifests, assetClass, "quote");
  const history = manifestEntry(manifests, assetClass, "history");
  const details = manifestEntry(manifests, assetClass, "details");
  const news = policy.news ? manifestEntry(manifests, assetClass, "news") : null;

  const priceBases = history
    ? policy.history.priceBases.filter((basis) => history.priceBases.includes(basis))
    : [];
  const ranges = history
    ? Object.fromEntries(Object.entries(HISTORY_ALLOWLIST)
      .map(([range, intervals]) => [
        range,
        intervals.filter((interval) => history.intervals.includes(interval)),
      ])
      .filter(([, intervals]) => intervals.length))
    : {};
  const sections = details
    ? detailSectionsFor(assetClass).filter((section) => details.sections.includes(section))
    : [];

  const capabilities = {
    quote: quote
      ? { status: quote.support, fields: { ...(quote.fields || {}) } }
      : UNSUPPORTED("no_provider_coverage"),
    history: history && priceBases.length && Object.keys(ranges).length
      ? { status: history.support, ranges, priceBases }
      : UNSUPPORTED(history ? "no_supported_semantics" : "no_provider_coverage"),
    details: details && sections.length
      ? { status: details.support, sections }
      : UNSUPPORTED(details ? "no_applicable_sections" : "no_provider_coverage"),
    news: news ? { status: news.support } : UNSUPPORTED(policy.news ? "no_provider_coverage" : "asset_class"),
    analytics: UNSUPPORTED("not_available_in_current_release"),
  };
  return validateEffectiveCapabilities(capabilities);
}
