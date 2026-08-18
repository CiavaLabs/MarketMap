import { numberFormat } from "../../utils/intlFormats.js";

const PRICE_UNITS = Object.freeze([
  "currency",
  "currency_per_unit",
  "index_points",
  "percent_yield",
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function supportsPriceUnit(priceUnit) {
  return PRICE_UNITS.includes(priceUnit);
}

const resolvedLocales = new Map();

function safeLocale(locale) {
  const cached = resolvedLocales.get(locale);
  if (cached !== undefined) return cached;
  let resolved;
  try {
    numberFormat(locale).format(0);
    resolved = locale;
  } catch {
    resolved = "en-US";
  }
  if (resolvedLocales.size >= 32) resolvedLocales.clear();
  resolvedLocales.set(locale, resolved);
  return resolved;
}

function decimalOptions(value, { normal = 2, small = 4, tiny = 6 } = {}) {
  const absolute = Math.abs(value);
  const maximumFractionDigits = absolute > 0 && absolute < 0.01
    ? tiny
    : absolute > 0 && absolute < 1
      ? small
      : normal;
  return { minimumFractionDigits: Math.min(2, maximumFractionDigits), maximumFractionDigits };
}

function formatCurrency(value, currency, locale) {
  const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
    ? currency.toUpperCase()
    : null;
  const decimals = decimalOptions(value);
  if (!code) return numberFormat(locale, decimals).format(value);
  try {
    return numberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      ...decimals,
    }).format(value);
  } catch {
    return `${numberFormat(locale, decimals).format(value)} ${code}`;
  }
}

export function formatInstrumentValue(value, priceUnit, currency, locale = "en-US") {
  if (!finite(value)) return "—";
  const normalizedLocale = safeLocale(locale);

  switch (priceUnit) {
    case "currency":
      return formatCurrency(value, currency, normalizedLocale);
    case "currency_per_unit":
      return numberFormat(normalizedLocale, decimalOptions(value, {
        normal: 4,
        small: 6,
        tiny: 8,
      })).format(value);
    case "index_points":
      return `${numberFormat(normalizedLocale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)} pts`;
    case "percent_yield":
      return `${numberFormat(normalizedLocale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      }).format(value)}%`;
    default:
      return numberFormat(normalizedLocale, decimalOptions(value)).format(value);
  }
}

export function presentationSymbol(value) {
  const text = String(value ?? "").trim();
  const separator = text.indexOf(":");
  const symbol = separator >= 0 ? text.slice(separator + 1) : text;
  return symbol.startsWith("^") ? symbol.slice(1) : symbol;
}

export function displaySymbolOf(source) {
  const curated = source?.displaySymbol;
  if (typeof curated === "string" && curated.trim()) return curated.trim();
  return presentationSymbol(
    source?.symbol || source?.ticker || source?.providerSymbol || source?.id || "",
  );
}

export function instrumentLabelFor(instrumentId, labels) {
  const configured = typeof labels === "function"
    ? labels(instrumentId)
    : labels instanceof Map
      ? labels.get(instrumentId)
      : labels?.[instrumentId];
  if (configured) return String(configured);
  return presentationSymbol(instrumentId);
}
