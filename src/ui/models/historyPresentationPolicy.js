const ADJUSTED_INTERVALS = new Set(["1d", "1wk", "1mo"]);

export function selectHistoryPriceBasis({ assetClass, range, interval, priceBases = [] } = {}) {
  const declared = Array.isArray(priceBases) ? priceBases : [];
  const canUseAdjusted = ["equity", "etf"].includes(assetClass)
    && range !== "1d"
    && ADJUSTED_INTERVALS.has(interval)
    && declared.includes("provider_adjusted");
  if (canUseAdjusted) return "provider_adjusted";
  if (declared.includes("raw")) return "raw";
  return declared[0] || "raw";
}
