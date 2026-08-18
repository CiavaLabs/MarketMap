import { ERROR_CODES } from "../../contracts/core/constants.js";
import {
  validateHistorySeries,
  validateInstrumentDetails,
  validateQuoteSnapshot,
} from "../../contracts/market/index.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import { assetPolicyFor } from "../../instruments/assetPolicies.js";
import { assetClassFromQuoteType } from "../../instruments/descriptorFactory.js";

const PRICE_FIELDS = Object.freeze({
  change: "regularMarketChange",
  changePercent: "regularMarketChangePercent",
  open: "regularMarketOpen",
  previousClose: "regularMarketPreviousClose",
  dayHigh: "regularMarketDayHigh",
  dayLow: "regularMarketDayLow",
  bid: "bid",
  ask: "ask",
  volume: "regularMarketVolume",
  averageVolume3m: "averageDailyVolume3Month",
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteCount(value) {
  const number = finite(value);
  return number === null || number < 0 ? null : number;
}

function timestamp(value, fallback = null) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return fallback;
  }
  if (typeof value === "boolean") return fallback;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && Math.abs(value) < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function fetchedAt(clock) {
  const at = timestamp(typeof clock === "function" ? clock() : Date.now());
  if (at === null) throw new TypeError("Yahoo normalizers require a clock returning a valid date");
  return at;
}

function schemaError(message, instrumentId, details = null) {
  return new MarketDataError(ERROR_CODES.SCHEMA_INVALID, message, {
    provider: "yahoo",
    capability: "quote",
    instrumentId,
    retryable: true,
    details,
  });
}

function availability(value, missingStatus = "temporarily_unavailable") {
  return value === null ? { status: missingStatus } : { status: "available" };
}

function qualityFrom(raw) {
  const delayedBy = finite(raw.exchangeDataDelayedBy);
  const source = `${raw.quoteSourceName || ""}`.toLowerCase();
  return (delayedBy !== null && delayedBy > 0) || source.includes("delay") ? "delayed" : "fresh";
}

function phaseFor(model, marketState) {
  const state = `${marketState || ""}`.trim().toUpperCase();
  if (model === "24x7") return "continuous";
  if (model === "24x5") return state === "CLOSED" ? "closed" : "continuous";
  return {
    PRE: "pre",
    PREPRE: "pre",
    REGULAR: "regular",
    POST: "post",
    POSTPOST: "post",
    CLOSED: "closed",
  }[state] || "unknown";
}

function sessionFor(descriptor, raw, { withPhase = true } = {}) {
  const model = assetPolicyFor(descriptor.assetClass).sessionModel;
  const session = {
    model,
    timezone: `${raw.exchangeTimezoneName || ""}`.trim() || (model.includes("24x") ? "UTC" : null),
  };
  if (!withPhase) return session;
  const phase = phaseFor(model, raw.marketState);
  return {
    ...session,
    phase,
    isTrading: phase === "regular" || phase === "continuous"
      ? true
      : phase === "closed" || phase === "post"
        ? false
        : null,
    regularStart: null,
    regularEnd: null,
  };
}

function ensureCompatibleType(raw, descriptor, capability) {
  const observed = assetClassFromQuoteType(raw?.quoteType || raw?.meta?.instrumentType, raw?.symbol || raw?.meta?.symbol);
  if (observed && observed !== descriptor.assetClass) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Yahoo asset type conflicts with the resolved identity", {
      provider: "yahoo",
      capability,
      instrumentId: descriptor.id,
      retryable: true,
      details: { expected: descriptor.assetClass, observed },
    });
  }
}

function normalizeObservedPrice(value, policy) {
  const number = finite(value);
  if (number === null) return null;
  if (!policy.allowNegativePrices && number <= 0) return null;
  return number;
}

function notApplicableReason(assetClass, field) {
  if (field === "bid" || field === "ask") return "index_no_order_book";
  if (assetClass === "fx") return "fx_otc_volume";
  return assetClass;
}

export function normalizeYahooQuote(raw, { descriptor, clock = Date.now } = {}) {
  if (!raw || typeof raw !== "object" || !descriptor?.id) {
    throw schemaError("Yahoo returned an invalid quote payload", descriptor?.id || null);
  }
  ensureCompatibleType(raw, descriptor, "quote");
  const policy = assetPolicyFor(descriptor.assetClass);
  const observedAt = fetchedAt(clock);
  const value = normalizeObservedPrice(raw.regularMarketPrice, policy);
  if (value === null) {
    if (`${raw.quoteType || ""}`.toUpperCase() === "NONE") {
      throw new MarketDataError(ERROR_CODES.INSTRUMENT_NOT_FOUND, `Yahoo no longer lists ${descriptor.id}`, {
        provider: "yahoo",
        capability: "quote",
        instrumentId: descriptor.id,
        retryable: false,
        details: { reason: "provider_delisted" },
      });
    }
    throw schemaError("Yahoo quote has no valid observed value", descriptor.id);
  }

  const issues = [];
  const values = {};
  const fieldAvailability = {};
  for (const [field, rawField] of Object.entries(PRICE_FIELDS)) {
    let normalized;
    if (["open", "previousClose", "dayHigh", "dayLow", "bid", "ask"].includes(field)) {
      normalized = normalizeObservedPrice(raw[rawField], policy);
    } else if (["volume", "averageVolume3m"].includes(field)) {
      normalized = finiteCount(raw[rawField]);
    } else {
      normalized = finite(raw[rawField]);
    }

    const notApplicable = (["bid", "ask"].includes(field) && policy.bidAsk === "not_applicable")
      || (["volume", "averageVolume3m"].includes(field) && policy.volume === "not_applicable");
    if (notApplicable) {
      normalized = null;
      fieldAvailability[field] = {
        status: "not_applicable",
        reason: notApplicableReason(descriptor.assetClass, field),
      };
    } else if (["volume", "averageVolume3m"].includes(field)
      && normalized === 0 && policy.zeroVolumeIsPlaceholder) {
      normalized = null;
      fieldAvailability[field] = {
        status: "invalid",
        reason: "provider_zero_placeholder",
      };
      issues.push({ code: "provider_zero_placeholder", severity: "info", field });
    } else {
      fieldAvailability[field] = availability(normalized);
    }
    values[field] = normalized;
  }

  if (values.change === null && values.previousClose !== null) {
    values.change = value - values.previousClose;
    fieldAvailability.change = { status: "available" };
    issues.push({ code: "derived_from_previous_close", severity: "info", field: "change" });
  }
  if (values.changePercent === null && values.previousClose !== null && values.previousClose !== 0) {
    values.changePercent = (values.change / values.previousClose) * 100;
    fieldAvailability.changePercent = { status: "available" };
    issues.push({ code: "derived_from_previous_close", severity: "info", field: "changePercent" });
  }
  if (values.dayHigh !== null && values.dayLow !== null && values.dayHigh < values.dayLow) {
    throw schemaError("Yahoo quote day high is below day low", descriptor.id, {
      dayHigh: values.dayHigh,
      dayLow: values.dayLow,
    });
  }
  if (values.bid !== null && values.ask !== null && values.ask < values.bid) {
    values.bid = null;
    values.ask = null;
    fieldAvailability.bid = { status: "invalid", reason: "crossed_provider_book" };
    fieldAvailability.ask = { status: "invalid", reason: "crossed_provider_book" };
    issues.push({ code: "missing_optional_field", severity: "warning", field: "bidAsk" });
  }

  const quality = qualityFrom(raw);
  if (quality === "delayed") {
    issues.push({ code: "provider_delayed", severity: "info", field: null });
  }
  const quote = {
    instrumentId: descriptor.id,
    assetClass: descriptor.assetClass,
    value,
    price: value,
    priceUnit: descriptor.priceUnit,
    currency: descriptor.currency || null,
    ...values,
    session: sessionFor(descriptor, raw),
    fieldAvailability,
    quality,
    dataQuality: {
      status: issues.length ? "usable_with_warnings" : "usable",
      issues,
    },
    provenance: {
      source: "yahoo",
      providerSymbol: descriptor.providerSymbols.yahoo.symbol,
      providerType: `${raw.quoteType || descriptor.providerSymbols.yahoo.providerType || ""}`.toUpperCase(),
      fallback: false,
    },
    asOf: timestamp(raw.regularMarketTime, observedAt),
    fetchedAt: observedAt,
  };
  validateQuoteSnapshot(quote);
  return quote;
}

function validOhlc(row, policy) {
  const values = [row?.open, row?.high, row?.low, row?.close].map(finite);
  if (values.some((value) => value === null)) return null;
  const [open, high, low, close] = values;
  if (!policy.allowNegativePrices && values.some((value) => value <= 0)) return null;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;
  return { open, high, low, close };
}

function normalizeEvents(raw, descriptor) {
  if (!assetPolicyFor(descriptor.assetClass).history.corporateActions) return [];
  const container = raw?.events || {};
  const dividends = container.dividends || raw?.dividends || [];
  const splits = container.splits || raw?.splits || [];
  const rows = (value) => Array.isArray(value) ? value : Object.values(value || {});
  const events = [];
  for (const dividend of rows(dividends)) {
    const at = timestamp(dividend?.date || dividend?.timestamp);
    const amount = finite(dividend?.amount);
    if (at && amount !== null && amount > 0) {
      events.push({
        type: "dividend",
        timestamp: at,
        amount,
        currency: `${dividend.currency || raw.meta?.currency || descriptor.currency}`.toUpperCase(),
        source: "yahoo",
      });
    }
  }
  for (const split of rows(splits)) {
    const at = timestamp(split?.date || split?.timestamp);
    let numerator = Number(split?.numerator);
    let denominator = Number(split?.denominator);
    if ((!Number.isInteger(numerator) || !Number.isInteger(denominator)) && split?.splitRatio) {
      [numerator, denominator] = `${split.splitRatio}`.split(":").map(Number);
    }
    if (at && Number.isInteger(numerator) && numerator > 0 && Number.isInteger(denominator) && denominator > 0) {
      events.push({ type: "split", timestamp: at, numerator, denominator, source: "yahoo" });
    }
  }
  return events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function normalizeYahooHistory(raw, {
  descriptor,
  range,
  interval,
  priceBasis,
  clock = Date.now,
  invalidRowThreshold = 0.2,
  futureQuote = null,
} = {}) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.quotes) || !descriptor?.id) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Yahoo returned an invalid chart payload", {
      provider: "yahoo",
      capability: "history",
      instrumentId: descriptor?.id || null,
      retryable: true,
    });
  }
  ensureCompatibleType({
    quoteType: raw.meta?.instrumentType,
    symbol: raw.meta?.symbol || descriptor.providerSymbols.yahoo.symbol,
  }, descriptor, "history");
  const policy = assetPolicyFor(descriptor.assetClass);
  if (!policy.history.priceBases.includes(priceBasis)) {
    throw new MarketDataError(ERROR_CODES.UNSUPPORTED_SEMANTICS, "Requested price basis is not available for this asset", {
      provider: "yahoo",
      capability: "history",
      instrumentId: descriptor.id,
      retryable: false,
      details: { requestedPriceBasis: priceBasis, availablePriceBases: policy.history.priceBases },
    });
  }

  const seen = new Set();
  const bars = [];
  const issues = [];
  let droppedRows = 0;
  let missingAdjustedCloseRows = 0;
  for (const row of raw.quotes) {
    const at = timestamp(row?.date || row?.timestamp);
    if (!at) {
      droppedRows += 1;
      issues.push({ code: "row_dropped_invalid_timestamp", severity: "warning", field: "timestamp" });
      continue;
    }
    if (seen.has(at)) {
      droppedRows += 1;
      issues.push({ code: "duplicate_timestamp", severity: "warning", field: "timestamp", timestamp: at });
      continue;
    }
    const ohlc = validOhlc(row, policy);
    if (!ohlc) {
      droppedRows += 1;
      issues.push({ code: "row_dropped_invalid_ohlc", severity: "warning", field: null, timestamp: at });
      continue;
    }
    seen.add(at);
    let volume = finite(row.volume);
    const fieldAvailability = {};
    if (policy.volume === "not_applicable") {
      volume = null;
    } else if (volume === null) {
      fieldAvailability.volume = { status: "temporarily_unavailable" };
    } else if (volume !== null && volume < 0) {
      volume = null;
      fieldAvailability.volume = { status: "invalid", reason: "negative_provider_volume" };
    } else if (volume === 0 && policy.zeroVolumeIsPlaceholder) {
      volume = null;
      fieldAvailability.volume = { status: "invalid", reason: "provider_zero_placeholder" };
      issues.push({ code: "provider_zero_placeholder", severity: "info", field: "volume" });
    }

    const adjustedClose = normalizeObservedPrice(row.adjclose ?? row.adjustedClose, policy);
    let displayClose = ohlc.close;
    if (priceBasis === "provider_adjusted") {
      displayClose = adjustedClose;
      if (adjustedClose === null) {
        missingAdjustedCloseRows += 1;
        fieldAvailability.adjustedClose = { status: "temporarily_unavailable" };
        fieldAvailability.displayClose = { status: "temporarily_unavailable" };
      }
    }
    bars.push({
      timestamp: at,
      ...ohlc,
      adjustedClose,
      displayClose,
      volume,
      ...(Object.keys(fieldAvailability).length ? { fieldAvailability } : {}),
    });
  }
  bars.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const totalRows = raw.quotes.length;
  if (totalRows === 0) {
    throw new MarketDataError(ERROR_CODES.UPSTREAM_UNAVAILABLE, "Yahoo returned no history rows for the requested window", {
      provider: "yahoo",
      capability: "history",
      instrumentId: descriptor.id,
      retryable: true,
      details: { reason: "empty_history", totalRows, range, interval },
    });
  }
  if (!bars.length || droppedRows / totalRows > invalidRowThreshold) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Yahoo history exceeded the invalid-row quality gate", {
      provider: "yahoo",
      capability: "history",
      instrumentId: descriptor.id,
      retryable: true,
      details: { totalRows, droppedRows, invalidRowThreshold },
    });
  }
  if (missingAdjustedCloseRows > 0) {
    issues.push({ code: "partial_adjusted_series", severity: "warning", field: "adjustedClose" });
  }

  const seriesAvailability = {};
  if (policy.volume === "not_applicable") {
    seriesAvailability.volume = {
      status: "not_applicable",
      reason: descriptor.assetClass === "fx" ? "fx_otc_volume" : descriptor.assetClass,
    };
  }
  const providerSymbol = descriptor.providerSymbols.yahoo.symbol;
  const futureIdentity = descriptor.assetClass === "commodity_future";
  const series = {
    instrumentId: descriptor.id,
    assetClass: descriptor.assetClass,
    range,
    interval,
    priceBasis,
    requestedPriceBasis: priceBasis,
    adjustment: priceBasis === "provider_adjusted"
      ? {
          status: "provider_defined",
          includesSplits: true,
          includesDistributions: "unknown",
          formulaVersion: null,
        }
      : {
          status: "none",
          includesSplits: false,
          includesDistributions: false,
          formulaVersion: null,
        },
    continuity: futureIdentity
      ? {
          kind: "provider_continuous_front",
          activeContract: `${futureQuote?.underlyingSymbol || raw.meta?.underlyingSymbol || raw.meta?.symbol || providerSymbol}`,
          expirationDate: timestamp(futureQuote?.expireDate || raw.meta?.expireDate),
          rollover: "provider_managed",
          backAdjustment: "unknown",
          comparableAcrossRollover: false,
        }
      : { kind: "single_instrument", rollover: null },
    session: sessionFor(descriptor, raw.meta || {}, { withPhase: false }),
    ...(Object.keys(seriesAvailability).length ? { fieldAvailability: seriesAvailability } : {}),
    bars,
    events: normalizeEvents(raw, descriptor),
    quality: "fresh",
    dataQuality: {
      status: issues.length ? "usable_with_warnings" : "usable",
      rowCount: bars.length,
      droppedRows,
      ...(priceBasis === "provider_adjusted" ? { missingAdjustedCloseRows } : {}),
      issues,
    },
    provenance: { source: "yahoo", providerSymbol, fallback: false },
    asOf: bars.at(-1).timestamp,
    fetchedAt: fetchedAt(clock),
  };
  validateHistorySeries(series);
  return series;
}

function unwrap(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.hasOwn(value, "raw")) return value.raw;
    if (Object.hasOwn(value, "fmt")) return value.fmt;
  }
  return value ?? null;
}

function first(...values) {
  for (const value of values) {
    const candidate = unwrap(value);
    if (candidate !== null && candidate !== undefined && candidate !== "") return candidate;
  }
  return null;
}

function percentage(value) {
  const number = finite(unwrap(value));
  return number === null ? null : number * 100;
}

function detailSection(id, fields, { unsupportedNulls = false } = {}) {
  const normalized = Object.fromEntries(Object.entries(fields)
    .map(([key, value]) => [key, unwrap(value)]));
  const available = Object.values(normalized).some((value) => value !== null && value !== undefined && value !== "");
  if (!available) {
    return { id, status: "temporarily_unavailable", fields: {}, fieldAvailability: {} };
  }
  const fieldAvailability = Object.fromEntries(Object.entries(normalized)
    .filter(([, value]) => value === null || value === undefined || value === "")
    .map(([field]) => [field, unsupportedNulls
      ? { status: "unsupported", reason: "provider_does_not_expose" }
      : { status: "temporarily_unavailable" }]));
  return { id, status: "available", fields: normalized, fieldAvailability };
}

function holdingsText(value) {
  const rows = Array.isArray(value) ? value : [];
  const symbols = rows.map((entry) => first(entry?.symbol, entry?.holdingName, entry?.name)).filter(Boolean);
  return symbols.length ? symbols.slice(0, 10).join(", ") : null;
}

export function normalizeYahooDetails(raw, {
  descriptor,
  quote = null,
  clock = Date.now,
} = {}) {
  if (!raw || typeof raw !== "object" || !descriptor?.id) {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Yahoo returned an invalid details payload", {
      provider: "yahoo",
      capability: "details",
      instrumentId: descriptor?.id || null,
      retryable: true,
    });
  }
  const kind = assetPolicyFor(descriptor.assetClass).detailKind;
  const profile = raw.assetProfile || raw.summaryProfile || {};
  const summary = raw.summaryDetail || {};
  const stats = raw.defaultKeyStatistics || {};
  const financial = raw.financialData || {};
  const price = raw.price || {};
  const quoteType = raw.quoteType || {};
  const sections = [];

  if (kind === "company") {
    sections.push(detailSection("company_profile", {
      sector: first(profile.sector),
      industry: first(profile.industry),
      country: first(profile.country),
      website: first(profile.website),
      employees: finiteCount(first(profile.fullTimeEmployees)),
    }, { unsupportedNulls: true }));
    const revenue = finite(first(financial.totalRevenue));
    const freeCashFlow = finite(first(financial.freeCashflow));
    sections.push(detailSection("equity_fundamentals", {
      marketCap: finite(first(summary.marketCap, price.marketCap)),
      trailingPe: finite(first(summary.trailingPE)),
      forwardPe: finite(first(summary.forwardPE, stats.forwardPE)),
      epsTtm: finite(first(stats.trailingEps)),
      beta: finite(first(stats.beta)),
      priceBook: finite(first(stats.priceToBook, summary.priceToBook)),
      priceSales: finite(first(summary.priceToSalesTrailing12Months, stats.priceToSalesTrailing12Months)),
      dividendYield: percentage(first(summary.dividendYield)),
      revenueTtm: revenue,
      revenueGrowth: percentage(first(financial.revenueGrowth)),
      netMargin: percentage(first(financial.profitMargins)),
      returnOnEquity: percentage(first(financial.returnOnEquity)),
      debtEquity: finite(first(financial.debtToEquity)) === null
        ? null
        : finite(first(financial.debtToEquity)) / 100,
      freeCashFlow,
      freeCashFlowMargin: revenue && freeCashFlow !== null ? (freeCashFlow / revenue) * 100 : null,
      fiftyTwoWeekLow: finite(first(summary.fiftyTwoWeekLow, price.fiftyTwoWeekLow)),
      fiftyTwoWeekHigh: finite(first(summary.fiftyTwoWeekHigh, price.fiftyTwoWeekHigh)),
    }));
    sections.push(detailSection("analyst_outlook", {
      recommendation: first(financial.recommendationKey),
      targetMeanPrice: finite(first(financial.targetMeanPrice)),
      numberOfAnalysts: finiteCount(first(financial.numberOfAnalystOpinions)),
    }));
  } else if (kind === "fund") {
    const fund = raw.fundProfile || {};
    const holdings = raw.topHoldings || {};
    sections.push(detailSection("fund_profile", {
      family: first(fund.family, profile.companyOfficers?.[0]?.name),
      category: first(fund.categoryName, fund.category, quoteType.category),
      legalType: first(fund.legalType),
      expenseRatio: percentage(first(
        fund.feesExpensesInvestment?.annualReportExpenseRatio,
        stats.annualReportExpenseRatio,
      )),
    }, { unsupportedNulls: true }));
    sections.push(detailSection("fund_composition", {
      topHoldings: holdingsText(holdings.holdings || holdings.topHoldings),
      equityAllocation: percentage(first(holdings.stockPosition, holdings.equityPosition)),
      bondAllocation: percentage(first(holdings.bondPosition)),
      cashAllocation: percentage(first(holdings.cashPosition)),
    }, { unsupportedNulls: true }));
    sections.push(detailSection("fund_stats", {
      totalAssets: finiteCount(first(summary.totalAssets, stats.totalAssets)),
      yield: percentage(first(summary.yield, summary.dividendYield)),
      nav: finite(first(summary.navPrice, price.navPrice)),
    }));
  } else if (kind === "index" || kind === "rate_index") {
    sections.push(detailSection("index_metadata", {
      publisher: descriptor.venue.name,
      ...(kind === "rate_index"
        ? { underlying: descriptor.name, priceUnit: descriptor.priceUnit }
        : { constituents: first(quoteType.components), launchDate: first(quoteType.firstTradeDateEpochUtc) }),
    }, { unsupportedNulls: true }));
    sections.push(detailSection("market_stats", {
      fiftyTwoWeekHigh: finite(first(summary.fiftyTwoWeekHigh, price.fiftyTwoWeekHigh)),
      fiftyTwoWeekLow: finite(first(summary.fiftyTwoWeekLow, price.fiftyTwoWeekLow)),
    }));
  } else if (kind === "currency_pair") {
    sections.push(detailSection("pair_metadata", {
      baseCurrency: descriptor.baseCurrency,
      quoteCurrency: descriptor.quoteCurrency,
      sessionModel: "24x5",
    }));
  } else if (kind === "crypto_asset") {
    sections.push(detailSection("crypto_metadata", {
      baseAsset: descriptor.baseCurrency,
      quoteCurrency: descriptor.quoteCurrency,
      network: first(profile.network),
    }, { unsupportedNulls: true }));
    sections.push(detailSection("crypto_market_stats", {
      marketCap: finite(first(price.marketCap, summary.marketCap, quote?.marketCap)),
      circulatingSupply: finiteCount(first(quote?.circulatingSupply, summary.circulatingSupply)),
      volume24h: finiteCount(first(quote?.volume24Hr, summary.volume24Hr)),
    }));
  } else if (kind === "future_contract") {
    sections.push(detailSection("future_contract", {
      activeContract: first(quote?.underlyingSymbol),
      expirationDate: timestamp(quote?.expireDate),
      underlying: descriptor.name,
      openInterest: finiteCount(first(summary.openInterest)),
    }));
    sections.push(detailSection("future_market_stats", {
      settlementPrice: finite(first(summary.previousClose, quote?.regularMarketPreviousClose)),
      dayRangeLow: finite(first(summary.dayLow, quote?.regularMarketDayLow)),
      dayRangeHigh: finite(first(summary.dayHigh, quote?.regularMarketDayHigh)),
    }));
    sections.push(detailSection("rollover_notice", {
      continuity: "provider_continuous_front",
      comparableAcrossRollover: false,
    }));
  }

  const observedAt = fetchedAt(clock);
  const details = {
    instrument: descriptor,
    kind,
    sections,
    metrics: [],
    quality: qualityFrom(quote || price),
    dataQuality: { status: "usable", issues: [] },
    provenance: {
      source: "yahoo",
      providerSymbol: descriptor.providerSymbols.yahoo.symbol,
      fallback: false,
    },
    asOf: timestamp(quote?.regularMarketTime, observedAt),
    fetchedAt: observedAt,
  };
  validateInstrumentDetails(details);
  return details;
}
