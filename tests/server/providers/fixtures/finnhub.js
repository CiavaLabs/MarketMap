export const FINNHUB_AAPL_QUOTE = Object.freeze({
  c: 317.31,
  d: 1.99,
  dp: 0.6311,
  h: 323.45,
  l: 315.78,
  o: 317.01,
  pc: 315.32,
  t: 1_784_061_540,
});

export const FINNHUB_NO_DATA_QUOTE = Object.freeze({
  c: 0,
  d: null,
  dp: null,
  h: 0,
  l: 0,
  o: 0,
  pc: 0,
  t: 0,
});

export const FINNHUB_AUTH_ERROR = Object.freeze({
  error: "Invalid API key",
});

export const FINNHUB_ENTITLEMENT_ERROR = Object.freeze({
  error: "Premium endpoint access required",
});

export const FINNHUB_UPSTREAM_ERROR = Object.freeze({
  error: "Internal upstream service unavailable",
});

export const FINNHUB_SEARCH_RESULTS = Object.freeze({
  count: 2,
  result: [
    {
      description: "APPLE INC",
      displaySymbol: "AAPL",
      symbol: "AAPL",
      type: "Common Stock",
    },
    {
      description: "APPLE INC",
      displaySymbol: "AAPL",
      symbol: "AAPL",
      type: "Common Stock",
    },
  ],
});

export const FINNHUB_AAPL_NEWS = Object.freeze([
  {
    category: "company",
    datetime: Date.parse("2026-07-13T19:45:00.000Z") / 1_000,
    headline: "  Apple &amp; suppliers report <em>growth</em> ",
    id: 9001,
    image: "https://images.example.test/ignored.jpg",
    related: "AAPL",
    source: " Reuters ",
    summary: "This field must not cross the provider boundary.",
    url: "https://news.example.test/apple-growth#story",
  },
  {
    datetime: Date.parse("2026-07-13T18:45:00.000Z") / 1_000,
    headline: "Duplicate URL",
    id: 9002,
    source: "Reuters",
    url: "https://news.example.test/apple-growth#duplicate",
  },
  {
    datetime: Date.parse("2026-07-11T12:00:00.000Z") / 1_000,
    headline: "Apple services expand",
    id: 9003,
    source: "Dow Jones",
    url: "https://news.example.test/apple-services",
  },
  {
    datetime: Date.parse("2026-07-05T12:00:00.000Z") / 1_000,
    headline: "Old coverage",
    id: 9004,
    source: "Archive",
    url: "https://news.example.test/old-finnhub",
  },
  {
    datetime: Date.parse("2026-07-13T16:00:00.000Z") / 1_000,
    headline: "Unsafe URL",
    id: 9005,
    source: "Publisher",
    url: "http://news.example.test/unsafe",
  },
]);

export const FINNHUB_AAPL_HISTORY = Object.freeze({
  s: "ok",
  t: [1_784_041_400, 1_784_041_700],
  o: [315.8, 316.9],
  h: [317.2, 318.1],
  l: [315.5, 316.7],
  c: [316.9, 317.7],
  v: [1_100_000, 850_000],
});

export const FINNHUB_AAPL_PROFILE = Object.freeze({
  country: "US",
  currency: "USD",
  exchange: "NASDAQ NMS - GLOBAL MARKET",
  ipo: "1980-12-12",
  logo: "https://static.example.test/apple.svg",
  marketCapitalization: 4_740_000,
  name: "Apple Inc",
  phone: "14089961010",
  shareOutstanding: 14_950,
  ticker: "AAPL",
  weburl: "https://www.apple.com/",
  finnhubIndustry: "Technology",
});

export const FINNHUB_AAPL_FUNDAMENTALS = Object.freeze({
  metric: {
    marketCapitalization: 4_740_000,
    peBasicExclExtraTTM: 33.4,
    peAnnual: 31.8,
    pbQuarterly: 52.1,
    psTTM: 11.4,
    epsTTM: 9.5,
    epsAnnual: 8.9,
    beta: 1.2,
    "52WeekHigh": 323.45,
    "52WeekLow": 195.1,
    dividendYieldIndicatedAnnual: 0.49,
    revenueGrowthTTMYoy: 6.1,
    netProfitMarginTTM: 26.4,
    roeTTM: 171,
    "totalDebt/totalEquityQuarterly": 152.4,
    currentRatioQuarterly: 0.89,
    freeCashFlowPerShareTTM: 7.49,
    bookValuePerShareQuarterly: 6.09,
    "3MonthAverageTradingVolume": 54.68,
  },
  metricType: "all",
  series: {},
});
