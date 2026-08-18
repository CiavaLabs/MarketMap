import {
  BOND_ETF_DESCRIPTOR,
  CRYPTO_DESCRIPTOR,
  EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  FUTURE_DESCRIPTOR,
  FX_DESCRIPTOR,
  INDEX_DESCRIPTOR,
  RATE_DESCRIPTOR,
} from "./descriptors.js";

const AS_OF = "2026-07-16T20:00:00.000Z";
const FETCHED_AT = "2026-07-16T20:00:05.000Z";

function details(instrument, kind, sections, provenance) {
  return {
    instrument,
    kind,
    sections,
    metrics: [],
    quality: "fresh",
    provenance,
    asOf: AS_OF,
    fetchedAt: FETCHED_AT,
  };
}

export const COMPANY_DETAILS = Object.freeze(details(
  EQUITY_DESCRIPTOR,
  "company",
  [
    {
      id: "company_profile",
      status: "available",
      fields: {
        sector: "Technology",
        industry: "Consumer Electronics",
        country: "United States",
        website: "https://www.apple.com",
        employees: 164_000,
      },
      fieldAvailability: {},
    },
    {
      id: "equity_fundamentals",
      status: "available",
      fields: {
        marketCap: 4_920_000_000_000,
        trailingPe: 34.2,
        epsTtm: 9.28,
        beta: null,
      },
      fieldAvailability: {
        beta: { status: "temporarily_unavailable" },
      },
    },
    {
      id: "analyst_outlook",
      status: "available",
      fields: {
        recommendation: "buy",
        targetMeanPrice: 342.5,
        numberOfAnalysts: 41,
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "AAPL", fallback: false },
));

export const FUND_DETAILS = Object.freeze(details(
  ETF_DESCRIPTOR,
  "fund",
  [
    {
      id: "fund_profile",
      status: "available",
      fields: {
        family: "SPDR State Street Global Advisors",
        category: "Large Blend",
        legalType: "Exchange Traded Fund",
        expenseRatio: 0.0945,
      },
      fieldAvailability: {},
    },
    {
      id: "fund_composition",
      status: "available",
      fields: {
        topHoldings: "NVDA, MSFT, AAPL, AMZN, META",
        equityAllocation: 99.6,
      },
      fieldAvailability: {},
    },
    {
      id: "fund_stats",
      status: "available",
      fields: {
        totalAssets: 641_000_000_000,
        yield: 1.21,
        nav: null,
      },
      fieldAvailability: {
        nav: { status: "temporarily_unavailable" },
      },
    },
  ],
  { source: "yahoo", providerSymbol: "SPY", fallback: false },
));

export const BOND_FUND_DETAILS = Object.freeze(details(
  BOND_ETF_DESCRIPTOR,
  "fund",
  [
    {
      id: "fund_profile",
      status: "available",
      fields: {
        family: "Vanguard",
        category: "Intermediate Core Bond",
        legalType: "Exchange Traded Fund",
        expenseRatio: 0.03,
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "BND", fallback: false },
));

export const INDEX_DETAILS = Object.freeze(details(
  INDEX_DESCRIPTOR,
  "index",
  [
    {
      id: "index_metadata",
      status: "available",
      fields: {
        publisher: "S&P Dow Jones Indices",
        constituents: 503,
        launchDate: null,
      },
      fieldAvailability: {
        launchDate: { status: "unsupported", reason: "provider_does_not_expose" },
      },
    },
    {
      id: "market_stats",
      status: "available",
      fields: {
        fiftyTwoWeekHigh: 6_402.11,
        fiftyTwoWeekLow: 4_953.56,
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "^GSPC", fallback: false },
));

export const PAIR_DETAILS = Object.freeze(details(
  FX_DESCRIPTOR,
  "currency_pair",
  [
    {
      id: "pair_metadata",
      status: "available",
      fields: {
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        sessionModel: "24x5",
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "EURUSD=X", fallback: false },
));

export const CRYPTO_DETAILS = Object.freeze(details(
  CRYPTO_DESCRIPTOR,
  "crypto_asset",
  [
    {
      id: "crypto_metadata",
      status: "available",
      fields: {
        baseAsset: "BTC",
        quoteCurrency: "USD",
        network: null,
      },
      fieldAvailability: {
        network: { status: "unsupported", reason: "provider_does_not_expose" },
      },
    },
    {
      id: "crypto_market_stats",
      status: "available",
      fields: {
        marketCap: 2_340_000_000_000,
        circulatingSupply: 19_780_000,
        volume24h: 48_221_004_800,
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "BTC-USD", fallback: false },
));

export const FUTURE_DETAILS = Object.freeze(details(
  FUTURE_DESCRIPTOR,
  "future_contract",
  [
    {
      id: "future_contract",
      status: "available",
      fields: {
        activeContract: "GCQ26.CMX",
        expirationDate: "2026-08-27T00:00:00.000Z",
        underlying: "Gold",
        openInterest: null,
      },
      fieldAvailability: {
        openInterest: { status: "temporarily_unavailable" },
      },
    },
    {
      id: "future_market_stats",
      status: "available",
      fields: {
        settlementPrice: 3_365.0,
        dayRangeLow: 3_344.1,
        dayRangeHigh: 3_371.8,
      },
      fieldAvailability: {},
    },
    {
      id: "rollover_notice",
      status: "available",
      fields: {
        continuity: "provider_continuous_front",
        comparableAcrossRollover: false,
      },
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "GC=F", fallback: false },
));

export const RATE_DETAILS = Object.freeze(details(
  RATE_DESCRIPTOR,
  "rate_index",
  [
    {
      id: "index_metadata",
      status: "available",
      fields: {
        publisher: "Cboe Global Indices",
        underlying: "10-Year US Treasury Note",
        priceUnit: "percent_yield",
      },
      fieldAvailability: {},
    },
    {
      id: "market_stats",
      status: "not_applicable",
      fields: {},
      fieldAvailability: {},
    },
  ],
  { source: "yahoo", providerSymbol: "^TNX", fallback: false },
));

export const ALL_DETAILS = Object.freeze([
  COMPANY_DETAILS,
  FUND_DETAILS,
  BOND_FUND_DETAILS,
  INDEX_DETAILS,
  PAIR_DETAILS,
  CRYPTO_DETAILS,
  FUTURE_DETAILS,
  RATE_DETAILS,
]);
