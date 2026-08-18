import {
  ASSET_CLASSES,
  CANONICAL_INSTRUMENT_ID_PATTERN,
  ERROR_CODES,
} from "../contracts/core/constants.js";
import { canonicalUsEquitySector } from "../../shared/sectorTaxonomy.js";
import { validateInstrument } from "../contracts/core/validators.js";
import { MarketDataError } from "../errors/MarketDataError.js";

const FIXED_NAMESPACE_BY_ASSET_CLASS = Object.freeze({
  index: "INDEX",
  fx: "FX",
  crypto: "CRYPTO",
  commodity_future: "FUTURE",
  rate_index: "RATE",
  bond: "BOND",
});

const ASSET_CLASS_BY_FIXED_NAMESPACE = Object.freeze(
  Object.fromEntries(
    Object.entries(FIXED_NAMESPACE_BY_ASSET_CLASS).map(([assetClass, namespace]) => [
      namespace,
      assetClass,
    ]),
  ),
);

const MIC_BASED_ASSET_CLASSES = new Set([
  "equity",
  "etf",
  "mutual_fund",
  "commodity_proxy",
]);

const MIC_PATTERN = /^[A-Z0-9]{4}$/;

export const CURATED_CONTINUOUS_FUTURES = Object.freeze({
  "GC=F": Object.freeze({
    id: "FUTURE:CMX.GC.CONTINUOUS.1",
    providerSymbol: "GC=F",
    displaySymbol: "GC",
    venueCode: "CMX",
    mic: "XCEC",
  }),
});

const CURATED_SECTOR_ETF_DEFINITIONS = Object.freeze([
  Object.freeze({
    symbol: "XLK",
    name: "State Street Technology Select Sector SPDR ETF",
    category: "Technology",
  }),
  Object.freeze({
    symbol: "XLC",
    name: "State Street Communication Services Select Sector SPDR ETF",
    category: "Communication Services",
  }),
  Object.freeze({
    symbol: "XLY",
    name: "State Street Consumer Discretionary Select Sector SPDR ETF",
    category: "Consumer Discretionary",
  }),
  Object.freeze({
    symbol: "XLP",
    name: "State Street Consumer Staples Select Sector SPDR ETF",
    category: "Consumer Staples",
  }),
  Object.freeze({
    symbol: "XLF",
    name: "State Street Financial Select Sector SPDR ETF",
    category: "Financials",
  }),
  Object.freeze({
    symbol: "XLV",
    name: "State Street Health Care Select Sector SPDR ETF",
    category: "Health Care",
  }),
  Object.freeze({
    symbol: "XLE",
    name: "State Street Energy Select Sector SPDR ETF",
    category: "Energy",
  }),
  Object.freeze({
    symbol: "XLI",
    name: "State Street Industrial Select Sector SPDR ETF",
    category: "Industrials",
  }),
  Object.freeze({
    symbol: "XLU",
    name: "State Street Utilities Select Sector SPDR ETF",
    category: "Utilities",
  }),
  Object.freeze({
    symbol: "XLB",
    name: "State Street Materials Select Sector SPDR ETF",
    category: "Materials",
  }),
]);

export const CURATED_ETF_CLASSIFICATIONS = Object.freeze({
  SPY: Object.freeze({
    assetSubtype: "equity_etf",
    category: "Equity",
  }),
  BND: Object.freeze({
    assetSubtype: "bond_etf",
    category: "Fixed Income",
  }),
  AGG: Object.freeze({
    assetSubtype: "bond_etf",
    category: "Fixed Income",
  }),
  ...Object.fromEntries(CURATED_SECTOR_ETF_DEFINITIONS.map(({ symbol, category }) => [
    symbol,
    Object.freeze({
      assetSubtype: "equity_etf",
      category,
    }),
  ])),
});

export function curatedEtfClassificationFor(value) {
  return CURATED_ETF_CLASSIFICATIONS[upper(value)] || null;
}

export const LEGACY_CANONICAL_ID_MIGRATIONS = Object.freeze({
  "FUTURE:GC=F": CURATED_CONTINUOUS_FUTURES["GC=F"].id,
});

const CURATED_INDEX_DISPLAY_SYMBOLS = Object.freeze({
  "^GSPC": "SPX",
  "DX-Y.NYB": "DXY",
});

export function curatedIndexDisplaySymbolFor(symbol) {
  return CURATED_INDEX_DISPLAY_SYMBOLS[upper(symbol)] || null;
}

export function continuousFutureIdentityFor(value) {
  const normalized = upper(value);
  return CURATED_CONTINUOUS_FUTURES[normalized]
    || Object.values(CURATED_CONTINUOUS_FUTURES).find(({ id }) => id === normalized)
    || null;
}

export const EXCHANGE_TO_MIC = Object.freeze({
  ASE: "XASE",
  AMEX: "XASE",
  ARCA: "ARCX",
  BATS: "BATS",
  NAS: "XNAS",
  NCM: "XNAS",
  NGM: "XNAS",
  NMS: "XNAS",
  NASDAQ: "XNAS",
  NYQ: "XNYS",
  NYSE: "XNYS",
  PCX: "ARCX",
  LSE: "XLON",
});

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function upper(value) {
  return cleanText(value).toUpperCase();
}

function normalizeMic(value) {
  const candidate = EXCHANGE_TO_MIC[upper(value)] || upper(value);
  return MIC_PATTERN.test(candidate) ? candidate : null;
}

function normalizeAssetClass(value) {
  const candidate = cleanText(value).toLowerCase();
  return ASSET_CLASSES.includes(candidate) ? candidate : null;
}

function normalizeSymbol(value, assetClass) {
  let symbol = upper(value);
  if (assetClass === "fx") {
    symbol = symbol.replace(/=X$/, "").replaceAll("/", "").replaceAll("_", "");
  }
  if (assetClass === "crypto") {
    symbol = symbol.replaceAll("/", "-");
  }
  if (!symbol || symbol.includes(":") || symbol.includes("/")) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      "Instrument symbol cannot be empty or contain ':' or '/'",
      { details: { symbol: value } },
    );
  }
  if (!/^[A-Z0-9^.=_-]+$/.test(symbol)) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      "Instrument symbol contains unsupported characters",
      { details: { symbol: value } },
    );
  }
  return symbol;
}

function cloneInstrument(instrument) {
  return {
    ...instrument,
    providerSymbols: instrument.providerSymbols
      ? { ...instrument.providerSymbols }
      : undefined,
    aliases: instrument.aliases ? [...instrument.aliases] : undefined,
  };
}

function freezeInstrument(instrument) {
  const copy = cloneInstrument(instrument);
  if (copy.providerSymbols) Object.freeze(copy.providerSymbols);
  if (copy.aliases) Object.freeze(copy.aliases);
  return Object.freeze(copy);
}

export function encodeCanonicalId(input) {
  if (!input || typeof input !== "object") {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      "Instrument identity is required to encode a canonical ID",
    );
  }

  const assetClass = normalizeAssetClass(input.assetClass);
  if (!assetClass) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      `Unsupported asset class: ${String(input.assetClass)}`,
    );
  }

  const symbol = normalizeSymbol(input.symbol, assetClass);
  if (assetClass === "commodity_future") {
    const identity = continuousFutureIdentityFor(symbol);
    if (!identity) {
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `Future identity is not in the curated continuous-alias registry: ${symbol}`,
        { details: { assetClass, symbol } },
      );
    }
    const suppliedMic = input.mic ? normalizeMic(input.mic) : null;
    if (suppliedMic && suppliedMic !== identity.mic) {
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `Future venue does not match the curated identity for ${symbol}`,
        { details: { symbol, expectedMic: identity.mic, actualMic: suppliedMic } },
      );
    }
    return identity.id;
  }
  let namespace = FIXED_NAMESPACE_BY_ASSET_CLASS[assetClass];
  if (MIC_BASED_ASSET_CLASSES.has(assetClass)) {
    namespace = normalizeMic(input.mic || input.exchange);
    if (!namespace) {
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `A valid MIC is required for ${assetClass} instrument ${symbol}`,
        { details: { assetClass, symbol, mic: input.mic || null } },
      );
    }
  }

  const id = `${namespace}:${symbol}`;
  if (!CANONICAL_INSTRUMENT_ID_PATTERN.test(id)) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      "Unable to encode a valid canonical instrument ID",
      { details: { id } },
    );
  }
  return id;
}

export function decodeCanonicalId(value) {
  const id = upper(value);
  if (!CANONICAL_INSTRUMENT_ID_PATTERN.test(id) || id.split(":").length !== 2) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      `Invalid canonical instrument ID: ${String(value)}`,
      { details: { instrumentId: value } },
    );
  }

  const [namespace, symbol] = id.split(":");
  const fixedAssetClass = ASSET_CLASS_BY_FIXED_NAMESPACE[namespace] || null;
  if (!fixedAssetClass && !MIC_PATTERN.test(namespace)) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      `Unknown canonical instrument namespace: ${namespace}`,
      { details: { instrumentId: value } },
    );
  }

  return {
    id,
    namespace,
    symbol,
    assetClass: fixedAssetClass,
    mic: fixedAssetClass ? null : namespace,
  };
}

export function isCanonicalInstrumentId(value) {
  try {
    decodeCanonicalId(value);
    return true;
  } catch {
    return false;
  }
}

export function providerSymbolFor(instrument, provider) {
  if (!instrument || typeof instrument !== "object") return null;
  const explicit = cleanText(instrument.providerSymbols?.[provider]);
  if (explicit) return explicit;

  const symbol = upper(instrument.symbol);
  if (!symbol) return null;
  if (provider === "yahoo") {
    if (instrument.assetClass === "fx") return `${symbol}=X`;
    return symbol;
  }
  if (provider === "finnhub") {
    if (["equity", "etf", "index", "rate_index"].includes(instrument.assetClass)) {
      return symbol;
    }
    return null;
  }
  return null;
}

function equity(mic, symbol, name, sector, exchange) {
  const id = `${mic}:${symbol}`;
  return freezeInstrument({
    id,
    symbol,
    name,
    assetClass: "equity",
    exchange,
    mic,
    currency: "USD",
    country: "US",
    category: "Common Stock",
    sector: canonicalUsEquitySector(id) || sector,
    status: "active",
    providerSymbols: { yahoo: symbol, finnhub: symbol },
  });
}

const INITIAL_EQUITIES = [
  equity("XNAS", "AAPL", "Apple Inc.", "Technology", "Nasdaq"),
  equity("XNAS", "MSFT", "Microsoft Corporation", "Technology", "Nasdaq"),
  equity("XNAS", "GOOGL", "Alphabet Inc.", "Technology", "Nasdaq"),
  equity("XNAS", "AMZN", "Amazon.com, Inc.", "Consumer Cyclical", "Nasdaq"),
  equity("XNAS", "TSLA", "Tesla, Inc.", "Automotive", "Nasdaq"),
  equity("XNAS", "META", "Meta Platforms, Inc.", "Technology", "Nasdaq"),
  equity("XNAS", "NVDA", "NVIDIA Corporation", "Technology", "Nasdaq"),
  equity("XNYS", "JPM", "JPMorgan Chase & Co.", "Financial", "NYSE"),
  equity("XNYS", "V", "Visa Inc.", "Financial", "NYSE"),
  equity("XNYS", "JNJ", "Johnson & Johnson", "Healthcare", "NYSE"),
  equity("XNAS", "WMT", "Walmart Inc.", "Retail", "Nasdaq"),
  equity("XNYS", "PG", "The Procter & Gamble Company", "Consumer Defensive", "NYSE"),
  equity("XNYS", "MA", "Mastercard Incorporated", "Financial", "NYSE"),
  equity("XNYS", "UNH", "UnitedHealth Group Incorporated", "Healthcare", "NYSE"),
  equity("XNYS", "DIS", "The Walt Disney Company", "Entertainment", "NYSE"),
  equity("XNAS", "NFLX", "Netflix, Inc.", "Entertainment", "Nasdaq"),
  equity("XNAS", "ADBE", "Adobe Inc.", "Technology", "Nasdaq"),
  equity("XNYS", "CRM", "Salesforce, Inc.", "Technology", "NYSE"),
  equity("XNAS", "CSCO", "Cisco Systems, Inc.", "Technology", "Nasdaq"),
  equity("XNYS", "ORCL", "Oracle Corporation", "Technology", "NYSE"),
  equity("XNYS", "BAC", "Bank of America Corporation", "Financial", "NYSE"),
  equity("XNYS", "HD", "The Home Depot, Inc.", "Retail", "NYSE"),
  equity("XNYS", "KO", "The Coca-Cola Company", "Consumer Defensive", "NYSE"),
  equity("XNAS", "PEP", "PepsiCo, Inc.", "Consumer Defensive", "Nasdaq"),
  equity("XNYS", "NKE", "NIKE, Inc.", "Consumer Cyclical", "NYSE"),
  equity("XNYS", "MCD", "McDonald's Corporation", "Consumer Cyclical", "NYSE"),
  equity("XNYS", "XOM", "Exxon Mobil Corporation", "Energy", "NYSE"),
  equity("XNYS", "CVX", "Chevron Corporation", "Energy", "NYSE"),
  equity("XNAS", "AMD", "Advanced Micro Devices, Inc.", "Technology", "Nasdaq"),
  equity("XNAS", "QCOM", "QUALCOMM Incorporated", "Technology", "Nasdaq"),
];

const ADDITIONAL_EQUITIES = [
  equity("XNAS", "AVGO", "Broadcom Inc.", "Technology", "Nasdaq"),
  equity("XNAS", "COST", "Costco Wholesale Corporation", "Consumer Defensive", "Nasdaq"),
  equity("XNYS", "GS", "The Goldman Sachs Group, Inc.", "Financial", "NYSE"),
  equity("XNYS", "LLY", "Eli Lilly and Company", "Healthcare", "NYSE"),
  equity("XNYS", "MRK", "Merck & Co., Inc.", "Healthcare", "NYSE"),
  equity("XNYS", "ABBV", "AbbVie Inc.", "Healthcare", "NYSE"),
  equity("XNYS", "CAT", "Caterpillar Inc.", "Industrials", "NYSE"),
  equity("XNYS", "GE", "GE Aerospace", "Industrials", "NYSE"),
  equity("XNYS", "BA", "The Boeing Company", "Industrials", "NYSE"),
  equity("XNYS", "NEE", "NextEra Energy, Inc.", "Utilities", "NYSE"),
  equity("XNAS", "LIN", "Linde plc", "Materials", "Nasdaq"),
];

const CURATED_SECTOR_ETF_SEEDS = CURATED_SECTOR_ETF_DEFINITIONS.map(({
  symbol,
  name,
  category,
}) => freezeInstrument({
  id: `ARCX:${symbol}`,
  symbol,
  name,
  assetClass: "etf",
  assetSubtype: "equity_etf",
  exchange: "NYSE Arca",
  venueCode: "PCX",
  mic: "ARCX",
  currency: "USD",
  country: "US",
  category,
  status: "active",
  providerSymbols: { yahoo: symbol },
}));

const MULTI_ASSET_SEEDS = [
  ...CURATED_SECTOR_ETF_SEEDS,
  freezeInstrument({
    id: "ARCX:SPY",
    symbol: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    assetClass: "etf",
    assetSubtype: "equity_etf",
    exchange: "NYSE Arca",
    venueCode: "PCX",
    mic: "ARCX",
    currency: "USD",
    country: "US",
    category: "Large Blend",
    status: "active",
    providerSymbols: { yahoo: "SPY", finnhub: "SPY" },
  }),
  freezeInstrument({
    id: "XNAS:QQQ",
    symbol: "QQQ",
    name: "Invesco QQQ Trust",
    assetClass: "etf",
    assetSubtype: "equity_etf",
    exchange: "NasdaqGM",
    venueCode: "NGM",
    mic: "XNAS",
    currency: "USD",
    country: "US",
    category: "Large Growth",
    status: "active",
    providerSymbols: { yahoo: "QQQ", finnhub: "QQQ" },
  }),
  freezeInstrument({
    id: "XNAS:TLT",
    symbol: "TLT",
    name: "iShares 20+ Year Treasury Bond ETF",
    assetClass: "etf",
    assetSubtype: "bond_etf",
    exchange: "NasdaqGM",
    venueCode: "NGM",
    mic: "XNAS",
    currency: "USD",
    country: "US",
    category: "Long Government",
    status: "active",
    providerSymbols: { yahoo: "TLT", finnhub: "TLT" },
  }),
  freezeInstrument({
    id: "INDEX:^VIX",
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    assetClass: "index",
    exchange: "Chicago Board Options Exchange",
    venueCode: "CBOE",
    currency: "USD",
    country: "US",
    category: "Volatility Index",
    status: "active",
    providerSymbols: { yahoo: "^VIX" },
    aliases: ["VIX"],
  }),
  freezeInstrument({
    id: "INDEX:DX-Y.NYB",
    symbol: "DX-Y.NYB",
    name: "US Dollar Index",
    assetClass: "index",
    exchange: "ICE Futures US",
    venueCode: "NYB",
    currency: "USD",
    country: "US",
    category: "Currency Index",
    status: "active",
    providerSymbols: { yahoo: "DX-Y.NYB" },
    aliases: ["DXY", "US DOLLAR INDEX"],
  }),
  freezeInstrument({
    id: "FX:USDJPY",
    symbol: "USDJPY",
    name: "USD/JPY",
    assetClass: "fx",
    venueCode: "CCY",
    currency: "JPY",
    category: "FX Major",
    status: "active",
    providerSymbols: { yahoo: "USDJPY=X", finnhub: "OANDA:USD_JPY" },
    aliases: ["USD/JPY"],
  }),
  freezeInstrument({
    id: "CRYPTO:ETH-USD",
    symbol: "ETH-USD",
    name: "Ethereum / US Dollar",
    assetClass: "crypto",
    venueCode: "CCC",
    currency: "USD",
    category: "Cryptocurrency",
    status: "active",
    providerSymbols: { yahoo: "ETH-USD", finnhub: "BINANCE:ETHUSDT" },
    aliases: ["ETHUSD", "ETHEREUM"],
  }),
  freezeInstrument({
    id: "XNAS:BND",
    symbol: "BND",
    name: "Vanguard Total Bond Market ETF",
    assetClass: "etf",
    assetSubtype: "bond_etf",
    exchange: "NasdaqGM",
    venueCode: "NGM",
    mic: "XNAS",
    currency: "USD",
    country: "US",
    category: "Fixed Income",
    status: "active",
    providerSymbols: { yahoo: "BND" },
    aliases: ["VANGUARD TOTAL BOND MARKET ETF"],
  }),
  freezeInstrument({
    id: "ARCX:AGG",
    symbol: "AGG",
    name: "iShares Core U.S. Aggregate Bond ETF",
    assetClass: "etf",
    assetSubtype: "bond_etf",
    exchange: "NYSE Arca",
    venueCode: "PCX",
    mic: "ARCX",
    currency: "USD",
    country: "US",
    category: "Fixed Income",
    status: "active",
    providerSymbols: { yahoo: "AGG" },
    aliases: ["ISHARES CORE US AGGREGATE BOND ETF"],
  }),
  freezeInstrument({
    id: "INDEX:^GSPC",
    symbol: "^GSPC",
    name: "S&P 500 Index",
    assetClass: "index",
    exchange: "S&P Dow Jones Indices",
    venueCode: "SNP",
    currency: "USD",
    country: "US",
    category: "Large Cap Index",
    status: "active",
    providerSymbols: { yahoo: "^GSPC" },
  }),
  freezeInstrument({
    id: "FX:EURUSD",
    symbol: "EURUSD",
    name: "EUR/USD",
    assetClass: "fx",
    venueCode: "CCY",
    currency: "USD",
    category: "FX Major",
    status: "active",
    providerSymbols: { yahoo: "EURUSD=X", finnhub: "OANDA:EUR_USD" },
    aliases: ["EUR/USD"],
  }),
  freezeInstrument({
    id: "CRYPTO:BTC-USD",
    symbol: "BTC-USD",
    name: "Bitcoin / US Dollar",
    assetClass: "crypto",
    venueCode: "CCC",
    currency: "USD",
    category: "Cryptocurrency",
    status: "active",
    providerSymbols: { yahoo: "BTC-USD", finnhub: "BINANCE:BTCUSDT" },
    aliases: ["BTCUSD", "BITCOIN"],
  }),
  freezeInstrument({
    id: "FUTURE:CMX.GC.CONTINUOUS.1",
    symbol: "GC=F",
    name: "Gold Futures (continuous front)",
    assetClass: "commodity_future",
    assetSubtype: "continuous_front",
    exchange: "COMEX",
    venueCode: "CMX",
    mic: "XCEC",
    currency: "USD",
    category: "Metals",
    status: "active",
    providerSymbols: { yahoo: "GC=F" },
    aliases: ["GOLD", "FUTURE:GC=F"],
  }),
  freezeInstrument({
    id: "RATE:^TNX",
    symbol: "^TNX",
    name: "CBOE 10 Year Treasury Note Yield",
    assetClass: "rate_index",
    exchange: "Cboe Global Indices",
    venueCode: "CGI",
    currency: "USD",
    country: "US",
    category: "10Y Treasury Yield",
    status: "active",
    providerSymbols: { yahoo: "^TNX" },
    aliases: ["10Y", "US10Y"],
  }),
];

export const CURATED_INSTRUMENTS = Object.freeze([
  ...INITIAL_EQUITIES,
  ...ADDITIONAL_EQUITIES,
  ...MULTI_ASSET_SEEDS,
]);

export const DEFAULT_BOARD_IDS = Object.freeze([
  "XNAS:AAPL", "ARCX:SPY", "XNAS:MSFT", "INDEX:^GSPC", "XNAS:NVDA",
  "CRYPTO:BTC-USD", "XNAS:GOOGL", "FX:EURUSD", "XNAS:AMZN", "XNAS:QQQ",
  "XNAS:META", "RATE:^TNX", "XNAS:TSLA", "FUTURE:CMX.GC.CONTINUOUS.1", "XNAS:AVGO",
  "INDEX:^VIX", "XNYS:JPM", "FX:USDJPY", "XNYS:V", "XNAS:TLT",
  "XNYS:UNH", "CRYPTO:ETH-USD", "XNYS:JNJ", "INDEX:DX-Y.NYB", "XNAS:COST",
  "XNAS:NFLX", "XNAS:AMD", "XNAS:WMT", "XNYS:XOM", "XNYS:HD",
  "XNYS:KO", "XNYS:ORCL", "XNYS:CRM", "XNAS:ADBE", "XNYS:BAC",
  "XNYS:LLY", "XNYS:ABBV", "XNYS:PG", "XNYS:CAT", "XNYS:GE",
]);

export const DEFAULT_EQUITY_BOARD_IDS = Object.freeze([
  "XNAS:AAPL", "XNAS:MSFT", "XNAS:NVDA", "XNAS:GOOGL", "XNAS:AMZN",
  "XNAS:META", "XNAS:TSLA", "XNAS:AVGO", "XNYS:JPM", "XNYS:V",
  "XNYS:UNH", "XNYS:JNJ", "XNAS:COST", "XNAS:NFLX", "XNAS:AMD",
  "XNAS:WMT", "XNYS:XOM", "XNYS:HD", "XNYS:KO", "XNYS:ORCL",
  "XNYS:CRM", "XNAS:ADBE", "XNYS:BAC", "XNYS:LLY", "XNYS:ABBV",
  "XNYS:PG", "XNYS:CAT", "XNYS:GE",
]);

function normalizedSearchText(value) {
  return upper(value).replace(/[^A-Z0-9^.=_-]+/g, " ").trim();
}

export function rankInstrumentCandidate(candidate, query) {
  const needle = normalizedSearchText(query);
  if (!needle) return 0;
  const id = upper(candidate.id || candidate.instrumentId);
  const symbol = upper(candidate.symbol || candidate.displaySymbol);
  const name = normalizedSearchText(candidate.name || candidate.description);
  const aliases = (candidate.aliases || []).map(normalizedSearchText);

  let score = 0;
  if (id === needle) score = Math.max(score, 220);
  if (symbol === needle) score = Math.max(score, 200);
  if (aliases.includes(needle)) score = Math.max(score, 190);
  if (symbol.startsWith(needle)) score = Math.max(score, 160);
  if (name === needle) score = Math.max(score, 150);
  if (name.startsWith(needle)) score = Math.max(score, 130);
  if (symbol.includes(needle)) score = Math.max(score, 105);
  if (name.includes(needle)) score = Math.max(score, 90);
  if (aliases.some((alias) => alias.includes(needle))) score = Math.max(score, 85);

  const providerScore = Number(candidate.providerScore ?? candidate.score);
  if (score > 0 && Number.isFinite(providerScore) && providerScore > 0) {
    score += Math.min(providerScore, 100) / 100;
  }
  return score;
}

function matchesFilters(instrument, options) {
  const assetClasses = options.assetClasses || options.assetClass;
  if (assetClasses) {
    const allowed = new Set(
      (Array.isArray(assetClasses) ? assetClasses : [assetClasses]).map(normalizeAssetClass),
    );
    if (!allowed.has(instrument.assetClass)) return false;
  }
  if (options.exchange) {
    const expected = upper(options.exchange);
    if (upper(instrument.exchange) !== expected && upper(instrument.mic) !== expected) return false;
  }
  if (options.currency && upper(instrument.currency) !== upper(options.currency)) return false;
  return true;
}

function candidateKey(candidate) {
  if (candidate.id || candidate.instrumentId) {
    return upper(candidate.id || candidate.instrumentId);
  }
  return [candidate.assetClass, candidate.mic || candidate.exchange, candidate.symbol]
    .map(upper)
    .join(":");
}

export function dedupeInstrumentCandidates(candidates) {
  const deduped = new Map();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!key || key === "::") continue;
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, cloneInstrument(candidate));
      continue;
    }
    const currentScore = Number(current.score) || 0;
    const nextScore = Number(candidate.score) || 0;
    const preferred = nextScore > currentScore ? candidate : current;
    const secondary = preferred === candidate ? current : candidate;
    deduped.set(key, {
      ...secondary,
      ...preferred,
      aliases: [...new Set([...(secondary.aliases || []), ...(preferred.aliases || [])])],
      providerSymbols: {
        ...(secondary.providerSymbols || {}),
        ...(preferred.providerSymbols || {}),
      },
    });
  }
  return [...deduped.values()];
}

export class InstrumentCatalog {
  constructor({ instruments = CURATED_INSTRUMENTS } = {}) {
    this._byId = new Map();
    this._byLookup = new Map();
    this.registerMany(instruments);
  }

  #index(value, id) {
    const key = upper(value);
    if (!key) return;
    const ids = this._byLookup.get(key) || new Set();
    ids.add(id);
    this._byLookup.set(key, ids);
  }

  register(rawInstrument, { replace = false } = {}) {
    const instrument = freezeInstrument(rawInstrument);
    validateInstrument(instrument);
    const encodedId = encodeCanonicalId(instrument);
    if (encodedId !== instrument.id) {
      throw new MarketDataError(
        ERROR_CODES.SCHEMA_INVALID,
        `Instrument ID does not match its canonical identity: ${instrument.id}`,
        { details: { expected: encodedId, actual: instrument.id } },
      );
    }
    if (this._byId.has(instrument.id) && !replace) {
      const existing = this._byId.get(instrument.id);
      const merged = freezeInstrument({
        ...existing,
        ...instrument,
        aliases: [...new Set([...(existing.aliases || []), ...(instrument.aliases || [])])],
        providerSymbols: {
          ...(instrument.providerSymbols || {}),
          ...(existing.providerSymbols || {}),
        },
      });
      this._byId.set(merged.id, merged);
      for (const alias of merged.aliases || []) this.#index(alias, merged.id);
      for (const providerSymbol of Object.values(merged.providerSymbols || {})) {
        this.#index(providerSymbol, merged.id);
      }
      return cloneInstrument(merged);
    }
    this._byId.set(instrument.id, instrument);
    this.#index(instrument.symbol, instrument.id);
    this.#index(instrument.id, instrument.id);
    for (const alias of instrument.aliases || []) this.#index(alias, instrument.id);
    for (const providerSymbol of Object.values(instrument.providerSymbols || {})) {
      this.#index(providerSymbol, instrument.id);
    }
    return cloneInstrument(instrument);
  }

  resolveByProviderSymbol(providerSymbol) {
    const key = upper(providerSymbol);
    if (!key) return null;
    const mapped = [...(this._byLookup.get(key) || [])].filter((id) => (
      Object.values(this._byId.get(id)?.providerSymbols || {})
        .some((symbol) => upper(symbol) === key)
    ));
    return mapped.length === 1 ? this.get(mapped[0]) : null;
  }

  registerMany(instruments, options = {}) {
    if (!Array.isArray(instruments)) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Instrument list must be an array");
    }
    return instruments.map((instrument) => this.register(instrument, options));
  }

  list(options = {}) {
    return [...this._byId.values()]
      .filter((instrument) => matchesFilters(instrument, options))
      .map(cloneInstrument);
  }

  has(id) {
    return this._byId.has(upper(id));
  }

  get(id) {
    const instrument = this._byId.get(upper(id));
    return instrument ? cloneInstrument(instrument) : null;
  }

  resolve(value, options = {}) {
    if (value && typeof value === "object") {
      if (value.id || value.instrumentId) {
        const id = upper(value.id || value.instrumentId);
        const known = this.get(id);
        if (known) return known;
        if (!options.allowUnknown) {
          throw new MarketDataError(
            ERROR_CODES.INSTRUMENT_NOT_FOUND,
            `Instrument not found: ${id}`,
            { instrumentId: id },
          );
        }
        const decoded = decodeCanonicalId(id);
        const assetClass = normalizeAssetClass(value.assetClass) || decoded.assetClass;
        if (!assetClass) {
          throw new MarketDataError(
            ERROR_CODES.MAPPING_AMBIGUOUS,
            `Asset class is required to resolve uncatalogued MIC instrument ${id}`,
            { instrumentId: id },
          );
        }
        const instrument = {
          id,
          symbol: decoded.symbol,
          name: cleanText(value.name) || decoded.symbol,
          assetClass,
          status: value.status || "unknown",
          ...(decoded.mic ? { mic: decoded.mic } : {}),
          ...value,
          id,
          symbol: decoded.symbol,
          assetClass,
        };
        validateInstrument(instrument);
        if (encodeCanonicalId(instrument) !== id) {
          throw new MarketDataError(
            ERROR_CODES.MAPPING_AMBIGUOUS,
            `Instrument metadata does not match canonical ID ${id}`,
            { instrumentId: id },
          );
        }
        return instrument;
      }
      if (value.symbol) {
        return this.resolve(value.symbol, { ...options, ...value });
      }
    }

    const lookup = upper(value);
    if (!lookup) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Instrument identifier is required");
    }
    if (isCanonicalInstrumentId(lookup)) {
      const known = this.get(lookup);
      if (known) return known;
      throw new MarketDataError(
        ERROR_CODES.INSTRUMENT_NOT_FOUND,
        `Instrument not found: ${lookup}`,
        { instrumentId: lookup },
      );
    }

    let ids = [...(this._byLookup.get(lookup) || [])];
    if (options.assetClass) {
      ids = ids.filter((id) => this._byId.get(id)?.assetClass === normalizeAssetClass(options.assetClass));
    }
    if (options.mic || options.exchange) {
      const expected = upper(options.mic || options.exchange);
      ids = ids.filter((id) => {
        const instrument = this._byId.get(id);
        return upper(instrument?.mic) === expected || upper(instrument?.exchange) === expected;
      });
    }
    if (ids.length === 1) return this.get(ids[0]);
    if (ids.length > 1) {
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `Instrument mapping is ambiguous: ${lookup}`,
        { details: { query: lookup, candidates: ids } },
      );
    }
    throw new MarketDataError(
      ERROR_CODES.INSTRUMENT_NOT_FOUND,
      `Instrument not found: ${lookup}`,
      { details: { query: lookup } },
    );
  }

  search(query, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 20));
    return this.list(options)
      .map((instrument) => ({
        ...instrument,
        instrumentId: instrument.id,
        curated: true,
        score: rankInstrumentCandidate(instrument, query),
      }))
      .filter((instrument) => instrument.score > 0)
      .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
      .slice(0, limit);
  }

}

