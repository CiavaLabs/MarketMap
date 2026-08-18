import {
  buildAssetPresentationPolicy,
  resolvePresentationState,
  resolveRequestState,
} from "./assetPresentationPolicy.js";
import { displaySymbolOf, formatInstrumentValue } from "./instrumentFormat.js";
import { numberFormat } from "../../utils/intlFormats.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function descriptorOf(value) {
  return value?.instrument && typeof value.instrument === "object" ? value.instrument : value;
}

function availabilityFor(quote, field) {
  return quote?.fieldAvailability?.[field] || null;
}

function formatChangePercent(value, locale) {
  if (!finite(value)) return "—";
  const formatted = numberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}%`;
}

function effectiveQuoteQuality(quote, state) {
  if (state === "unavailable" || state === "hidden" || state === "loading" || state === "empty") {
    return "unavailable";
  }
  if (state === "stale" || quote?.quality === "stale") return "stale";
  return ["fresh", "delayed"].includes(quote?.quality) ? quote.quality : "fresh";
}

function qualityLabel(quality) {
  switch (quality) {
    case "fresh": return "Fresh";
    case "delayed": return "Delayed";
    case "stale": return "Last confirmed";
    default: return "Unavailable";
  }
}

function footerLabel(instrument) {
  return instrument?.sector || instrument?.category || instrument?.group || undefined;
}

export function buildTileViewModel({ instrument, quote = null, requestState = null } = {}) {
  const descriptor = descriptorOf(instrument) || {};
  const policy = buildAssetPresentationPolicy(instrument || descriptor);
  const value = finite(quote?.value) ? quote.value : finite(quote?.price) ? quote.price : null;
  const dataUsable = quote?.dataQuality?.status !== "unusable";
  const valueAvailability = dataUsable
    ? (availabilityFor(quote, "value") || availabilityFor(quote, "price"))
    : { status: "invalid", reason: "unusable_quote" };
  const quoteState = resolvePresentationState({
    capability: policy.capabilities.quote,
    requestState,
    operation: "quote",
    availability: valueAvailability,
    quality: quote?.quality,
    hasValue: value !== null && dataUsable,
  });
  const state = quoteState === "hidden" ? "unavailable" : quoteState;
  const quality = effectiveQuoteQuality(quote, quoteState);
  const locale = descriptor.locale || "en-US";
  const priceUnit = quote?.priceUnit || descriptor.priceUnit || policy.priceUnit;
  const currency = quote?.currency || descriptor.currency || descriptor.quoteCurrency || null;
  const showsValue = quoteState === "ready" || quoteState === "stale";
  const changePercent = finite(quote?.changePercent) ? quote.changePercent : null;
  const changeAvailability = availabilityFor(quote, "changePercent");
  const changeState = resolvePresentationState({
    capability: policy.capabilities.quote,
    requestState,
    operation: "quote",
    availability: changeAvailability,
    quality: quote?.quality,
    hasValue: changePercent !== null && dataUsable,
  });
  const formattedValue = showsValue
    ? formatInstrumentValue(value, priceUnit, currency, locale)
    : "—";
  const formattedChange = ["ready", "stale"].includes(changeState)
    ? formatChangePercent(changePercent, locale)
    : "—";
  const symbol = displaySymbolOf(descriptor);
  const name = String(descriptor.name || symbol);

  const historyRequest = resolveRequestState(requestState, "history");
  let sparklineState = "unavailable";
  if (!policy.capabilities.history.requestable) sparklineState = "hidden";
  else if (historyRequest === "loading") sparklineState = "loading";
  else if (historyRequest === "error") sparklineState = "unavailable";
  else if (historyRequest === "ready") sparklineState = "ready";

  return {
    instrumentId: String(descriptor.id || quote?.instrumentId || ""),
    displaySymbol: symbol,
    name,
    assetClass: policy.assetClass,
    assetLabel: policy.assetLabel,
    priceUnit,
    currency,
    value,
    formattedValue,
    changePercent,
    formattedChange,
    changeDirection: changePercent > 0 ? "up" : changePercent < 0 ? "down" : "flat",
    changeState,
    quoteState,
    state,
    quality,
    footerLabel: footerLabel(descriptor),
    session: quote?.session ? { ...quote.session } : null,
    sparkline: {
      state: sparklineState,
      requestable: policy.capabilities.history.requestable,
    },
    ariaLabel: [symbol || name, formattedValue, formattedChange, qualityLabel(quality)]
      .filter(Boolean)
      .join(", "),
  };
}
