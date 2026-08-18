const SUPPORT_LEVELS = new Set(["supported", "partial", "unsupported"]);
const OPERATIONS = Object.freeze(["quote", "history", "details", "news", "analytics"]);

const DETAIL_SECTIONS = Object.freeze({
  company: Object.freeze(["company_profile", "equity_fundamentals", "analyst_outlook"]),
  fund: Object.freeze(["fund_profile", "fund_composition", "fund_stats"]),
  index: Object.freeze(["index_metadata", "market_stats"]),
  currency_pair: Object.freeze(["pair_metadata"]),
  crypto_asset: Object.freeze(["crypto_metadata", "crypto_market_stats"]),
  future_contract: Object.freeze(["future_contract", "future_market_stats", "rollover_notice"]),
  rate_index: Object.freeze(["index_metadata", "market_stats"]),
});

const ASSET_PRESENTATION = Object.freeze({
  equity: Object.freeze({
    assetLabel: "Equity",
    priceUnit: "currency",
    sessionModel: "exchange_hours",
    volumeSemantics: "exchange_traded",
    bidAsk: "supported",
    supportsRelativeVolume: true,
    detailKind: "company",
    historyPriceBases: Object.freeze(["raw", "provider_adjusted"]),
    newsApplicable: true,
  }),
  etf: Object.freeze({
    assetLabel: "ETF",
    priceUnit: "currency",
    sessionModel: "exchange_hours",
    volumeSemantics: "exchange_traded",
    bidAsk: "supported",
    supportsRelativeVolume: true,
    detailKind: "fund",
    historyPriceBases: Object.freeze(["raw", "provider_adjusted"]),
    newsApplicable: false,
  }),
  index: Object.freeze({
    assetLabel: "Index",
    priceUnit: "index_points",
    sessionModel: "publisher_schedule",
    volumeSemantics: "provider_reported",
    bidAsk: "not_applicable",
    supportsRelativeVolume: false,
    detailKind: "index",
    historyPriceBases: Object.freeze(["raw"]),
    newsApplicable: false,
  }),
  fx: Object.freeze({
    assetLabel: "FX",
    priceUnit: "currency_per_unit",
    sessionModel: "24x5",
    volumeSemantics: "not_applicable",
    bidAsk: "partial",
    supportsRelativeVolume: false,
    detailKind: "currency_pair",
    historyPriceBases: Object.freeze(["raw"]),
    newsApplicable: false,
  }),
  crypto: Object.freeze({
    assetLabel: "Crypto",
    priceUnit: "currency",
    sessionModel: "24x7",
    volumeSemantics: "provider_aggregate",
    bidAsk: "partial",
    supportsRelativeVolume: false,
    detailKind: "crypto_asset",
    historyPriceBases: Object.freeze(["raw"]),
    newsApplicable: false,
  }),
  commodity_future: Object.freeze({
    assetLabel: "Commodity future",
    priceUnit: "currency",
    sessionModel: "provider_schedule",
    volumeSemantics: "provider_reported",
    bidAsk: "partial",
    supportsRelativeVolume: false,
    detailKind: "future_contract",
    historyPriceBases: Object.freeze(["raw"]),
    newsApplicable: false,
  }),
  rate_index: Object.freeze({
    assetLabel: "Rate index",
    priceUnit: "percent_yield",
    sessionModel: "publisher_schedule",
    volumeSemantics: "not_applicable",
    bidAsk: "not_applicable",
    supportsRelativeVolume: false,
    detailKind: "rate_index",
    historyPriceBases: Object.freeze(["raw"]),
    newsApplicable: false,
  }),
});

const LEGACY_EQUITY_CAPABILITIES = Object.freeze({
  quote: Object.freeze({ status: "supported" }),
  history: Object.freeze({
    status: "supported",
    ranges: Object.freeze({
      "1d": Object.freeze(["5m"]),
      "5d": Object.freeze(["15m"]),
      "1m": Object.freeze(["1d"]),
      "6m": Object.freeze(["1d"]),
      "1y": Object.freeze(["1d"]),
      "5y": Object.freeze(["1wk"]),
    }),
    priceBases: Object.freeze(["raw", "provider_adjusted"]),
  }),
  details: Object.freeze({
    status: "supported",
    sections: Object.freeze(["company_profile", "equity_fundamentals", "analyst_outlook"]),
  }),
  news: Object.freeze({ status: "supported" }),
  analytics: Object.freeze({ status: "unsupported", reason: "not_available_in_current_release" }),
});

function cloneRanges(ranges) {
  if (!ranges || typeof ranges !== "object" || Array.isArray(ranges)) return {};
  return Object.fromEntries(Object.entries(ranges)
    .filter(([, intervals]) => Array.isArray(intervals) && intervals.length)
    .map(([range, intervals]) => [range, [...new Set(intervals.filter((value) => typeof value === "string"))]]));
}

function unsupported(reason) {
  return { status: "unsupported", requestable: false, reason };
}

function normalizeCapability(operation, entry, policy) {
  if (operation === "news" && !policy.newsApplicable) return unsupported("asset_class");
  if (!entry || typeof entry !== "object" || !SUPPORT_LEVELS.has(entry.status)) {
    return unsupported("capability_missing");
  }
  if (entry.status === "unsupported") {
    return unsupported(entry.reason || "unsupported");
  }

  const result = {
    status: entry.status,
    requestable: true,
  };
  if (entry.reason) result.reason = entry.reason;

  if (operation === "history") {
    const allowedBases = new Set(policy.historyPriceBases);
    result.ranges = cloneRanges(entry.ranges);
    result.priceBases = Array.isArray(entry.priceBases)
      ? [...new Set(entry.priceBases.filter((basis) => allowedBases.has(basis)))]
      : [];
    if (!Object.keys(result.ranges).length || !result.priceBases.length) {
      return unsupported("no_supported_semantics");
    }
  }

  if (operation === "details") {
    const allowedSections = DETAIL_SECTIONS[policy.detailKind];
    const declared = Array.isArray(entry.sections) ? new Set(entry.sections) : new Set();
    result.sections = allowedSections.filter((section) => declared.has(section));
    if (!result.sections.length) return unsupported("no_applicable_sections");
  }

  return result;
}

function unpackInput(input, capabilitiesOverride) {
  const wrapper = input && typeof input === "object" ? input : {};
  const instrument = wrapper.instrument && typeof wrapper.instrument === "object"
    ? wrapper.instrument
    : wrapper;
  const capabilities = capabilitiesOverride
    || wrapper.capabilities
    || instrument.capabilities
    || {};
  return { instrument, capabilities };
}

function applicableQuoteFields(policy) {
  const fields = ["value", "change", "changePercent", "open", "previousClose", "dayHigh", "dayLow", "session"];
  if (policy.bidAsk !== "not_applicable") fields.push("bid", "ask");
  if (policy.volumeSemantics !== "not_applicable") fields.push("volume");
  if (policy.supportsRelativeVolume) fields.push("averageVolume3m");
  return fields;
}

export function buildAssetPresentationPolicy(input, capabilitiesOverride) {
  const { instrument, capabilities } = unpackInput(input, capabilitiesOverride);
  const assetClass = instrument.assetClass;
  const policy = ASSET_PRESENTATION[assetClass];
  if (!policy) throw new RangeError(`Unsupported asset class: ${String(assetClass)}`);

  const normalizedCapabilities = Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      normalizeCapability(operation, capabilities[operation], policy),
    ]),
  );

  return {
    assetClass,
    assetLabel: policy.assetLabel,
    priceUnit: instrument.priceUnit || policy.priceUnit,
    sessionModel: policy.sessionModel,
    volumeSemantics: policy.volumeSemantics,
    bidAsk: policy.bidAsk,
    supportsRelativeVolume: policy.supportsRelativeVolume,
    detailKind: policy.detailKind,
    applicableQuoteFields: applicableQuoteFields(policy),
    applicableDetailSections: [...DETAIL_SECTIONS[policy.detailKind]],
    historyPriceBases: [...policy.historyPriceBases],
    newsApplicable: policy.newsApplicable,
    capabilities: normalizedCapabilities,
  };
}

export function legacyCompatiblePresentationInput(input) {
  const wrapper = input && typeof input === "object" ? input : {};
  const instrument = wrapper.instrument && typeof wrapper.instrument === "object"
    ? wrapper.instrument
    : wrapper;
  const capabilities = wrapper.capabilities || instrument.capabilities;
  if (capabilities && typeof capabilities === "object" && Object.keys(capabilities).length) {
    return input;
  }
  if (instrument.assetClass && instrument.assetClass !== "equity") return input;
  return {
    instrument: { ...instrument, assetClass: "equity" },
    capabilities: LEGACY_EQUITY_CAPABILITIES,
  };
}

function requestEntry(requestState, operation) {
  if (typeof requestState === "string") return requestState;
  if (!requestState || typeof requestState !== "object") return null;
  const value = requestState[operation] ?? requestState.status;
  return typeof value === "object" && value !== null ? value.status : value;
}

export function resolveRequestState(requestState, operation) {
  const value = requestEntry(requestState, operation);
  if (["loading", "pending", "refreshing"].includes(value)) return "loading";
  if (["ready", "success", "fulfilled"].includes(value)) return "ready";
  if (["error", "failed", "rejected"].includes(value)) return "error";
  if (value === "empty") return "empty";
  return null;
}

function availabilityStatus(availability, hasValue) {
  if (typeof availability === "string") return availability;
  if (availability && typeof availability === "object") return availability.status;
  return hasValue ? "available" : null;
}

export function resolvePresentationState({
  capability,
  requestState,
  operation,
  availability,
  quality,
  hasValue = false,
} = {}) {
  if (!capability || capability.requestable === false || capability.status === "unsupported") return "hidden";

  const request = resolveRequestState(requestState, operation);
  if (request === "loading") return "loading";

  const status = availabilityStatus(availability, hasValue);
  if (status === "not_applicable" || status === "unsupported") return "hidden";
  if (status === "temporarily_unavailable" || status === "invalid") return "unavailable";
  if ((status === "stale" || quality === "stale") && hasValue) return "stale";
  if (quality === "unavailable" || request === "error") return "unavailable";
  if ((status === "available" || status === "stale") && hasValue) return quality === "stale" ? "stale" : "ready";
  if (request === "ready" || request === "empty") return "empty";
  if (hasValue) return quality === "stale" ? "stale" : "ready";
  return "unavailable";
}

export const ASSET_CLASSES = Object.freeze(Object.keys(ASSET_PRESENTATION));
