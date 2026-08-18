import {
  buildAssetPresentationPolicy,
  resolvePresentationState,
} from "./assetPresentationPolicy.js";
import { displaySymbolOf, formatInstrumentValue } from "./instrumentFormat.js";
import { numberFormat } from "../../utils/intlFormats.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);

const STAT_FIELDS = Object.freeze([
  ["open", "Open", "price"],
  ["previousClose", "Previous close", "price"],
  ["dayHigh", "Day high", "price"],
  ["dayLow", "Day low", "price"],
  ["bid", "Bid", "price"],
  ["ask", "Ask", "price"],
  ["volume", "Volume", "number"],
  ["averageVolume3m", "Average volume", "number"],
]);

function descriptorOf(value) {
  return value?.instrument && typeof value.instrument === "object" ? value.instrument : value;
}

function availabilityStatus(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" ? value.status : null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function formatCount(value, locale) {
  if (!finite(value)) return "—";
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function fieldIsSemanticallyHidden(field, policy) {
  if ((field === "bid" || field === "ask") && policy.bidAsk === "not_applicable") return true;
  if ((field === "volume" || field === "averageVolume3m")
    && policy.volumeSemantics === "not_applicable") return true;
  return false;
}

function quoteStats(quote, policy, priceUnit, currency, locale, requestState) {
  if (!quote) return [];
  return STAT_FIELDS.flatMap(([id, label, format]) => {
    if (fieldIsSemanticallyHidden(id, policy)) return [];
    const value = quote[id];
    const hasValue = finite(value);
    const availability = quote.fieldAvailability?.[id];
    const status = availabilityStatus(availability);
    if (["not_applicable", "unsupported", "invalid"].includes(status)) return [];
    if (!hasValue && status !== "temporarily_unavailable") return [];
    const state = resolvePresentationState({
      capability: policy.capabilities.quote,
      requestState,
      operation: "quote",
      availability,
      quality: quote.quality,
      hasValue,
    });
    if (state === "hidden") return [];
    return [{
      id,
      label,
      value: hasValue ? value : null,
      formattedValue: state === "ready" || state === "stale"
        ? format === "price"
          ? formatInstrumentValue(value, priceUnit, currency, locale)
          : formatCount(value, locale)
        : "—",
      state,
      reason: availability?.reason || null,
    }];
  });
}

function relativeVolume(quote, policy) {
  if (!policy.supportsRelativeVolume) return null;
  const volume = quote?.volume;
  const average = quote?.averageVolume3m;
  if (!finite(volume) || !finite(average) || average <= 0) return null;
  const volumeAvailability = availabilityStatus(quote.fieldAvailability?.volume);
  const averageAvailability = availabilityStatus(quote.fieldAvailability?.averageVolume3m);
  if ([volumeAvailability, averageAvailability].some((status) => [
    "not_applicable", "unsupported", "temporarily_unavailable", "invalid",
  ].includes(status))) return null;
  return {
    value: volume / average,
    state: quote.quality === "stale" || volumeAvailability === "stale" || averageAvailability === "stale"
      ? "stale"
      : "ready",
  };
}

function buildDetailSections(details, policy, requestState) {
  const declared = new Set(policy.capabilities.details.sections || []);
  if (!policy.capabilities.details.requestable) return [];

  return (details?.sections || []).flatMap((section) => {
    if (!declared.has(section?.id)) return [];
    const rows = Object.entries(section.fields || {}).flatMap(([id, value]) => {
      const availability = section.fieldAvailability?.[id];
      const status = availabilityStatus(availability);
      if (["not_applicable", "unsupported", "invalid"].includes(status)) return [];
      const hasValue = value !== null && value !== undefined;
      if (!hasValue && status !== "temporarily_unavailable") return [];
      return [{
        id,
        value: hasValue ? cloneValue(value) : null,
        state: status === "temporarily_unavailable"
          ? "unavailable"
          : status === "stale" || details?.quality === "stale"
            ? "stale"
            : "ready",
        reason: availability?.reason || null,
      }];
    });
    const state = resolvePresentationState({
      capability: policy.capabilities.details,
      requestState,
      operation: "details",
      availability: { status: section.status || "available" },
      quality: details?.quality,
      hasValue: rows.length > 0,
    });
    if (state === "hidden" || (state === "empty" && rows.length === 0)) return [];
    return [{ id: section.id, state, rows }];
  });
}

function buildChart(history, quote, policy, priceUnit, currency, locale, requestState) {
  const bars = Array.isArray(history?.bars) ? history.bars : [];
  const series = bars
    .filter((bar) => typeof bar?.timestamp === "string" || finite(bar?.timestamp))
    .map((bar) => ({
      timestamp: bar.timestamp,
      value: finite(bar.displayClose) ? bar.displayClose : null,
      volume: finite(bar.volume) ? bar.volume : null,
    }));
  const state = resolvePresentationState({
    capability: policy.capabilities.history,
    requestState,
    operation: "history",
    availability: history?.availability,
    quality: history?.quality,
    hasValue: series.some((point) => finite(point.value)),
  });
  const volumeAvailability = availabilityStatus(history?.fieldAvailability?.volume);
  const volumeDisplay = policy.volumeSemantics === "not_applicable"
    || ["not_applicable", "unsupported"].includes(volumeAvailability)
    ? "hidden"
    : volumeAvailability === "temporarily_unavailable" || volumeAvailability === "invalid"
      ? "unavailable"
      : "supported";
  const continuity = history?.continuity ? cloneValue(history.continuity) : null;
  const liveValue = finite(quote?.value) ? quote.value : finite(quote?.price) ? quote.price : null;
  const mayMergeLiveQuote = ["ready", "stale"].includes(state)
    && history?.priceBasis === "raw"
    && continuity?.kind === "single_instrument"
    && liveValue !== null
    && quote?.dataQuality?.status !== "unusable";
  const basis = history?.priceBasis || null;
  let last = null;
  for (let index = series.length - 1; index >= 0 && !last; index -= 1) {
    if (finite(series[index].value)) last = series[index];
  }
  const summaryValue = last
    ? formatInstrumentValue(last.value, priceUnit, currency, locale)
    : "no observations";

  return {
    state,
    priceBasis: basis,
    requestedPriceBasis: history?.requestedPriceBasis || null,
    continuity,
    series,
    events: Array.isArray(history?.events) ? history.events.map(cloneValue) : [],
    volumeDisplay,
    mayMergeLiveQuote,
    accessibleSummary: `${summaryValue}; ${basis ? basis.replaceAll("_", " ") : "price basis unavailable"}; ${priceUnit}`,
  };
}

export function buildDetailViewModel({
  instrument,
  quote = null,
  details = null,
  history = null,
  requestState = null,
} = {}) {
  const descriptor = descriptorOf(instrument) || {};
  const policy = buildAssetPresentationPolicy(instrument || descriptor);
  const locale = descriptor.locale || "en-US";
  const priceUnit = quote?.priceUnit || descriptor.priceUnit || policy.priceUnit;
  const currency = quote?.currency || descriptor.currency || descriptor.quoteCurrency || null;
  const value = finite(quote?.value) ? quote.value : finite(quote?.price) ? quote.price : null;
  const quoteUsable = quote?.dataQuality?.status !== "unusable";
  const quoteState = resolvePresentationState({
    capability: policy.capabilities.quote,
    requestState,
    operation: "quote",
    availability: quoteUsable ? quote?.fieldAvailability?.value : { status: "invalid" },
    quality: quote?.quality,
    hasValue: value !== null && quoteUsable,
  });
  const detailSections = buildDetailSections(details, policy, requestState);
  const detailsState = resolvePresentationState({
    capability: policy.capabilities.details,
    requestState,
    operation: "details",
    availability: details?.availability,
    quality: details?.quality,
    hasValue: detailSections.length > 0,
  });
  const chart = buildChart(history, quote, policy, priceUnit, currency, locale, requestState);
  const newsState = resolvePresentationState({
    capability: policy.capabilities.news,
    requestState,
    operation: "news",
    hasValue: false,
  });
  const formattedValue = ["ready", "stale"].includes(quoteState)
    ? formatInstrumentValue(value, priceUnit, currency, locale)
    : "—";

  return {
    instrumentId: String(descriptor.id || quote?.instrumentId || history?.instrumentId || ""),
    assetClass: policy.assetClass,
    policy,
    header: {
      displaySymbol: displaySymbolOf(descriptor),
      name: String(descriptor.name || displaySymbolOf(descriptor)),
      assetLabel: policy.assetLabel,
      value,
      formattedValue,
      state: quoteState,
    },
    resourceStates: {
      quote: quoteState,
      history: chart.state,
      details: detailsState,
      news: newsState,
    },
    quote: {
      state: quoteState,
      value,
      formattedValue,
      stats: quoteStats(quote, policy, priceUnit, currency, locale, requestState),
      relativeVolume: relativeVolume(quote, policy),
    },
    chart,
    detailSections,
    sections: detailSections,
  };
}
