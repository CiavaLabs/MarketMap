import { validateProviderCapabilityManifest } from "../../contracts/market/capabilities.js";

const EXCHANGE_QUOTE_FIELDS = Object.freeze({
  price: "supported",
  change: "supported",
  open: "supported",
  previousClose: "supported",
  dayRange: "supported",
  bidAsk: "partial",
  volume: "supported",
  averageVolume: "supported",
  session: "supported",
});

const ADJUSTABLE_HISTORY = Object.freeze({
  support: "supported",
  priceBases: Object.freeze(["raw", "provider_adjusted"]),
  intervals: Object.freeze(["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"]),
  corporateActions: true,
});

const RAW_HISTORY = Object.freeze({
  support: "supported",
  priceBases: Object.freeze(["raw"]),
  intervals: Object.freeze(["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"]),
  corporateActions: false,
});

export const YAHOO_CAPABILITY_MANIFEST = Object.freeze({
  provider: "yahoo",
  manifestVersion: 1,
  assets: {
    equity: {
      search: { support: "supported" },
      quote: { support: "supported", fields: EXCHANGE_QUOTE_FIELDS },
      history: ADJUSTABLE_HISTORY,
      details: {
        support: "supported",
        sections: ["company_profile", "equity_fundamentals", "analyst_outlook"],
      },
      news: { support: "supported" },
    },
    etf: {
      search: { support: "supported" },
      quote: { support: "supported", fields: EXCHANGE_QUOTE_FIELDS },
      history: ADJUSTABLE_HISTORY,
      details: {
        support: "partial",
        sections: ["fund_profile", "fund_composition", "fund_stats"],
      },
      news: { support: "unsupported" },
    },
    index: {
      search: { support: "supported" },
      quote: {
        support: "supported",
        fields: {
          price: "supported",
          change: "supported",
          open: "supported",
          previousClose: "supported",
          dayRange: "supported",
          bidAsk: "unsupported",
          volume: "partial",
          averageVolume: "partial",
          session: "supported",
        },
      },
      history: RAW_HISTORY,
      details: { support: "partial", sections: ["index_metadata", "market_stats"] },
      news: { support: "unsupported" },
    },
    fx: {
      search: { support: "supported" },
      quote: {
        support: "supported",
        fields: {
          price: "supported",
          change: "supported",
          open: "supported",
          previousClose: "supported",
          dayRange: "supported",
          bidAsk: "partial",
          volume: "unsupported",
          averageVolume: "unsupported",
          session: "supported",
        },
      },
      history: RAW_HISTORY,
      details: { support: "partial", sections: ["pair_metadata"] },
      news: { support: "unsupported" },
    },
    crypto: {
      search: { support: "supported" },
      quote: {
        support: "supported",
        fields: {
          price: "supported",
          change: "supported",
          open: "supported",
          previousClose: "supported",
          dayRange: "supported",
          bidAsk: "partial",
          volume: "supported",
          averageVolume: "partial",
          session: "supported",
        },
      },
      history: RAW_HISTORY,
      details: { support: "partial", sections: ["crypto_metadata", "crypto_market_stats"] },
      news: { support: "unsupported" },
    },
    commodity_future: {
      search: { support: "supported" },
      quote: {
        support: "supported",
        fields: {
          price: "supported",
          change: "supported",
          open: "supported",
          previousClose: "supported",
          dayRange: "supported",
          bidAsk: "partial",
          volume: "supported",
          averageVolume: "partial",
          session: "supported",
        },
      },
      history: RAW_HISTORY,
      details: {
        support: "partial",
        sections: ["future_contract", "future_market_stats", "rollover_notice"],
      },
      news: { support: "unsupported" },
    },
    rate_index: {
      search: { support: "supported" },
      quote: {
        support: "supported",
        fields: {
          price: "supported",
          change: "supported",
          open: "supported",
          previousClose: "supported",
          dayRange: "supported",
          bidAsk: "unsupported",
          volume: "unsupported",
          averageVolume: "unsupported",
          session: "supported",
        },
      },
      history: RAW_HISTORY,
      details: { support: "partial", sections: ["index_metadata", "market_stats"] },
      news: { support: "unsupported" },
    },
  },
});

validateProviderCapabilityManifest(YAHOO_CAPABILITY_MANIFEST);
