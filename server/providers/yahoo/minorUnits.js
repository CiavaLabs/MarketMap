import { resolveCurrencyUnit } from "../../instruments/currencyUnits.js";

const QUOTE_PRICE_FIELDS = Object.freeze([
  "regularMarketPrice",
  "regularMarketOpen",
  "regularMarketPreviousClose",
  "regularMarketDayHigh",
  "regularMarketDayLow",
  "regularMarketChange",
  "preMarketPrice",
  "preMarketChange",
  "postMarketPrice",
  "postMarketChange",
  "bid",
  "ask",
  "fiftyTwoWeekLow",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLowChange",
  "fiftyTwoWeekHighChange",
  "fiftyDayAverage",
  "fiftyDayAverageChange",
  "twoHundredDayAverage",
  "twoHundredDayAverageChange",
  "navPrice",
]);

const CHART_META_PRICE_FIELDS = Object.freeze([
  "chartPreviousClose",
  "previousClose",
  "regularMarketPrice",
  "regularMarketDayHigh",
  "regularMarketDayLow",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLow",
]);

const CHART_BAR_PRICE_FIELDS = Object.freeze([
  "open",
  "high",
  "low",
  "close",
  "adjclose",
  "adjustedClose",
]);

const SUMMARY_PRICE_FIELDS_BY_MODULE = Object.freeze({
  summaryDetail: Object.freeze([
    "previousClose",
    "open",
    "dayLow",
    "dayHigh",
    "regularMarketPreviousClose",
    "regularMarketOpen",
    "regularMarketDayLow",
    "regularMarketDayHigh",
    "bid",
    "ask",
    "fiftyTwoWeekLow",
    "fiftyTwoWeekHigh",
    "fiftyDayAverage",
    "twoHundredDayAverage",
    "navPrice",
    "dividendRate",
    "trailingAnnualDividendRate",
  ]),
  price: Object.freeze([
    "regularMarketPrice",
    "regularMarketOpen",
    "regularMarketDayHigh",
    "regularMarketDayLow",
    "regularMarketPreviousClose",
    "regularMarketChange",
    "preMarketPrice",
    "preMarketChange",
    "postMarketPrice",
    "postMarketChange",
    "navPrice",
  ]),
  financialData: Object.freeze([
    "currentPrice",
    "targetHighPrice",
    "targetLowPrice",
    "targetMeanPrice",
    "targetMedianPrice",
  ]),
});

const SUMMARY_CURRENCY_MODULES = Object.freeze(["summaryDetail", "price"]);

function scaleValue(value, scale) {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") {
    if (!Object.hasOwn(value, "raw")) return value;
    const scaledRaw = scaleValue(value.raw, scale);
    if (scaledRaw === value.raw) return value;
    const { fmt, longFmt, ...rest } = value;
    return { ...rest, raw: scaledRaw };
  }
  const number = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || value === "" || !Number.isFinite(number)) return value;
  return number / scale;
}

function scaleFields(source, fields, scale) {
  let changed = false;
  const patch = {};
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    const scaled = scaleValue(source[field], scale);
    if (scaled === source[field]) continue;
    patch[field] = scaled;
    changed = true;
  }
  return changed ? { ...source, ...patch } : source;
}

function scaleDividendRows(rows, scale) {
  if (Array.isArray(rows)) {
    return rows.map((row) => (
      row && typeof row === "object" ? scaleFields(row, ["amount"], scale) : row
    ));
  }
  if (!rows || typeof rows !== "object") return rows;
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => [
    key,
    row && typeof row === "object" ? scaleFields(row, ["amount"], scale) : row,
  ]));
}

function scaleEvents(events, scale) {
  if (!events || typeof events !== "object" || !Object.hasOwn(events, "dividends")) return events;
  return { ...events, dividends: scaleDividendRows(events.dividends, scale) };
}

export function normalizeQuoteUnits(quote) {
  if (!quote || typeof quote !== "object") return quote;
  const unit = resolveCurrencyUnit(quote.currency);
  if (!unit || unit.scale === 1) return quote;
  return {
    ...scaleFields(quote, QUOTE_PRICE_FIELDS, unit.scale),
    currency: unit.currency,
  };
}

export function normalizeQuoteMapUnits(quotes) {
  if (!(quotes instanceof Map)) return quotes;
  const normalized = new Map();
  for (const [symbol, quote] of quotes) normalized.set(symbol, normalizeQuoteUnits(quote));
  return normalized;
}

export function normalizeChartUnits(chart) {
  if (!chart || typeof chart !== "object") return chart;
  const unit = resolveCurrencyUnit(chart.meta?.currency);
  if (!unit || unit.scale === 1) return chart;
  const { scale } = unit;
  const next = {
    ...chart,
    meta: { ...scaleFields(chart.meta, CHART_META_PRICE_FIELDS, scale), currency: unit.currency },
  };
  if (Array.isArray(chart.quotes)) {
    next.quotes = chart.quotes.map((row) => (
      row && typeof row === "object" ? scaleFields(row, CHART_BAR_PRICE_FIELDS, scale) : row
    ));
  }
  if (chart.events) next.events = scaleEvents(chart.events, scale);
  if (Object.hasOwn(chart, "dividends")) next.dividends = scaleDividendRows(chart.dividends, scale);
  return next;
}

export function normalizeQuoteSummaryUnits(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const declared = SUMMARY_CURRENCY_MODULES
    .map((module) => summary[module]?.currency)
    .find((value) => `${value ?? ""}`.trim());
  const unit = resolveCurrencyUnit(declared);
  if (!unit || unit.scale === 1) return summary;

  const next = { ...summary };
  for (const [module, fields] of Object.entries(SUMMARY_PRICE_FIELDS_BY_MODULE)) {
    const section = summary[module];
    if (!section || typeof section !== "object") continue;
    next[module] = scaleFields(section, fields, unit.scale);
  }
  for (const module of SUMMARY_CURRENCY_MODULES) {
    if (next[module] && typeof next[module] === "object" && next[module].currency !== undefined) {
      next[module] = { ...next[module], currency: unit.currency };
    }
  }
  return next;
}
