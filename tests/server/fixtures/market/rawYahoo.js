export const RAW_QUOTE_SPY = Object.freeze({
  symbol: "SPY",
  quoteType: "ETF",
  fullExchangeName: "NYSEArca",
  exchange: "PCX",
  currency: "USD",
  regularMarketPrice: 628.42,
  regularMarketChange: 3.11,
  regularMarketChangePercent: 0.5,
  regularMarketVolume: 55_120_030,
  averageDailyVolume3Month: 71_002_411,
  marketState: "POST",
  exchangeTimezoneName: "America/New_York",
});

export const RAW_SEARCH_SPYM = Object.freeze({
  symbol: "SPYM",
  quoteType: "EQUITY",
  exchange: "NGM",
  exchDisp: "NASDAQ",
  shortname: "SPDR Portfolio S&P 500 ETF",
  score: 92,
  index: "quotes",
});

export const RAW_QUOTE_SPYM = Object.freeze({
  symbol: "SPYM",
  quoteType: "ETF",
  fullExchangeName: "NasdaqGM",
  exchange: "NGM",
  currency: "USD",
  regularMarketPrice: 74.11,
  marketState: "POST",
});

export const RAW_QUOTE_EURUSD = Object.freeze({
  symbol: "EURUSD=X",
  quoteType: "CURRENCY",
  fullExchangeName: "CCY",
  exchange: "CCY",
  currency: "USD",
  regularMarketPrice: 1.0842,
  regularMarketChange: -0.0031,
  regularMarketChangePercent: -0.29,
  regularMarketVolume: 0,
  averageDailyVolume3Month: 0,
  bid: 1.0841,
  ask: 1.0843,
  marketState: "REGULAR",
  exchangeTimezoneName: "Europe/London",
});

export const RAW_QUOTE_GSPC = Object.freeze({
  symbol: "^GSPC",
  quoteType: "INDEX",
  fullExchangeName: "SNP",
  exchange: "SNP",
  currency: "USD",
  regularMarketPrice: 6_318.72,
  regularMarketVolume: 2_501_774_000,
  marketState: "REGULAR",
  exchangeTimezoneName: "America/New_York",
});

export const RAW_QUOTE_TNX = Object.freeze({
  symbol: "^TNX",
  quoteType: "INDEX",
  fullExchangeName: "Cboe Indices",
  exchange: "CGI",
  currency: "USD",
  regularMarketPrice: 4.545,
  regularMarketChange: -0.04,
  regularMarketVolume: 0,
  averageDailyVolume3Month: 0,
  marketState: "PRE",
  exchangeTimezoneName: "America/Chicago",
});

export const RAW_QUOTE_BTC = Object.freeze({
  symbol: "BTC-USD",
  quoteType: "CRYPTOCURRENCY",
  fullExchangeName: "CCC",
  exchange: "CCC",
  currency: "USD",
  fromCurrency: "BTC",
  regularMarketPrice: 118_412.55,
  regularMarketVolume: 48_221_004_800,
  volume24Hr: 48_221_004_800,
  circulatingSupply: 19_780_000,
  marketState: "REGULAR",
  exchangeTimezoneName: "UTC",
});

export const RAW_QUOTE_GC = Object.freeze({
  symbol: "GC=F",
  quoteType: "FUTURE",
  fullExchangeName: "COMEX",
  exchange: "CMX",
  currency: "USD",
  regularMarketPrice: 3_352.4,
  regularMarketVolume: 178_204,
  expireDate: new Date("2026-08-27T00:00:00.000Z"),
  underlyingSymbol: "GCQ26.CMX",
  headSymbolAsString: "GC=F",
  marketState: "REGULAR",
  exchangeTimezoneName: "America/New_York",
});

export const RAW_SEARCH_UNKNOWN_VENUE = Object.freeze({
  symbol: "OMV.VI",
  quoteType: "EQUITY",
  exchange: "VIE",
  exchDisp: "Vienna",
  shortname: "OMV AG",
  score: 71,
  index: "quotes",
});

export const RAW_QUOTE_KEYSETS = Object.freeze({
  ETF: Object.freeze(Object.keys(RAW_QUOTE_SPY)),
  CURRENCY: Object.freeze(Object.keys(RAW_QUOTE_EURUSD)),
  INDEX: Object.freeze(Object.keys(RAW_QUOTE_GSPC)),
  CRYPTOCURRENCY: Object.freeze(Object.keys(RAW_QUOTE_BTC)),
  FUTURE: Object.freeze(Object.keys(RAW_QUOTE_GC)),
});
