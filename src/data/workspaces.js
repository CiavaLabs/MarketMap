import { canonicalUsEquitySector } from "../../shared/sectorTaxonomy.js";

function equity(mic, symbol, name, sector) {
  const id = `${mic}:${symbol}`;
  return Object.freeze({
    id,
    symbol,
    name,
    assetClass: "equity",
    exchange: mic === "XNAS" ? "NASDAQ" : "NYSE",
    mic,
    currency: "USD",
    country: "US",
    sector: canonicalUsEquitySector(id) || sector,
    status: "active",
  });
}

function etf(mic, symbol, name, category) {
  return Object.freeze({
    id: `${mic}:${symbol}`,
    symbol,
    name,
    assetClass: "etf",
    exchange: mic === "XNAS" ? "NASDAQ" : "NYSE Arca",
    mic,
    currency: "USD",
    country: "US",
    category,
    status: "active",
  });
}

function fixed(assetClass, namespace, symbol, name, extra = {}) {
  return Object.freeze({
    id: `${namespace}:${symbol}`,
    symbol,
    name,
    assetClass,
    status: "active",
    ...extra,
  });
}

const index = (symbol, name, country) => fixed("index", "INDEX", symbol, name, { country });
const fx = (symbol, name) => fixed("fx", "FX", symbol, name);
const crypto = (symbol, name) => fixed("crypto", "CRYPTO", symbol, name, { currency: "USD" });
const rate = (symbol, name, country) => fixed("rate_index", "RATE", symbol, name, { country });

const future = (id, symbol, name, exchange, mic) => Object.freeze({
  id, symbol, name, assetClass: "commodity_future", exchange, mic, currency: "USD", status: "active",
});

export const STARTER_INSTRUMENTS = Object.freeze([
  equity("XNAS", "AAPL", "Apple Inc.", "Technology"),
  etf("ARCX", "SPY", "SPDR S&P 500 ETF Trust", "Large Blend"),
  equity("XNAS", "MSFT", "Microsoft Corporation", "Technology"),
  index("^GSPC", "S&P 500 Index", "US"),
  equity("XNAS", "NVDA", "NVIDIA Corporation", "Technology"),
  crypto("BTC-USD", "Bitcoin / US Dollar"),
  equity("XNAS", "GOOGL", "Alphabet Inc. Class A", "Communication Services"),
  fx("EURUSD", "EUR/USD"),
  equity("XNAS", "AMZN", "Amazon.com, Inc.", "Consumer Discretionary"),
  etf("XNAS", "QQQ", "Invesco QQQ Trust", "Large Growth"),
  equity("XNAS", "META", "Meta Platforms, Inc.", "Communication Services"),
  rate("^TNX", "CBOE 10 Year Treasury Note Yield", "US"),
  equity("XNAS", "TSLA", "Tesla, Inc.", "Consumer Discretionary"),
  future("FUTURE:CMX.GC.CONTINUOUS.1", "GC=F", "Gold Futures (continuous front)", "COMEX", "XCEC"),
  equity("XNAS", "AVGO", "Broadcom Inc.", "Technology"),
  index("^VIX", "CBOE Volatility Index", "US"),
  equity("XNYS", "JPM", "JPMorgan Chase & Co.", "Financials"),
  fx("USDJPY", "USD/JPY"),
  equity("XNYS", "V", "Visa Inc.", "Financials"),
  etf("XNAS", "TLT", "iShares 20+ Year Treasury Bond ETF", "Long Government"),
  equity("XNYS", "UNH", "UnitedHealth Group Incorporated", "Health Care"),
  crypto("ETH-USD", "Ethereum / US Dollar"),
  equity("XNYS", "JNJ", "Johnson & Johnson", "Health Care"),
  index("DX-Y.NYB", "US Dollar Index", "US"),
  equity("XNAS", "COST", "Costco Wholesale Corporation", "Consumer Staples"),
  equity("XNAS", "NFLX", "Netflix, Inc.", "Communication Services"),
  equity("XNAS", "AMD", "Advanced Micro Devices, Inc.", "Technology"),
  equity("XNAS", "WMT", "Walmart Inc.", "Consumer Staples"),
  equity("XNYS", "XOM", "Exxon Mobil Corporation", "Energy"),
  equity("XNYS", "HD", "The Home Depot, Inc.", "Consumer Discretionary"),
  equity("XNYS", "KO", "The Coca-Cola Company", "Consumer Staples"),
  equity("XNYS", "ORCL", "Oracle Corporation", "Technology"),
  equity("XNYS", "CRM", "Salesforce, Inc.", "Technology"),
  equity("XNAS", "ADBE", "Adobe Inc.", "Technology"),
  equity("XNYS", "BAC", "Bank of America Corporation", "Financials"),
  equity("XNYS", "LLY", "Eli Lilly and Company", "Health Care"),
  equity("XNYS", "ABBV", "AbbVie Inc.", "Health Care"),
  equity("XNYS", "PG", "The Procter & Gamble Company", "Consumer Staples"),
  equity("XNYS", "CAT", "Caterpillar Inc.", "Industrials"),
  equity("XNYS", "GE", "GE Aerospace", "Industrials"),
]);

export const STARTER_WORKSPACE = Object.freeze({
  id: "us-equities",
  name: "Markets",
  description: "A cross-asset starter board: US equities beside funds, indices, FX, rates and crypto.",
  groupBy: "assetClass",
  weighting: "equal",
  instruments: STARTER_INSTRUMENTS,
  instrumentIds: Object.freeze(STARTER_INSTRUMENTS.map(({ id }) => id)),
});

export const DEFAULT_WORKSPACE_ID = STARTER_WORKSPACE.id;
export const WORKSPACES = Object.freeze([STARTER_WORKSPACE]);

const workspaceLookup = new Map(WORKSPACES.map((workspace) => [workspace.id, workspace]));

export function getWorkspace(workspaceId = DEFAULT_WORKSPACE_ID) {
  return workspaceLookup.get(workspaceId) || null;
}
