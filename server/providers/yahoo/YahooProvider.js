import { YahooClient } from "./yahooClient.js";

import { ERROR_CODES } from "../../contracts/core/constants.js";
import { NEWS_PROVIDER_LIMIT } from "../../contracts/core/news.js";
import {
  HISTORY_DEFAULT_INTERVALS,
  historyStartDate,
  isHistoryRangeIntervalSupported,
} from "../../contracts/core/history.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import {
  ProviderAdapter,
  normalizeProviderError,
} from "../ProviderAdapter.js";
import {
  clockTimestamp,
  normalizeYahooNews,
} from "./normalizers.js";
import {
  normalizeYahooDetails,
  normalizeYahooHistory,
  normalizeYahooQuote,
} from "./marketNormalizers.js";
import {
  normalizeChartUnits,
  normalizeQuoteMapUnits,
  normalizeQuoteSummaryUnits,
} from "./minorUnits.js";
import { yahooDetailsModulesFor } from "./detailsModules.js";

const YAHOO_ASSET_CLASSES = Object.freeze([
  "equity",
  "etf",
  "index",
  "fx",
  "crypto",
  "commodity_future",
  "rate_index",
]);

const HISTORY_INTERVALS = Object.freeze(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"]);

const DISCOVERY_QUOTE_TYPES = new Set([
  "EQUITY",
  "ETF",
  "INDEX",
  "CURRENCY",
  "CRYPTOCURRENCY",
  "FUTURE",
  "BOND",
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (value.symbol || value.regularMarketPrice !== undefined) return [value];
  return Object.values(value).filter((entry) => entry && typeof entry === "object");
}

function dateFrom(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export class YahooProvider extends ProviderAdapter {
  constructor({
    client = new YahooClient(),
    clock = Date.now,
  } = {}) {
    super({
      id: "yahoo",
      capabilities: {
        quote: { assetClasses: YAHOO_ASSET_CLASSES },
        search: { assetClasses: YAHOO_ASSET_CLASSES },
        history: { assetClasses: YAHOO_ASSET_CLASSES, intervals: HISTORY_INTERVALS },
        details: { assetClasses: YAHOO_ASSET_CLASSES },
        news: { assetClasses: YAHOO_ASSET_CLASSES },
      },
    });
    if (!client || typeof client !== "object") throw new TypeError("YahooProvider requires a client object");
    this.client = client;
    this.clock = clock;
  }

  async discoverInstruments(query, options = {}) {
    this.assertCapability("search");
    const normalizedQuery = `${query || ""}`.trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 80) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Yahoo search query must contain 2 to 80 characters", {
        provider: this.id,
        capability: "search",
      });
    }
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 20));
    let payload;
    try {
      payload = await this.client.search(
        normalizedQuery,
        { quotesCount: limit, newsCount: 0 },
        { fetchOptions: { signal: options.signal } },
      );
    } catch (error) {
      throw normalizeProviderError(error, { provider: this.id, capability: "search" });
    }

    const seen = new Set();
    const discoveries = [];
    for (const row of payload?.quotes || []) {
      if (!row || typeof row !== "object" || row.isYahooFinance === false) continue;
      const providerSymbol = `${row.symbol || ""}`.trim().toUpperCase();
      const quoteType = `${row.quoteType || ""}`.trim().toUpperCase();
      if (!providerSymbol || !DISCOVERY_QUOTE_TYPES.has(quoteType)) continue;
      const key = `${this.id}:${providerSymbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      discoveries.push({
        provider: this.id,
        providerSymbol,
        quoteType,
        exchangeCode: `${row.exchange || ""}`.trim().toUpperCase() || null,
        exchangeName: `${row.exchDisp || ""}`.trim() || null,
        name: `${row.longname || row.shortname || providerSymbol}`.trim(),
        score: Number(row.score) || 0,
        mappingStatus: "provisional",
      });
    }
    return discoveries;
  }

  async hydrateQuotes(providerSymbols, options = {}) {
    this.assertCapability("quote");
    const symbols = [...new Set((providerSymbols || [])
      .map((symbol) => `${symbol || ""}`.trim().toUpperCase())
      .filter(Boolean))];
    if (!symbols.length) return new Map();
    let payload;
    try {
      payload = await this.client.quote(
        symbols,
        {},
        { fetchOptions: { signal: options.signal } },
      );
    } catch (error) {
      throw normalizeProviderError(error, { provider: this.id, capability: "quote" });
    }
    return normalizeQuoteMapUnits(new Map(asArray(payload)
      .filter((quote) => quote && typeof quote === "object")
      .map((quote) => [`${quote.symbol || ""}`.toUpperCase(), quote])));
  }

  async quoteMany(descriptors, options = {}) {
    if (!Array.isArray(descriptors)) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Yahoo quoteMany expects an array", {
        provider: this.id,
        capability: "quote",
        retryable: false,
      });
    }
    const errors = [];
    const bySymbol = new Map();
    for (const descriptor of descriptors) {
      const mapping = descriptor?.providerSymbols?.yahoo;
      const providerSymbol = `${mapping?.symbol || ""}`.trim().toUpperCase();
      if (!descriptor?.id || !providerSymbol || mapping?.verified !== true) {
        errors.push(new MarketDataError(
          ERROR_CODES.MAPPING_AMBIGUOUS,
          `No verified Yahoo quote mapping for ${descriptor?.id || "instrument"}`,
          {
            provider: this.id,
            capability: "quote",
            instrumentId: descriptor?.id || null,
            retryable: false,
          },
        ));
        continue;
      }
      bySymbol.set(providerSymbol, descriptor);
    }
    if (!bySymbol.size) return { data: [], errors };

    let hydrated;
    try {
      hydrated = await this.hydrateQuotes([...bySymbol.keys()], options);
    } catch (error) {
      for (const descriptor of bySymbol.values()) {
        errors.push(normalizeProviderError(error, {
          provider: this.id,
          capability: "quote",
          instrumentId: descriptor.id,
        }));
      }
      return { data: [], errors };
    }

    const data = [];
    for (const [providerSymbol, descriptor] of bySymbol) {
      const raw = hydrated.get(providerSymbol);
      if (!raw) {
        errors.push(new MarketDataError(
          ERROR_CODES.INSTRUMENT_NOT_FOUND,
          `Yahoo returned no quote for ${descriptor.id}`,
          {
            provider: this.id,
            capability: "quote",
            instrumentId: descriptor.id,
            retryable: false,
          },
        ));
        continue;
      }
      try {
        data.push(normalizeYahooQuote(raw, { descriptor, clock: this.clock }));
      } catch (error) {
        errors.push(normalizeProviderError(error, {
          provider: this.id,
          capability: "quote",
          instrumentId: descriptor.id,
        }));
      }
    }
    return { data, errors };
  }

  async history(descriptor, options = {}) {
    const mapping = descriptor?.providerSymbols?.yahoo;
    const providerSymbol = `${mapping?.symbol || ""}`.trim().toUpperCase();
    if (!descriptor?.id || !providerSymbol || mapping?.verified !== true) {
      throw new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, `No verified Yahoo history mapping for ${descriptor?.id || "instrument"}`, {
        provider: this.id,
        capability: "history",
        instrumentId: descriptor?.id || null,
        retryable: false,
      });
    }
    const range = options.range || "1d";
    const interval = options.interval || HISTORY_DEFAULT_INTERVALS[range] || "5m";
    if (!HISTORY_INTERVALS.includes(interval) || !isHistoryRangeIntervalSupported(range, interval)) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, `Unsupported Yahoo history range/interval: ${range}/${interval}`, {
        provider: this.id,
        capability: "history",
        instrumentId: descriptor.id,
        retryable: false,
        details: { range, interval },
      });
    }
    const now = new Date(clockTimestamp(this.clock));
    const period2 = dateFrom(options.period2 ?? options.to, now);
    const period1 = dateFrom(
      options.period1 ?? options.from,
      period2 ? historyStartDate(range, period2) : null,
    );
    if (!period1 || !period2 || period1.getTime() >= period2.getTime()) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Yahoo history period must contain valid ascending dates", {
        provider: this.id,
        capability: "history",
        instrumentId: descriptor.id,
        retryable: false,
        details: { range, interval },
      });
    }

    try {
      const [payload, futureQuotes] = await Promise.all([
        this.client.chart(
          providerSymbol,
          {
            period1,
            period2,
            interval,
            includePrePost: options.includePrePost ?? false,
            events: "div|split",
          },
          { fetchOptions: { signal: options.signal } },
        ),
        descriptor.assetClass === "commodity_future"
          ? this.hydrateQuotes([providerSymbol], { signal: options.signal })
          : Promise.resolve(null),
      ]);
      return normalizeYahooHistory(normalizeChartUnits(payload), {
        descriptor,
        range,
        interval,
        priceBasis: options.priceBasis || "raw",
        invalidRowThreshold: options.invalidRowThreshold,
        futureQuote: futureQuotes?.get(providerSymbol) || null,
        clock: this.clock,
      });
    } catch (error) {
      throw normalizeProviderError(error, {
        provider: this.id,
        capability: "history",
        instrumentId: descriptor.id,
      });
    }
  }

  async details(descriptor, options = {}) {
    const mapping = descriptor?.providerSymbols?.yahoo;
    const providerSymbol = `${mapping?.symbol || ""}`.trim().toUpperCase();
    if (!descriptor?.id || !providerSymbol || mapping?.verified !== true) {
      throw new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, `No verified Yahoo details mapping for ${descriptor?.id || "instrument"}`, {
        provider: this.id,
        capability: "details",
        instrumentId: descriptor?.id || null,
        retryable: false,
      });
    }
    const modules = yahooDetailsModulesFor(descriptor.assetClass);
    if (!modules.length) {
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, `Yahoo details are unsupported for ${descriptor.assetClass}`, {
        provider: this.id,
        capability: "details",
        instrumentId: descriptor.id,
        retryable: false,
      });
    }
    try {
      const [payload, quotes] = await Promise.all([
        this.client.quoteSummary(
          providerSymbol,
          { modules },
          { fetchOptions: { signal: options.signal } },
        ),
        this.hydrateQuotes([providerSymbol], { signal: options.signal }),
      ]);
      return normalizeYahooDetails(normalizeQuoteSummaryUnits(payload || {}), {
        descriptor,
        quote: quotes.get(providerSymbol) || null,
        clock: this.clock,
      });
    } catch (error) {
      throw normalizeProviderError(error, {
        provider: this.id,
        capability: "details",
        instrumentId: descriptor.id,
      });
    }
  }

  async news(descriptor, options = {}) {
    const mapping = descriptor?.providerSymbols?.yahoo;
    const providerSymbol = `${mapping?.symbol || ""}`.trim().toUpperCase();
    if (!descriptor?.id || !providerSymbol || mapping?.verified !== true) {
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `No verified Yahoo news mapping for ${descriptor?.id || "instrument"}`,
        {
          provider: this.id,
          capability: "news",
          instrumentId: descriptor?.id || null,
          retryable: false,
        },
      );
    }
    this.assertCapability("news", descriptor.assetClass, descriptor.id);

    try {
      const payload = await this.client.search(
        providerSymbol,
        {
          quotesCount: 0,
          newsCount: NEWS_PROVIDER_LIMIT,
          region: "US",
          lang: "en-US",
        },
        { fetchOptions: { signal: options.signal } },
      );
      return normalizeYahooNews(payload, {
        instrument: descriptor,
        resolveProviderSymbol: options.resolveProviderSymbol,
        clock: this.clock,
      });
    } catch (error) {
      throw normalizeProviderError(error, {
        provider: this.id,
        capability: "news",
        instrumentId: descriptor.id,
      });
    }
  }
}
