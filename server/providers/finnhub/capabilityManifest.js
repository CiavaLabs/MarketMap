import { validateProviderCapabilityManifest } from "../../contracts/market/capabilities.js";

const UNSUPPORTED = Object.freeze({ support: "unsupported" });
const NO_COVERAGE = Object.freeze({
  search: UNSUPPORTED,
  quote: UNSUPPORTED,
  history: UNSUPPORTED,
  details: UNSUPPORTED,
  news: UNSUPPORTED,
});

export const FINNHUB_CAPABILITY_MANIFEST = Object.freeze({
  provider: "finnhub",
  manifestVersion: 1,
  assets: {
    equity: {
      search: UNSUPPORTED,
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
          session: "unsupported",
        },
        fallback: { semanticMatch: "raw_quote" },
      },
      history: UNSUPPORTED,
      details: UNSUPPORTED,
      news: {
        support: "partial",
        fallback: { semanticMatch: "equity_news" },
      },
    },
    etf: NO_COVERAGE,
    index: NO_COVERAGE,
    fx: NO_COVERAGE,
    crypto: NO_COVERAGE,
    commodity_future: NO_COVERAGE,
    rate_index: NO_COVERAGE,
  },
});

validateProviderCapabilityManifest(FINNHUB_CAPABILITY_MANIFEST);
