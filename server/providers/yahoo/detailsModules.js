const MODULES_BY_ASSET_CLASS = Object.freeze({
  equity: Object.freeze([
    "assetProfile",
    "summaryProfile",
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "financialData",
    "calendarEvents",
  ]),
  etf: Object.freeze([
    "assetProfile",
    "summaryProfile",
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "fundProfile",
    "topHoldings",
  ]),
  index: Object.freeze(["price", "summaryDetail", "defaultKeyStatistics", "quoteType"]),
  rate_index: Object.freeze(["price", "summaryDetail", "defaultKeyStatistics", "quoteType"]),
  fx: Object.freeze(["price", "summaryDetail", "quoteType"]),
  crypto: Object.freeze(["assetProfile", "summaryProfile", "price", "summaryDetail", "quoteType"]),
  commodity_future: Object.freeze(["price", "summaryDetail", "quoteType"]),
});

export function yahooDetailsModulesFor(assetClass) {
  return [...(MODULES_BY_ASSET_CLASS[assetClass] || [])];
}
