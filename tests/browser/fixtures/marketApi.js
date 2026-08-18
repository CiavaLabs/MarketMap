const GENERATED_AT = "2026-07-15T14:30:00.000Z";
const FETCHED_AT = "2026-07-15T14:30:05.000Z";
const NEXT_REFRESH_AT = "2099-01-01T00:00:00.000Z";
const VERIFIED_AT = "2026-07-15T14:00:00.000Z";

const states = [
  { changePercent: 4.2, quality: "fresh" },
  { changePercent: 1.35, quality: "delayed" },
  { changePercent: 0.12, quality: "stale" },
  { changePercent: -0.08, quality: "fresh" },
  { changePercent: -1.7, quality: "fresh" },
  { changePercent: -4.4, quality: "stale" },
];

const HISTORY_RANGES = Object.freeze({
  "1d": Object.freeze(["1m", "5m", "15m"]),
  "5d": Object.freeze(["5m", "15m", "30m", "1h"]),
  "1m": Object.freeze(["1h", "1d"]),
  "6m": Object.freeze(["1d"]),
  "1y": Object.freeze(["1d", "1wk"]),
  "5y": Object.freeze(["1d", "1wk", "1mo"]),
});

const DETAIL_SECTIONS = Object.freeze({
  equity: Object.freeze(["company_profile", "equity_fundamentals", "analyst_outlook"]),
  etf: Object.freeze(["fund_profile", "fund_composition", "fund_stats"]),
  index: Object.freeze(["index_metadata", "market_stats"]),
  fx: Object.freeze(["pair_metadata"]),
  crypto: Object.freeze(["crypto_metadata", "crypto_market_stats"]),
  commodity_future: Object.freeze(["future_contract", "future_market_stats", "rollover_notice"]),
  rate_index: Object.freeze(["index_metadata", "market_stats"]),
});

const DETAIL_KIND = Object.freeze({
  equity: "company",
  etf: "fund",
  index: "index",
  fx: "currency_pair",
  crypto: "crypto_asset",
  commodity_future: "future_contract",
  rate_index: "rate_index",
});

const ASSET_POLICY = Object.freeze({
  equity: Object.freeze({ priceUnit: "currency", sessionModel: "exchange_hours" }),
  etf: Object.freeze({ priceUnit: "currency", sessionModel: "exchange_hours" }),
  index: Object.freeze({ priceUnit: "index_points", sessionModel: "publisher_schedule" }),
  fx: Object.freeze({ priceUnit: "currency_per_unit", sessionModel: "24x5" }),
  crypto: Object.freeze({ priceUnit: "currency", sessionModel: "24x7" }),
  commodity_future: Object.freeze({ priceUnit: "currency", sessionModel: "provider_schedule" }),
  rate_index: Object.freeze({ priceUnit: "percent_yield", sessionModel: "publisher_schedule" }),
});

function mapping(symbol, providerType) {
  return {
    yahoo: {
      symbol,
      providerType,
      verified: true,
      verifiedAt: VERIFIED_AT,
    },
  };
}

function descriptor(input) {
  return Object.freeze({
    status: "active",
    mappingStatus: "resolved",
    ...input,
  });
}

const AAPL = descriptor({
  id: "XNAS:AAPL",
  displaySymbol: "AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  assetSubtype: "common_stock",
  venue: { code: "NMS", name: "NasdaqGS", mic: "XNAS", kind: "exchange" },
  exchange: "NasdaqGS",
  currency: "USD",
  priceUnit: "currency",
  sector: "Technology",
  providerSymbols: mapping("AAPL", "EQUITY"),
});

const MSFT = descriptor({
  ...AAPL,
  id: "XNAS:MSFT",
  displaySymbol: "MSFT",
  symbol: "MSFT",
  name: "Microsoft Corporation",
  providerSymbols: mapping("MSFT", "EQUITY"),
});

const SPY = descriptor({
  id: "ARCX:SPY",
  displaySymbol: "SPY",
  symbol: "SPY",
  name: "SPDR S&P 500 ETF Trust",
  assetClass: "etf",
  assetSubtype: "equity_etf",
  venue: { code: "PCX", name: "NYSE Arca", mic: "ARCX", kind: "exchange" },
  exchange: "NYSE Arca",
  currency: "USD",
  priceUnit: "currency",
  category: "Large Blend",
  providerSymbols: mapping("SPY", "ETF"),
});

const GSPC = descriptor({
  id: "INDEX:^GSPC",
  displaySymbol: "S&P 500",
  symbol: "^GSPC",
  name: "S&P 500 Index",
  assetClass: "index",
  assetSubtype: "market_index",
  venue: { code: "SNP", name: "S&P Dow Jones Indices", mic: null, kind: "index_publisher" },
  exchange: "S&P Dow Jones Indices",
  currency: "USD",
  priceUnit: "index_points",
  category: "US benchmark",
  providerSymbols: mapping("^GSPC", "INDEX"),
});

const FTSEMIB = descriptor({
  id: "INDEX:FTSEMIB.MI",
  displaySymbol: "FTSEMIB.MI",
  symbol: "FTSEMIB.MI",
  name: "FTSE MIB Index",
  assetClass: "index",
  assetSubtype: "market_index",
  venue: { code: "MIL", name: "Milan", mic: null, kind: "index_publisher" },
  exchange: "Milan",
  currency: "EUR",
  priceUnit: "index_points",
  category: "Italian benchmark",
  providerSymbols: mapping("FTSEMIB.MI", "INDEX"),
});

const EURUSD = descriptor({
  id: "FX:EURUSD",
  displaySymbol: "EUR/USD",
  symbol: "EURUSD",
  name: "Euro / US Dollar",
  assetClass: "fx",
  assetSubtype: "spot_pair",
  venue: { code: "CCY", name: "Global FX", mic: null, kind: "fx_network" },
  exchange: "Global FX",
  currency: "USD",
  quoteCurrency: "USD",
  baseCurrency: "EUR",
  priceUnit: "currency_per_unit",
  category: "Major pair",
  providerSymbols: mapping("EURUSD=X", "CURRENCY"),
});

const BTCUSD = descriptor({
  id: "CRYPTO:BTC-USD",
  displaySymbol: "BTC/USD",
  symbol: "BTC-USD",
  name: "Bitcoin / US Dollar",
  assetClass: "crypto",
  assetSubtype: "spot_pair",
  venue: { code: "CCC", name: "Crypto aggregate", mic: null, kind: "crypto_network" },
  exchange: "Crypto aggregate",
  currency: "USD",
  quoteCurrency: "USD",
  baseCurrency: "BTC",
  priceUnit: "currency",
  category: "Digital asset",
  providerSymbols: mapping("BTC-USD", "CRYPTOCURRENCY"),
});

const GOLD = descriptor({
  id: "FUTURE:CMX.GC.CONTINUOUS.1",
  displaySymbol: "GC",
  symbol: "GC=F",
  name: "Gold Futures (continuous front)",
  assetClass: "commodity_future",
  assetSubtype: "continuous_front",
  venue: { code: "CMX", name: "COMEX", mic: "XCEC", kind: "futures_exchange" },
  exchange: "COMEX",
  currency: "USD",
  priceUnit: "currency",
  category: "Metals",
  providerSymbols: mapping("GC=F", "FUTURE"),
});

const US10Y = descriptor({
  id: "RATE:^TNX",
  displaySymbol: "US10Y",
  symbol: "^TNX",
  name: "CBOE 10 Year Treasury Note Yield",
  assetClass: "rate_index",
  assetSubtype: "yield_index",
  venue: { code: "CBOE", name: "Cboe Global Indices", mic: null, kind: "index_publisher" },
  exchange: "Cboe Global Indices",
  currency: "USD",
  priceUnit: "percent_yield",
  category: "Treasury yield",
  providerSymbols: mapping("^TNX", "INDEX"),
});

const ADBE = descriptor({
  ...AAPL,
  id: "XNAS:ADBE",
  displaySymbol: "ADBE",
  symbol: "ADBE",
  name: "Adobe Fixture Inc.",
  providerSymbols: mapping("ADBE", "EQUITY"),
});

const BND = descriptor({
  ...SPY,
  id: "XNAS:BND",
  displaySymbol: "BND",
  symbol: "BND",
  name: "Vanguard Total Bond Market ETF",
  assetSubtype: "bond_etf",
  venue: { code: "NMS", name: "NasdaqGM", mic: "XNAS", kind: "exchange" },
  exchange: "NasdaqGM",
  category: "Intermediate Core Bond",
  providerSymbols: mapping("BND", "ETF"),
});

export const MIXED_ASSET_INSTRUMENTS = Object.freeze([
  AAPL,
  MSFT,
  SPY,
  GSPC,
  EURUSD,
  BTCUSD,
  GOLD,
  US10Y,
]);

const descriptors = new Map([
  ...MIXED_ASSET_INSTRUMENTS,
  ADBE,
  BND,
  FTSEMIB,
].map((instrument) => [instrument.id, instrument]));

const seededQuotes = new Map([
  [AAPL.id, { value: 317.31, changePercent: 4.2 }],
  [MSFT.id, { value: 511.2, changePercent: -1.7 }],
  [SPY.id, { value: 628.42, changePercent: 0.5 }],
  [GSPC.id, { value: 6_318.72, changePercent: 0.45 }],
  [EURUSD.id, { value: 1.0842, changePercent: -0.29 }],
  [BTCUSD.id, { value: 118_412.55, changePercent: 12.8 }],
  [GOLD.id, { value: 3_352.4, changePercent: -5.3 }],
  [US10Y.id, { value: 4.545, changePercent: -0.87, quality: "delayed" }],
  [ADBE.id, { value: 412.35, changePercent: 1.1 }],
  [BND.id, { value: 73.14, changePercent: 0.12 }],
  [FTSEMIB.id, { value: 51_882.28, changePercent: -0.94, quality: "delayed" }],
]);

function apiEnvelope(data, errors = []) {
  return {
    data,
    meta: {
      apiVersion: "v1",
      schemaVersion: 2,
      requestId: "browser-fixture-v1",
      generatedAt: GENERATED_AT,
      nextRefreshAt: NEXT_REFRESH_AT,
      descriptorRevision: 1,
    },
    ...(errors.length ? { errors } : {}),
  };
}

function inferredAssetClass(instrumentId) {
  const namespace = instrumentId.split(":", 1)[0];
  return {
    INDEX: "index",
    FX: "fx",
    CRYPTO: "crypto",
    FUTURE: "commodity_future",
    RATE: "rate_index",
  }[namespace] || "equity";
}

function descriptorFor(instrumentId) {
  const known = descriptors.get(instrumentId);
  if (known) return known;
  const [mic, symbol] = instrumentId.split(":");
  return descriptor({
    id: instrumentId,
    displaySymbol: symbol,
    symbol,
    name: `${symbol} Fixture Corporation`,
    assetClass: inferredAssetClass(instrumentId),
    assetSubtype: "common_stock",
    venue: { code: mic, name: mic, mic, kind: "exchange" },
    exchange: mic,
    currency: "USD",
    priceUnit: "currency",
    providerSymbols: mapping(symbol, "EQUITY"),
  });
}

function capabilitiesFor(instrument) {
  const { assetClass } = instrument;
  const quoteFields = {
    price: "supported",
    change: "supported",
    open: "supported",
    previousClose: "supported",
    dayRange: "supported",
    bidAsk: ["index", "rate_index"].includes(assetClass) ? "unsupported" : "partial",
    volume: ["fx", "rate_index"].includes(assetClass) ? "unsupported" : "partial",
    averageVolume: ["equity", "etf"].includes(assetClass) ? "supported" : "unsupported",
    session: "supported",
  };
  const adjusted = ["equity", "etf"].includes(assetClass);
  return {
    quote: { status: "supported", fields: quoteFields },
    history: {
      status: "supported",
      ranges: HISTORY_RANGES,
      priceBases: adjusted ? ["raw", "provider_adjusted"] : ["raw"],
    },
    details: assetClass === "rate_index"
      ? { status: "unsupported", reason: "fixture_no_provider_coverage" }
      : { status: "supported", sections: DETAIL_SECTIONS[assetClass] },
    news: assetClass === "equity"
      ? { status: "supported" }
      : { status: "unsupported", reason: "asset_class" },
    analytics: { status: "unsupported", reason: "not_available_in_current_release" },
  };
}

function unavailable(reason) {
  return { status: "not_applicable", reason };
}

function quote(instrumentId, index = 0, { useSeededValues = false } = {}) {
  const instrument = descriptorFor(instrumentId);
  const policy = ASSET_POLICY[instrument.assetClass];
  const legacyState = states[index % states.length];
  const legacyPreviousClose = 78 + index * 7.25;
  const state = useSeededValues && seededQuotes.has(instrumentId)
    ? seededQuotes.get(instrumentId)
    : {
        ...legacyState,
        value: legacyPreviousClose * (1 + legacyState.changePercent / 100),
      };
  const previousClose = state.value / (1 + state.changePercent / 100);
  const change = state.value - previousClose;
  const noBook = ["index", "rate_index"].includes(instrument.assetClass);
  const crypto = instrument.assetClass === "crypto";
  const noVolume = ["fx", "rate_index"].includes(instrument.assetClass);
  const noAverage = !["equity", "etf"].includes(instrument.assetClass);
  const quality = state.quality || "fresh";
  const session = {
    model: policy.sessionModel,
    phase: policy.sessionModel === "24x7" || policy.sessionModel === "24x5"
      ? "continuous"
      : instrument.assetClass === "rate_index"
        ? "pre"
        : "regular",
    timezone: policy.sessionModel === "24x7" || policy.sessionModel === "24x5"
      ? "UTC"
      : "America/New_York",
    isTrading: ["publisher_schedule"].includes(policy.sessionModel) ? null : true,
    regularStart: null,
    regularEnd: null,
  };
  const fieldAvailability = {
    change: { status: "available" },
    changePercent: { status: "available" },
    open: { status: "available" },
    previousClose: { status: "available" },
    dayHigh: { status: "available" },
    dayLow: { status: "available" },
    bid: noBook
      ? unavailable("index_no_order_book")
      : crypto
        ? { status: "unsupported", reason: "provider_does_not_expose" }
        : { status: "available" },
    ask: noBook
      ? unavailable("index_no_order_book")
      : crypto
        ? { status: "unsupported", reason: "provider_does_not_expose" }
        : { status: "available" },
    volume: noVolume
      ? unavailable(instrument.assetClass === "fx" ? "fx_otc_volume" : "rate_index")
      : { status: "available" },
    averageVolume3m: noVolume
      ? unavailable(instrument.assetClass === "fx" ? "fx_otc_volume" : "rate_index")
      : noAverage
        ? { status: "unsupported", reason: "provider_does_not_expose" }
        : { status: "available" },
  };
  const warnings = quality === "delayed"
    ? [{ code: "provider_delayed", severity: "info", field: null }]
    : quality === "stale"
      ? [{ code: "stale_last_known_good", severity: "warning", field: null }]
      : [];
  const spread = useSeededValues
    ? Math.max(Math.abs(state.value) * 0.0001, 0.0001)
    : 0.03;
  const bid = noBook || crypto ? null : state.value - spread;
  const ask = noBook || crypto ? null : state.value + spread;
  const volume = noVolume ? null : instrument.assetClass === "crypto"
    ? 48_221_004_800
    : 1_500_000 + index * 275_000;
  const averageVolume3m = noAverage || noVolume ? null : 2_250_000 + index * 310_000;
  return {
    instrumentId,
    assetClass: instrument.assetClass,
    value: state.value,
    price: state.value,
    priceUnit: policy.priceUnit,
    currency: instrument.currency || instrument.quoteCurrency || null,
    change,
    changePercent: state.changePercent,
    open: previousClose * 0.997,
    previousClose,
    dayHigh: state.value * 1.012,
    dayLow: state.value * 0.986,
    bid,
    ask,
    volume,
    averageVolume3m,
    session,
    fieldAvailability,
    quality,
    dataQuality: {
      status: warnings.length ? "usable_with_warnings" : "usable",
      issues: warnings,
    },
    provenance: {
      source: "yahoo",
      providerSymbol: instrument.providerSymbols.yahoo.symbol,
      providerType: instrument.providerSymbols.yahoo.providerType,
      fallback: false,
      ...(quality === "stale" ? { originalSource: "yahoo" } : {}),
    },
    asOf: GENERATED_AT,
    fetchedAt: FETCHED_AT,
  };
}

const BAR_COUNTS = Object.freeze({
  "1d:1m": 390,
  "1d:5m": 78,
  "1d:15m": 26,
  "5d:5m": 390,
  "5d:15m": 130,
  "5d:30m": 65,
  "5d:1h": 35,
  "1m:1h": 160,
  "1m:1d": 22,
  "6m:1d": 126,
  "1y:1d": 252,
  "1y:1wk": 52,
  "5y:1d": 1260,
  "5y:1wk": 261,
  "5y:1mo": 61,
});

const INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1wk": 7 * 24 * 60 * 60_000,
  "1mo": 30 * 24 * 60 * 60_000,
});

function bars(index = 0, { range = "1d", interval = "5m", priceBasis = "raw", noVolume = false } = {}) {
  const start = 96 + index * 2.5;
  const count = BAR_COUNTS[`${range}:${interval}`] || 78;
  const step = INTERVAL_MS[interval] || INTERVAL_MS["5m"];
  const firstTimestamp = Date.parse(GENERATED_AT) - (count - 1) * step;
  return Array.from({ length: count }, (_, point) => {
    const close = start
      + Math.sin(point / 4.2) * 1.35
      + Math.sin(point / 11.7) * 0.8
      + point * (1.8 / Math.max(count - 1, 1));
    const adjustedClose = priceBasis === "provider_adjusted" ? close * 0.998 : close;
    return {
      timestamp: new Date(firstTimestamp + point * step).toISOString(),
      open: close - 0.35,
      high: close + 0.72,
      low: close - 0.81,
      close,
      adjustedClose,
      displayClose: priceBasis === "provider_adjusted" ? adjustedClose : close,
      volume: noVolume ? null : 70_000 + point * 4_500,
    };
  });
}

function history(instrumentId, index, { range, interval, priceBasis }) {
  const instrument = descriptorFor(instrumentId);
  const noVolume = ["fx", "rate_index"].includes(instrument.assetClass);
  const seriesBars = bars(index, { range, interval, priceBasis, noVolume });
  const future = instrument.assetClass === "commodity_future";
  return {
    instrumentId,
    assetClass: instrument.assetClass,
    range,
    interval,
    priceBasis,
    requestedPriceBasis: priceBasis,
    adjustment: {
      status: priceBasis === "provider_adjusted" ? "provider_defined" : "none",
      includesSplits: priceBasis === "provider_adjusted" ? "unknown" : false,
      includesDistributions: priceBasis === "provider_adjusted" ? "unknown" : false,
      formulaVersion: null,
    },
    continuity: future
      ? {
          kind: "provider_continuous_front",
          activeContract: "GCQ26.CMX",
          expirationDate: "2026-08-27T00:00:00.000Z",
          rollover: "provider_managed",
          backAdjustment: "unknown",
          comparableAcrossRollover: false,
        }
      : { kind: "single_instrument", rollover: null },
    session: {
      model: ASSET_POLICY[instrument.assetClass].sessionModel,
      timezone: ["fx", "crypto"].includes(instrument.assetClass) ? "UTC" : "America/New_York",
    },
    ...(noVolume ? {
      fieldAvailability: {
        volume: unavailable(instrument.assetClass === "fx" ? "fx_otc_volume" : "rate_index"),
      },
    } : {}),
    bars: seriesBars,
    events: [],
    quality: "fresh",
    dataQuality: {
      status: "usable",
      rowCount: seriesBars.length,
      droppedRows: 0,
      ...(priceBasis === "provider_adjusted" ? { missingAdjustedCloseRows: 0 } : {}),
      issues: [],
    },
    provenance: {
      source: "yahoo",
      providerSymbol: instrument.providerSymbols.yahoo.symbol,
      fallback: false,
    },
    asOf: GENERATED_AT,
    fetchedAt: FETCHED_AT,
  };
}

function detailSections(instrument) {
  switch (instrument.assetClass) {
    case "equity":
      return [
        { id: "company_profile", status: "available", fields: { sector: instrument.sector || "Technology", industry: "Software", country: "United States" }, fieldAvailability: {} },
        {
          id: "equity_fundamentals",
          status: "available",
          fields: {
            marketCap: 3_100_000_000_000,
            trailingPe: 31.2,
            forwardPe: 27.4,
            epsTtm: 9.28,
            beta: 1.08,
            priceBook: 12.6,
            priceSales: 8.4,
            dividendYield: 0.52,
            revenueTtm: 394_000_000_000,
            revenueGrowth: 5.4,
            netMargin: 25.3,
            returnOnEquity: 147.2,
            debtEquity: 1.48,
            freeCashFlow: 99_600_000_000,
            freeCashFlowMargin: 25.3,
            fiftyTwoWeekLow: 64.12,
            fiftyTwoWeekHigh: 98.4,
          },
          fieldAvailability: {},
        },
        { id: "analyst_outlook", status: "available", fields: { recommendation: "strong_buy", targetMeanPrice: 92.5, numberOfAnalysts: 38 }, fieldAvailability: {} },
      ];
    case "etf":
      return [
        { id: "fund_profile", status: "available", fields: { family: "Fixture Funds", category: instrument.category, expenseRatio: 0.09 }, fieldAvailability: {} },
        { id: "fund_composition", status: "available", fields: { topHoldings: "AAPL, MSFT, NVDA", equityAllocation: 99.6 }, fieldAvailability: {} },
        { id: "fund_stats", status: "available", fields: { totalAssets: 641_000_000_000, yield: 1.21 }, fieldAvailability: {} },
      ];
    case "index":
      return [
        { id: "index_metadata", status: "available", fields: { publisher: "S&P Dow Jones Indices", constituents: 503 }, fieldAvailability: {} },
        { id: "market_stats", status: "available", fields: { fiftyTwoWeekHigh: 6_402.11, fiftyTwoWeekLow: 4_953.56 }, fieldAvailability: {} },
      ];
    case "fx":
      return [{
        id: "pair_metadata",
        status: "available",
        fields: { baseCurrency: "EUR", quoteCurrency: "USD", sessionModel: "24x5" },
        fieldAvailability: {},
      }];
    case "crypto":
      return [
        { id: "crypto_metadata", status: "available", fields: { baseAsset: "BTC", quoteCurrency: "USD" }, fieldAvailability: {} },
        { id: "crypto_market_stats", status: "available", fields: { marketCap: 2_340_000_000_000, circulatingSupply: 19_780_000, volume24h: 48_221_004_800 }, fieldAvailability: {} },
      ];
    case "commodity_future":
      return [
        { id: "future_contract", status: "available", fields: { activeContract: "GCQ26.CMX", expirationDate: "2026-08-27T00:00:00.000Z", underlying: "Gold" }, fieldAvailability: {} },
        { id: "future_market_stats", status: "available", fields: { settlementPrice: 3_365, dayRangeLow: 3_344.1, dayRangeHigh: 3_371.8 }, fieldAvailability: {} },
        { id: "rollover_notice", status: "available", fields: { continuity: "provider_continuous_front", comparableAcrossRollover: false }, fieldAvailability: {} },
      ];
    default:
      return [];
  }
}

function details(instrumentId, requestedSections = []) {
  const instrument = descriptorFor(instrumentId);
  const requested = new Set(requestedSections);
  return {
    instrument,
    kind: DETAIL_KIND[instrument.assetClass],
    sections: detailSections(instrument).filter((section) => !requested.size || requested.has(section.id)),
    metrics: [],
    quality: "fresh",
    dataQuality: { status: "usable", issues: [] },
    provenance: {
      source: "yahoo",
      providerSymbol: instrument.providerSymbols.yahoo.symbol,
      fallback: false,
    },
    asOf: GENERATED_AT,
    fetchedAt: FETCHED_AT,
  };
}

const NEWS_HEADLINES = Object.freeze([
  "Chip demand lifts the outlook for the next quarter",
  "Cloud investment remains resilient as margins expand",
  "Markets weigh a fresh wave of corporate guidance",
  "Analysts revisit estimates after the latest product update",
  "Board approves a measured increase in capital returns",
  "Enterprise demand supports a steadier revenue mix",
  "Supply-chain progress brings delivery targets closer",
  "New partnerships broaden the company’s addressable market",
  "Management outlines priorities for disciplined growth",
  "Institutional investors focus on cash-flow durability",
  "Research spending rises ahead of the next launch cycle",
  "Sector momentum keeps the company on investors’ radar",
]);

function newsArticles(instrumentIds, requestedLimit = 12) {
  const ids = [...new Set(instrumentIds)].filter(Boolean);
  const limit = Math.max(1, Math.min(Number(requestedLimit) || 12, 20));
  if (!ids.length) return [];
  return Array.from({ length: limit }, (_, index) => {
    const instrumentId = ids[index % ids.length];
    const provider = ids.length > 1 && index % 4 === 3 ? "finnhub" : "yahoo";
    return {
      id: `${provider}:browser-fixture-${index + 1}`,
      title: NEWS_HEADLINES[index % NEWS_HEADLINES.length],
      publisher: index % 4 === 3 ? "Financial Times" : index % 3 === 2 ? "Reuters" : "MarketWatch",
      url: `https://news.example.test/markets/${index + 1}?instrument=${encodeURIComponent(instrumentId)}`,
      publishedAt: new Date(Date.parse(GENERATED_AT) - index * 37 * 60_000).toISOString(),
      instrumentIds: index === 0 && ids.length > 2 ? ids.slice(0, 4) : [instrumentId],
      provider,
    };
  });
}

function newsEnvelope(data, { errors = [], sources = ["yahoo", "finnhub"] } = {}) {
  const response = {
    ...apiEnvelope(data, errors),
    sources: { news: sources },
  };
  response.meta.lastUpdatedAt = GENERATED_AT;
  return response;
}

async function fulfill(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload),
    headers: { "cache-control": "no-store" },
  });
}

function recordRequest(requests, apiVersion, relativePath, request) {
  requests.push({
    apiVersion,
    method: request.method(),
    path: relativePath,
    url: request.url(),
  });
}

function searchResults(url) {
  const query = (url.searchParams.get("q") || "").toLowerCase();
  const assetClasses = new Set((url.searchParams.get("assetClass") || "").split(",").filter(Boolean));
  const supported = [ADBE, BND, FTSEMIB]
    .filter((instrument) => [instrument.symbol, instrument.name].join(" ").toLowerCase().includes(query))
    .filter((instrument) => !assetClasses.size || assetClasses.has(instrument.assetClass))
    .map((instrument) => ({
      instrument,
      capabilities: capabilitiesFor(instrument),
      mappingStatus: "resolved",
      addable: true,
      reasonCode: null,
    }));
  if (
    "silver future".includes(query)
    && (!assetClasses.size || assetClasses.has("commodity_future"))
  ) {
    supported.push({
      candidate: {
        providerSymbol: "SI=F",
        displaySymbol: "SI",
        name: "Silver Futures (unverified fixture)",
        assetClass: "commodity_future",
        exchange: "COMEX",
        currency: "USD",
      },
      mappingStatus: "provisional",
      addable: false,
      reasonCode: "identity_provisional",
    });
  }
  return supported;
}

export async function installMarketApiFixture(page, options = {}) {
  const requests = options.requests || [];
  const unavailableIds = new Set(options.unavailableIds || []);
  const emptyHistoryRanges = new Set(options.emptyHistoryRanges || []);
  const keepLegacyPartial = options.partialSnapshot !== false;

  await page.route("**/api/market/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relativePath = url.pathname.replace(/^\/api\/market\/v1/, "");
    recordRequest(requests, "v1", relativePath, request);

    if (relativePath === "/news") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const articles = newsArticles(ids, url.searchParams.get("limit") || "12");
      await fulfill(route, newsEnvelope(
        { articles },
        { sources: [...new Set(articles.map(({ provider }) => provider))] },
      ));
      return;
    }

    const newsRoute = relativePath.match(/^\/instruments\/([^/]+)\/news$/);
    if (newsRoute) {
      const instrumentId = decodeURIComponent(newsRoute[1]);
      const articles = newsArticles([instrumentId], url.searchParams.get("limit") || "6");
      await fulfill(route, newsEnvelope({
        instrumentId,
        articles,
        source: "yahoo",
        quality: "fresh",
        asOf: articles[0]?.publishedAt || GENERATED_AT,
        fetchedAt: FETCHED_AT,
      }, { sources: ["yahoo"] }));
      return;
    }

    if (relativePath === "/health") {
      const capabilities = [
        "details",
        "health",
        "history",
        "history-batch",
        "instrument",
        "news",
        "news-batch",
        "search",
        "snapshot",
      ];
      if (options.analyticsRecords) capabilities.push("analytics-snapshot");
      await fulfill(route, apiEnvelope({ status: "ok", fixture: true, capabilities: capabilities.sort() }));
      return;
    }

    if (relativePath === "/snapshot") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const useSeededValues = ids.some((id) => descriptorFor(id).assetClass !== "equity");
      const unavailable = new Set(unavailableIds);
      if (keepLegacyPartial && ids.length >= 40 && unavailable.size === 0) unavailable.add(ids.at(-1));
      const data = ids
        .map((instrumentId, index) => unavailable.has(instrumentId)
          ? null
          : quote(instrumentId, index, { useSeededValues }))
        .filter(Boolean);
      const errors = ids.filter((id) => unavailable.has(id)).map((instrumentId) => ({
        instrumentId,
        operation: "quote",
        assetClass: descriptorFor(instrumentId).assetClass,
        code: "fixture_unavailable",
        reason: "fixture_unavailable",
        message: "Deterministic unavailable state",
        retryable: true,
      }));
      await fulfill(route, apiEnvelope(data, errors));
      return;
    }

    if (relativePath === "/history") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const range = url.searchParams.get("range") || "1d";
      const interval = url.searchParams.get("interval") || "5m";
      const priceBasis = url.searchParams.get("priceBasis") || "raw";
      await fulfill(route, apiEnvelope(ids.map((instrumentId, index) => {
        const series = history(instrumentId, index, { range, interval, priceBasis });
        return emptyHistoryRanges.has(range)
          ? { ...series, bars: [], dataQuality: { ...series.dataQuality, rowCount: 0 } }
          : series;
      })));
      return;
    }

    if (relativePath === "/instruments/search") {
      await fulfill(route, apiEnvelope(searchResults(url)));
      return;
    }

    if (relativePath === "/analytics/snapshot") {
      const records = options.analyticsRecords || null;
      if (!records) {
        await fulfill(route, {
          type: "about:blank",
          title: "Not implemented",
          status: 501,
          detail: "analytics-snapshot",
          code: "not_implemented",
          retryable: false,
        }, 501);
        return;
      }
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      await fulfill(route, apiEnvelope(ids.map((id) => records[id]).filter(Boolean)));
      return;
    }

    const instrumentRoute = relativePath.match(/^\/instruments\/([^/]+)(?:\/(history|details))?$/);
    if (instrumentRoute) {
      const instrumentId = decodeURIComponent(instrumentRoute[1]);
      const instrument = descriptorFor(instrumentId);
      if (!instrumentRoute[2]) {
        await fulfill(route, apiEnvelope({
          instrument,
          capabilities: capabilitiesFor(instrument),
          mappingStatus: "resolved",
          addable: true,
          reasonCode: null,
        }));
      } else if (instrumentRoute[2] === "history") {
        const range = url.searchParams.get("range") || "1d";
        const interval = url.searchParams.get("interval") || "5m";
        const priceBasis = url.searchParams.get("priceBasis") || "raw";
        const series = history(instrumentId, 0, { range, interval, priceBasis });
        await fulfill(route, apiEnvelope(emptyHistoryRanges.has(range)
          ? { ...series, bars: [], dataQuality: { ...series.dataQuality, rowCount: 0 } }
          : series));
      } else {
        const sections = (url.searchParams.get("section") || "").split(",").filter(Boolean);
        await fulfill(route, apiEnvelope(details(instrumentId, sections)));
      }
      return;
    }

    await fulfill(route, {
      type: "about:blank",
      title: "Fixture route not found",
      status: 404,
      detail: relativePath,
      code: "fixture_not_found",
      retryable: false,
    }, 404);
  });

  return requests;
}
