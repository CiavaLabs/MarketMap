export const FIXED_NOW = Date.parse("2026-07-16T20:00:00.000Z");
const VERIFIED_AT = "2026-07-16T12:00:00.000Z";

function yahooMapping(symbol, providerType) {
  return {
    yahoo: {
      symbol,
      verified: true,
      verifiedAt: VERIFIED_AT,
      providerType,
    },
  };
}

export const EQUITY_DESCRIPTOR = Object.freeze({
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
  status: "active",
  providerSymbols: {
    ...yahooMapping("AAPL", "EQUITY"),
    finnhub: { symbol: "AAPL", verified: true, verifiedAt: VERIFIED_AT, providerType: "Common Stock" },
  },
  mappingStatus: "resolved",
});

export const NON_US_EQUITY_DESCRIPTOR = Object.freeze({
  id: "XAMS:ASML",
  displaySymbol: "ASML",
  symbol: "ASML",
  name: "ASML Holding N.V.",
  assetClass: "equity",
  assetSubtype: "common_stock",
  venue: { code: "AMS", name: "Euronext Amsterdam", mic: "XAMS", kind: "exchange" },
  exchange: "Euronext Amsterdam",
  currency: "EUR",
  priceUnit: "currency",
  status: "active",
  providerSymbols: yahooMapping("ASML.AS", "EQUITY"),
  mappingStatus: "resolved",
});

export const ETF_DESCRIPTOR = Object.freeze({
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
  status: "active",
  providerSymbols: yahooMapping("SPY", "ETF"),
  mappingStatus: "resolved",
});

export const BOND_ETF_DESCRIPTOR = Object.freeze({
  id: "XNAS:BND",
  displaySymbol: "BND",
  symbol: "BND",
  name: "Vanguard Total Bond Market ETF",
  assetClass: "etf",
  assetSubtype: "bond_etf",
  venue: { code: "NMS", name: "NasdaqGM", mic: "XNAS", kind: "exchange" },
  exchange: "NasdaqGM",
  currency: "USD",
  priceUnit: "currency",
  status: "active",
  providerSymbols: yahooMapping("BND", "ETF"),
  mappingStatus: "resolved",
});

export const INDEX_DESCRIPTOR = Object.freeze({
  id: "INDEX:^GSPC",
  displaySymbol: "^GSPC",
  symbol: "^GSPC",
  name: "S&P 500 Index",
  assetClass: "index",
  assetSubtype: "market_index",
  venue: { code: "SNP", name: "S&P Dow Jones Indices", mic: null, kind: "index_publisher" },
  exchange: "S&P Dow Jones Indices",
  currency: "USD",
  priceUnit: "index_points",
  status: "active",
  providerSymbols: yahooMapping("^GSPC", "INDEX"),
  mappingStatus: "resolved",
});

export const FX_DESCRIPTOR = Object.freeze({
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
  status: "active",
  providerSymbols: yahooMapping("EURUSD=X", "CURRENCY"),
  mappingStatus: "resolved",
});

export const CRYPTO_DESCRIPTOR = Object.freeze({
  id: "CRYPTO:BTC-USD",
  displaySymbol: "BTC/USD",
  symbol: "BTC-USD",
  name: "Bitcoin / US Dollar",
  assetClass: "crypto",
  assetSubtype: "spot_pair",
  venue: { code: "CCC", name: "CoinMarketCap Aggregate", mic: null, kind: "crypto_network" },
  exchange: "CoinMarketCap Aggregate",
  currency: "USD",
  quoteCurrency: "USD",
  baseCurrency: "BTC",
  priceUnit: "currency",
  status: "active",
  providerSymbols: yahooMapping("BTC-USD", "CRYPTOCURRENCY"),
  mappingStatus: "resolved",
});

export const FUTURE_DESCRIPTOR = Object.freeze({
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
  status: "active",
  providerSymbols: yahooMapping("GC=F", "FUTURE"),
  mappingStatus: "resolved",
});

export const RATE_DESCRIPTOR = Object.freeze({
  id: "RATE:^TNX",
  displaySymbol: "US10Y",
  symbol: "^TNX",
  name: "CBOE 10 Year Treasury Note Yield",
  assetClass: "rate_index",
  assetSubtype: "yield_index",
  venue: { code: "CBOE", name: "Cboe Global Indices", mic: null, kind: "index_publisher" },
  exchange: "CBOE",
  currency: "USD",
  priceUnit: "percent_yield",
  status: "active",
  providerSymbols: yahooMapping("^TNX", "INDEX"),
  mappingStatus: "resolved",
});

export const PROVISIONAL_DESCRIPTOR = Object.freeze({
  id: "XNAS:SPYM",
  displaySymbol: "SPYM",
  symbol: "SPYM",
  name: "SPDR Portfolio S&P 500 ETF",
  assetClass: "etf",
  assetSubtype: "unknown",
  venue: { code: "NMS", name: "NasdaqGM", mic: "XNAS", kind: "exchange" },
  exchange: "NasdaqGM",
  currency: "USD",
  priceUnit: "currency",
  status: "unknown",
  providerSymbols: {
    yahoo: { symbol: "SPYM", verified: false, providerType: "EQUITY" },
  },
  mappingStatus: "provisional",
});

export const ALL_DESCRIPTORS = Object.freeze([
  EQUITY_DESCRIPTOR,
  NON_US_EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  BOND_ETF_DESCRIPTOR,
  INDEX_DESCRIPTOR,
  FX_DESCRIPTOR,
  CRYPTO_DESCRIPTOR,
  FUTURE_DESCRIPTOR,
  RATE_DESCRIPTOR,
  PROVISIONAL_DESCRIPTOR,
]);
