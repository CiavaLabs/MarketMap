import { Lifecycle } from "../../core/Lifecycle.js";
import {
  buildAssetPresentationPolicy,
  legacyCompatiblePresentationInput,
} from "../models/assetPresentationPolicy.js";
import { buildDetailViewModel } from "../models/detailAssetViewModel.js";
import { displaySymbolOf, formatInstrumentValue } from "../models/instrumentFormat.js";
import { detailsField, enrichmentFromDetails } from "../models/instrumentEnrichment.js";
import {
  computeRangePosition,
} from "../models/detailViewModel.js";
import {
  buildMovementContext,
  sessionDateForQuote,
} from "../models/movementContextViewModel.js";
import { formatNewsSourceNames } from "../models/newsPresentation.js";
import { selectHistoryPriceBasis } from "../models/historyPresentationPolicy.js";
import { CONFIG } from "../../config.js";
import { formatMarketMapTime } from "../../utils/dateTime.js";
import { numberFormat } from "../../utils/intlFormats.js";

const HISTORY_RANGES = Object.freeze({
  "1d": Object.freeze({ interval: "5m", label: "1D" }),
  "5d": Object.freeze({ interval: "15m", label: "5D" }),
  "1m": Object.freeze({ interval: "1d", label: "1M" }),
  "6m": Object.freeze({ interval: "1d", label: "6M" }),
  "1y": Object.freeze({ interval: "1d", label: "1Y" }),
  "5y": Object.freeze({ interval: "1wk", label: "5Y" }),
});

const DETAIL_FIELD_LABELS = Object.freeze({
  sector: "Sector", industry: "Industry", country: "Country", website: "Website", employees: "Employees",
  marketCap: "Market cap", trailingPe: "P/E (TTM)", forwardPe: "P/E (forward)",
  epsTtm: "EPS (TTM)", beta: "Beta", priceBook: "Price / book", priceSales: "Price / sales",
  dividendYield: "Dividend yield", revenueTtm: "Revenue (TTM)", revenueGrowth: "Revenue growth",
  netMargin: "Net margin", returnOnEquity: "Return on equity", debtEquity: "Debt / equity",
  freeCashFlow: "Free cash flow", freeCashFlowMargin: "FCF margin",
  recommendation: "Analyst view", targetMeanPrice: "Price target", numberOfAnalysts: "Analyst coverage",
  family: "Fund family", category: "Category", legalType: "Legal type", expenseRatio: "Expense ratio",
  topHoldings: "Top holdings", equityAllocation: "Equity allocation", bondAllocation: "Bond allocation",
  cashAllocation: "Cash allocation", totalAssets: "Total assets", yield: "Yield", nav: "NAV", publisher: "Publisher",
  constituents: "Constituents", launchDate: "Launch date", fiftyTwoWeekHigh: "52-week high",
  fiftyTwoWeekLow: "52-week low", priceUnit: "Price unit", baseCurrency: "Base currency",
  quoteCurrency: "Quote currency", sessionModel: "Session model", baseAsset: "Base asset", network: "Network",
  circulatingSupply: "Circulating supply", volume24h: "Volume (24h)", activeContract: "Active contract",
  expirationDate: "Expiration", underlying: "Underlying", openInterest: "Open interest",
  settlementPrice: "Settlement price", dayRangeLow: "Day low", dayRangeHigh: "Day high",
  continuity: "Continuity", comparableAcrossRollover: "Comparable across rollover",
});
const DETAIL_SECTION_TITLES = Object.freeze({
  company_profile: "Company profile", equity_fundamentals: "Fundamentals", analyst_outlook: "Analyst outlook",
  fund_profile: "Fund profile", fund_composition: "Fund composition", fund_stats: "Fund statistics",
  index_metadata: "Index metadata", market_stats: "Market statistics", pair_metadata: "Pair details",
  crypto_metadata: "Crypto asset", crypto_market_stats: "Crypto market statistics", future_contract: "Active contract",
  future_market_stats: "Futures market statistics", rollover_notice: "Continuous series notice",
});
const RAIL_PROMOTED_FIELDS = new Set(["fiftyTwoWeekLow", "fiftyTwoWeekHigh", "targetMeanPrice"]);
const COMPACT_FIELDS = new Set([
  "marketCap", "employees", "constituents", "totalAssets", "circulatingSupply", "volume24h", "openInterest",
  "revenueTtm", "freeCashFlow",
]);
const PERCENT_FIELDS = new Set([
  "expenseRatio", "yield", "equityAllocation", "bondAllocation", "cashAllocation",
  "dividendYield", "revenueGrowth", "netMargin", "returnOnEquity", "freeCashFlowMargin",
]);
const INSTRUMENT_VALUE_FIELDS = new Set([
  "nav", "targetMeanPrice", "settlementPrice", "dayRangeLow", "dayRangeHigh", "fiftyTwoWeekHigh", "fiftyTwoWeekLow",
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceLabel(source) {
  if (!source) return "Source unavailable";
  if (source === "last-known-good") return "Cached market feed";
  if (source === "yahoo") return "Yahoo Finance";
  return titleCase(source);
}

function formatTimestamp(value, options = {}) {
  return formatMarketMapTime(value, {
    month: options.compact ? undefined : "short",
    day: options.compact ? undefined : "numeric",
    year: options.year ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function defaultPrice(value, currency = "USD") {
  if (!finite(value)) return "—";
  try {
    return numberFormat("en-US", {
      style: "currency",
      currency: /^[A-Z]{3}$/.test(currency || "") ? currency : "USD",
      maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function defaultPercent(value) {
  return finite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
}

function defaultCompact(value) {
  return finite(value)
    ? numberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
    : "—";
}

function hasNoCurrentSession(tile) {
  const session = tile?.session;
  return session?.phase === "closed"
    && session?.isTrading === false
    && session?.regularStart == null
    && session?.regularEnd == null;
}

export class ModalView {
  constructor(assets, helpers = {}, options = {}) {
    this.assets = [...assets];
    this.helpers = helpers;
    this.detailApi = options.detailApi || null;
    this.setScrollLocked = options.setScrollLocked || (() => {});
    this.onOverlayChange = options.onOverlayChange || (() => {});
    this.lifecycle = new Lifecycle();
    this.app = null;
    this.open = false;
    this.currentModalAssetIndex = null;
    this.currentInstrumentId = null;
    this.currentRange = "1d";
    this.preferredHistoryRange = "1d";
    this.navigationInstrumentIds = this.assets.map((asset) => asset.id);
    this.renderedHistoryRange = null;
    this.unavailableHistoryRanges = new Set();
    this.currentPolicy = null;
    this.currentDetails = null;
    this.currentHistory = null;
    this.chartBars = [];
    this.detailsError = null;
    this.news = { state: "idle", articles: [], sources: [], stale: false, updatedAt: null, message: "" };
    this.analytics = { state: "idle", record: null };
    this.requestState = { details: "idle", history: "idle", news: "idle" };
    this.requestGeneration = 0;
    this.profileController = null;
    this.historyController = null;
    this.newsController = null;
    this.analyticsController = null;
    this.hoverIndex = null;
  }

  setApp(app) { this.app = app; }

  setDetailApi(api) {
    this.detailApi = api || null;
    this.#refresh();
  }

  init() {}

  destroy() {
    this.closeModal();
    this.lifecycle.destroy();
    this.app = null;
    this.detailApi = null;
  }

  isOpen() { return this.open; }

  updateAssets(next) {
    this.assets = [...next];
    const availableIds = new Set(this.assets.map((asset) => asset.id));
    this.navigationInstrumentIds = this.navigationInstrumentIds.filter((id) => availableIds.has(id));
    if (!this.currentInstrumentId) return;
    const index = this.assets.findIndex((asset) => asset.id === this.currentInstrumentId);
    if (index < 0) this.closeModal();
    else {
      this.currentModalAssetIndex = index;
      this.#refresh();
    }
  }

  setNavigationOrder(instrumentIds) {
    const availableIds = new Set(this.assets.map((asset) => asset.id));
    const seen = new Set();
    this.navigationInstrumentIds = (Array.isArray(instrumentIds) ? instrumentIds : [])
      .filter((id) => availableIds.has(id) && !seen.has(id) && seen.add(id));
    this.#refresh();
  }

  navigateInstrument(offset) {
    if (!this.open || !Number.isInteger(offset) || offset === 0) return false;
    const current = this.navigationInstrumentIds.indexOf(this.currentInstrumentId);
    const targetId = this.navigationInstrumentIds[current + Math.sign(offset)];
    if (current < 0 || !targetId) return false;
    const targetIndex = this.assets.findIndex((asset) => asset.id === targetId);
    if (targetIndex < 0) return false;
    this.showAssetDetails(targetIndex);
    return true;
  }

  handleRemoveTicker() {
    if (!this.currentInstrumentId) return;
    this.helpers.removeTicker?.(this.currentInstrumentId);
    this.closeModal();
  }

  showAssetDetails(index) {
    const asset = this.assets[index];
    if (!this.app || !asset?.id) return;
    let policy;
    try {
      policy = buildAssetPresentationPolicy(legacyCompatiblePresentationInput(asset));
    } catch {
      return;
    }
    const wasOpen = this.open;
    this.#abortRequests();
    this.requestGeneration += 1;
    this.currentModalAssetIndex = index;
    this.currentInstrumentId = asset.id;
    this.currentPolicy = policy;
    this.hoverIndex = null;
    this.unavailableHistoryRanges = new Set();
    if (hasNoCurrentSession(this.app?.state.getTile(asset.id)) && this.#rangeSupported("1d")) {
      this.unavailableHistoryRanges.add("1d");
    }
    this.currentRange = this.#rangeAvailable(this.preferredHistoryRange)
      ? this.preferredHistoryRange
      : this.#initialHistoryRange();
    this.renderedHistoryRange = null;
    this.currentDetails = null;
    this.currentHistory = null;
    this.chartBars = [];
    this.detailsError = null;
    this.news = { state: this.currentPolicy.capabilities.news.requestable ? "loading" : "unavailable", articles: [], sources: [], stale: false, updatedAt: null, message: "" };
    this.analytics = { state: this.#analyticsRequestable() ? "loading" : "unavailable", record: null };
    this.requestState = {
      details: this.currentPolicy.capabilities.details.requestable ? "loading" : "unavailable",
      history: this.currentPolicy.capabilities.history.requestable ? "loading" : "unavailable",
      news: this.currentPolicy.capabilities.news.requestable ? "loading" : "unavailable",
    };
    this.open = true;
    this.detailApi?.setOpen?.(true);
    if (!wasOpen) {
      this.setScrollLocked(true);
      this.onOverlayChange(true);
    }
    this.#refresh();
    const generation = this.requestGeneration;
    if (this.currentPolicy.capabilities.details.requestable) void this.#loadDetails(asset, generation);
    if (this.currentPolicy.capabilities.history.requestable) void this.#loadHistory(asset.id, this.currentRange, generation);
    if (this.currentPolicy.capabilities.news.requestable) void this.#loadNews(asset, generation);
    if (this.analytics.state === "loading") void this.#loadAnalytics(asset, generation);
  }

  closeModal({ notify = true } = {}) {
    const wasOpen = this.open;
    this.#abortRequests();
    this.requestGeneration += 1;
    this.open = false;
    this.currentModalAssetIndex = null;
    this.currentInstrumentId = null;
    this.currentPolicy = null;
    this.currentDetails = null;
    this.currentHistory = null;
    this.chartBars = [];
    this.renderedHistoryRange = null;
    this.unavailableHistoryRanges = new Set();
    this.analytics = { state: "idle", record: null };
    this.hoverIndex = null;
    this.detailApi?.setOpen?.(false);
    if (wasOpen && notify) {
      this.setScrollLocked(false);
      this.onOverlayChange(false);
    }
  }

  updateModalIfOpen(update = null) {
    if (!this.open || !this.currentInstrumentId) return;
    const ids = update?.instrumentIds || (update?.instrumentId ? [update.instrumentId] : []);
    if (ids.length && !ids.includes(this.currentInstrumentId)) return;
    this.#mergeLatestQuoteIntoChart();
    this.#refresh();
  }

  setHistoryRange(range) {
    if (!HISTORY_RANGES[range] || !this.currentInstrumentId || range === this.currentRange || !this.#rangeAvailable(range)) return;
    this.preferredHistoryRange = range;
    this.currentRange = range;
    this.hoverIndex = null;
    this.requestState.history = "loading";
    this.historyController?.abort();
    this.#refresh();
    void this.#loadHistory(this.currentInstrumentId, range, this.requestGeneration);
  }

  drawModalChart(bars = this.chartBars, history = this.currentHistory) {
    this.chartBars = Array.isArray(bars) ? bars : [];
    if (history) this.currentHistory = history;
    this.#refresh();
  }

  #asset() { return this.assets[this.currentModalAssetIndex] || null; }
  #rangeSupported(range) {
    const history = this.currentPolicy?.capabilities.history;
    return Boolean(history?.requestable && history.ranges?.[range]?.includes(HISTORY_RANGES[range]?.interval));
  }
  #rangeAvailable(range) {
    return this.#rangeSupported(range) && !this.unavailableHistoryRanges.has(range);
  }
  #initialHistoryRange() {
    return Object.keys(HISTORY_RANGES).find((range) => this.#rangeAvailable(range)) || "1d";
  }
  #nextHistoryRange(range) {
    const ranges = Object.keys(HISTORY_RANGES);
    const currentIndex = Math.max(0, ranges.indexOf(range));
    const candidates = [...ranges.slice(currentIndex + 1), ...ranges.slice(0, currentIndex)];
    return candidates.find((candidate) => this.#rangeAvailable(candidate)) || null;
  }
  #loadNextHistoryRange(instrumentId, failedRange, generation, terminalState) {
    if (!this.#active(instrumentId, generation) || failedRange !== this.currentRange) return false;
    this.unavailableHistoryRanges.add(failedRange);
    const nextRange = this.#nextHistoryRange(failedRange);
    this.hoverIndex = null;
    if (!nextRange) {
      this.currentHistory = null;
      this.chartBars = [];
      this.renderedHistoryRange = null;
      this.requestState.history = terminalState;
      this.#refresh();
      return false;
    }
    this.currentRange = nextRange;
    this.requestState.history = "loading";
    this.#refresh();
    void this.#loadHistory(instrumentId, nextRange, generation);
    return true;
  }
  #priceBasisForRange(range) {
    const bases = this.currentPolicy?.capabilities.history.priceBases || [];
    return selectHistoryPriceBasis({
      assetClass: this.currentPolicy?.assetClass,
      range,
      interval: HISTORY_RANGES[range]?.interval,
      priceBases: bases,
    });
  }
  #active(instrumentId, generation) { return this.open && this.currentInstrumentId === instrumentId && this.requestGeneration === generation; }
  #abortRequests() {
    this.profileController?.abort();
    this.historyController?.abort();
    this.newsController?.abort();
    this.analyticsController?.abort();
    this.profileController = null;
    this.historyController = null;
    this.newsController = null;
    this.analyticsController = null;
  }

  #analyticsRequestable() {
    return this.currentPolicy?.assetClass === "equity"
      && typeof this.app?.getMovementAnalytics === "function";
  }

  async #loadAnalytics(asset, generation) {
    const controller = new AbortController();
    this.analyticsController = controller;
    try {
      const record = await this.app.getMovementAnalytics(asset.id, { signal: controller.signal });
      if (!this.#active(asset.id, generation)) return;
      this.analytics = record ? { state: "ready", record } : { state: "unavailable", record: null };
      this.#refresh();
    } catch (error) {
      if (error?.name !== "AbortError" && this.#active(asset.id, generation)) {
        this.analytics = { state: "unavailable", record: null };
        this.#refresh();
      }
    } finally {
      if (this.analyticsController === controller) this.analyticsController = null;
    }
  }

  #statisticalContext(tile) {
    if (this.analytics.state !== "ready" || !this.analytics.record) return null;
    return buildMovementContext(this.analytics.record, {
      quoteSessionDate: sessionDateForQuote(tile?.asOf, tile?.session?.timezone),
    });
  }

  async #loadDetails(asset, generation) {
    const controller = new AbortController();
    this.profileController = controller;
    try {
      this.currentDetails = await this.app.getDetails(asset.id, {
        sections: this.currentPolicy.capabilities.details.sections,
        signal: controller.signal,
      });
      this.app.applyInstrumentEnrichment?.(asset.id, enrichmentFromDetails(this.currentDetails));
      if (this.#active(asset.id, generation)) {
        this.requestState.details = "ready";
        this.#refresh();
      }
    } catch (error) {
      if (error?.name !== "AbortError" && this.#active(asset.id, generation)) {
        this.requestState.details = "error";
        this.detailsError = error?.message || "Applicable details are unavailable right now.";
        this.#refresh();
      }
    } finally {
      if (this.profileController === controller) this.profileController = null;
    }
  }

  async #loadHistory(instrumentId, range, generation) {
    const controller = new AbortController();
    this.historyController = controller;
    try {
      const request = {
        range,
        interval: HISTORY_RANGES[range].interval,
        priceBasis: this.#priceBasisForRange(range),
        signal: controller.signal,
      };
      let history = await this.app.getHistory(instrumentId, request);
      const hasDisplayValues = history?.bars?.some((bar) => finite(bar?.displayClose));
      const canRetryRaw = request.priceBasis === "provider_adjusted"
        && history?.bars?.length
        && !hasDisplayValues
        && this.currentPolicy?.capabilities.history.priceBases?.includes("raw");
      if (canRetryRaw) {
        history = await this.app.getHistory(instrumentId, { ...request, priceBasis: "raw" });
      }
      if (!this.#active(instrumentId, generation) || range !== this.currentRange) return;
      const nextBars = Array.isArray(history?.bars) ? history.bars : [];
      const hasUsableBars = nextBars.some((bar) => (
        history?.priceBasis ? finite(bar?.displayClose) : finite(bar?.adjustedClose) || finite(bar?.close)
      ));
      if (!hasUsableBars) {
        this.#loadNextHistoryRange(instrumentId, range, generation, "empty");
        return;
      }
      this.currentHistory = history;
      this.chartBars = nextBars.map((bar) => ({ ...bar }));
      this.renderedHistoryRange = range;
      this.#mergeLatestQuoteIntoChart({ replaceEqual: false });
      this.requestState.history = "ready";
      this.#refresh();
    } catch (error) {
      if (error?.name !== "AbortError" && this.#active(instrumentId, generation)) {
        this.#loadNextHistoryRange(instrumentId, range, generation, "error");
      }
    } finally {
      if (this.historyController === controller) this.historyController = null;
    }
  }

  async #loadNews(asset, generation) {
    const controller = new AbortController();
    this.newsController = controller;
    try {
      const envelope = await this.app.getNews(asset.id, { limit: CONFIG.NEWS.MODAL_LIMIT, signal: controller.signal });
      if (!this.#active(asset.id, generation) || controller.signal.aborted) return;
      const feed = envelope?.data || {};
      const articles = Array.isArray(feed.articles) ? feed.articles.slice(0, CONFIG.NEWS.MODAL_LIMIT) : [];
      this.news = {
        state: articles.length ? "ready" : "empty", articles,
        sources: envelope?.sources?.news || [feed.source],
        stale: feed.quality === "stale" || feed.source === "last-known-good",
        updatedAt: feed.fetchedAt || envelope?.meta?.requestedAt || envelope?.meta?.generatedAt,
        message: articles.length ? "" : `No coverage was published for ${asset.symbol || asset.id} in the last 7 days.`,
      };
      this.requestState.news = this.news.state;
      this.#refresh();
    } catch (error) {
      if (error?.name !== "AbortError" && this.#active(asset.id, generation) && !controller.signal.aborted) {
        this.news = { state: "error", articles: [], sources: [], stale: false, updatedAt: null, message: "News is unavailable right now." };
        this.requestState.news = "error";
        this.#refresh();
      }
    } finally {
      if (this.newsController === controller) this.newsController = null;
    }
  }

  #mergeLatestQuoteIntoChart({ replaceEqual = true } = {}) {
    if (!this.chartBars.length) return false;
    const tile = this.app?.state.getTile(this.currentInstrumentId);
    if (!finite(tile?.price) || !tile.asOf || !Number.isFinite(Date.parse(tile.asOf))) return false;
    if (this.currentHistory?.priceBasis && (this.currentHistory.priceBasis !== "raw" || this.currentHistory.continuity?.kind !== "single_instrument")) return false;
    const timestamp = Date.parse(tile.asOf);
    const index = this.chartBars.findIndex((bar) => Date.parse(bar?.timestamp) === timestamp);
    const patch = { timestamp: tile.asOf, close: tile.price, displayClose: tile.price, adjustedClose: tile.price, volume: null };
    if (index >= 0) {
      if (!replaceEqual) return false;
      this.chartBars[index] = { ...this.chartBars[index], ...patch };
      return true;
    }
    const last = Date.parse(this.chartBars.at(-1)?.timestamp);
    if (!Number.isFinite(last) || timestamp <= last) return false;
    this.chartBars.push(patch);
    return true;
  }

  #formatPrice(value, currency) { return this.helpers.formatPrice?.(value, currency) ?? defaultPrice(value, currency); }
  #formatPercent(value) { return this.helpers.formatPercent?.(value) ?? defaultPercent(value); }
  #formatCompact(value) { return this.helpers.formatVolume?.(value) ?? defaultCompact(value); }
  #formatInstrumentValue(value, source = {}) {
    const asset = this.#asset();
    return formatInstrumentValue(value, source.priceUnit || this.currentPolicy?.priceUnit || asset?.priceUnit || "currency", source.currency || asset?.currency || asset?.quoteCurrency || null, asset?.locale || "en-US");
  }

  #detailModel() {
    const asset = this.#asset();
    if (!asset) return null;
    return buildDetailViewModel({
      instrument: legacyCompatiblePresentationInput(asset),
      quote: this.app?.state.getTile(this.currentInstrumentId) || null,
      details: this.currentDetails,
      history: this.currentHistory,
      requestState: this.requestState,
    });
  }

  #detailSections(model) {
    const sections = (model?.detailSections || []).map((section) => ({
      id: section.id,
      title: DETAIL_SECTION_TITLES[section.id] || titleCase(section.id),
      message: section.state === "unavailable" ? "Temporarily unavailable." : undefined,
      items: section.rows.flatMap((row) => RAIL_PROMOTED_FIELDS.has(row.id) ? [] : [{
        label: DETAIL_FIELD_LABELS[row.id] || titleCase(row.id),
        value: row.state === "unavailable" ? "Temporarily unavailable" : this.#formatDetailValue(row.id, row.value, model),
      }]),
    }));
    return sections.length ? sections : [{ id: "details", title: `${this.currentPolicy.assetLabel} details`, items: [], message: this.detailsError || "No applicable detail fields were returned." }];
  }

  #formatDetailValue(field, value, model) {
    if (value === null || value === undefined) return "Unavailable";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return Object.entries(value).map(([key, child]) => `${titleCase(key)}: ${child}`).join(" · ");
    if (!finite(value)) {
      if (typeof value === "string" && Number.isFinite(Date.parse(value))) return formatTimestamp(value, { year: true });
      return /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value) || /^[a-z]+$/.test(value) ? titleCase(value) : String(value);
    }
    if (COMPACT_FIELDS.has(field)) return this.#formatCompact(value);
    if (PERCENT_FIELDS.has(field)) return `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
    if (INSTRUMENT_VALUE_FIELDS.has(field)) return this.#formatInstrumentValue(value, { priceUnit: model.policy.priceUnit, currency: this.app?.state.getTile(this.currentInstrumentId)?.currency });
    return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }

  #stats(model, tile) {
    const byId = new Map((model?.quote.stats || []).map((stat) => [stat.id, stat]));
    const ask = byId.get("ask");
    const relativeVolume = model?.quote.relativeVolume;
    const spread = finite(tile?.ask) && finite(tile?.bid)
      ? this.#formatInstrumentValue(tile.ask - tile.bid, tile)
      : null;
    return ["open", "previousClose", "volume", "bid"].flatMap((id) => {
      const stat = byId.get(id);
      if (!stat) return [];
      if (id === "bid") {
        if (!ask) return [];
        return [{
          id: "bid-ask",
          label: "Bid / ask",
          value: `${stat.formattedValue} / ${ask.formattedValue}`,
          note: spread ? `Spread ${spread}` : null,
        }];
      }
      if (id === "volume") {
        return [{
          id,
          label: "Volume",
          value: stat.formattedValue,
          meter: relativeVolume ? {
            value: Math.min(relativeVolume.value / 2, 1),
            label: `${relativeVolume.value.toFixed(2)}× avg`,
          } : null,
        }];
      }
      return [{ ...stat, label: id === "previousClose" ? "Prev close" : stat.label, value: stat.formattedValue }];
    });
  }

  #ranges(tile) {
    const valueFormat = (value) => this.#formatInstrumentValue(value, tile);
    const rails = [{ label: "Day range", low: tile?.dayLow, high: tile?.dayHigh, value: tile?.price }];
    const week = { low: detailsField(this.currentDetails, "fiftyTwoWeekLow"), high: detailsField(this.currentDetails, "fiftyTwoWeekHigh"), target: detailsField(this.currentDetails, "targetMeanPrice") };
    rails.push({ label: "52-week range", low: week.low, high: week.high, value: tile?.price, target: week.target });
    return rails.filter((rail) => computeRangePosition(rail.value, rail.low, rail.high) !== null).map((rail) => ({ ...rail, formatValue: valueFormat }));
  }

  #navigation() {
    const index = this.navigationInstrumentIds.indexOf(this.currentInstrumentId);
    const total = this.navigationInstrumentIds.length;
    return {
      position: index >= 0 ? index + 1 : null,
      total,
      canPrevious: index > 0,
      canNext: index >= 0 && index < total - 1,
    };
  }

  #chart(tile, detail) {
    const bars = this.chartBars || [];
    const displayRange = this.renderedHistoryRange || this.currentRange;
    const raw = bars.filter((bar) => Number.isFinite(Date.parse(bar?.timestamp))).map((bar) => ({
      timestamp: bar.timestamp,
      value: bar.displayClose,
      volume: bar.volume,
    })).filter((point) => finite(point.value));
    const formatPrice = (value) => this.#formatInstrumentValue(value, tile);
    const baseline = displayRange === "1d" && finite(tile?.previousClose) && this.currentHistory?.priceBasis === "raw" ? tile.previousClose : raw[0]?.value;
    const last = raw.at(-1)?.value;
    const change = finite(last) && finite(baseline) && baseline !== 0 ? ((last - baseline) / baseline) * 100 : null;
    const compact = displayRange === "1d";
    const includeYear = ["1y", "5y"].includes(displayRange);
    const summary = raw.length
      ? `${HISTORY_RANGES[displayRange].label} price history. First: ${formatPrice(raw[0].value)}. Last: ${formatPrice(last)}.`
      : this.requestState.history === "loading" ? "Loading real price history…" : "Price history unavailable";
    return {
      state: raw.length ? "ready" : this.requestState.history,
      transitioning: raw.length >= 2 && this.requestState.history === "loading",
      series: raw.map((point) => ({ value: point.value, volume: finite(point.volume) ? point.volume : undefined, label: formatTimestamp(point.timestamp, { compact, year: includeYear }) })),
      baseline,
      tone: change === null || change === 0 ? "neutral" : change > 0 ? "gain" : "loss",
      range: this.currentRange,
      ranges: Object.entries(HISTORY_RANGES).map(([value, config]) => ({ value, label: config.label, disabled: !this.#rangeAvailable(value) })),
      startLabel: raw[0] ? formatTimestamp(raw[0].timestamp, { compact, year: includeYear }) : "—",
      endLabel: raw.at(-1) ? formatTimestamp(raw.at(-1).timestamp, { compact, year: includeYear }) : "—",
      heading: raw.length ? `${formatPrice(baseline)} → ${formatPrice(last)}` : "Price history",
      changeLabel: finite(change) ? this.#formatPercent(change) : "—",
      formatPrice,
      showVolume: detail?.chart.volumeDisplay === "supported",
      summary,
      hoveredIndex: this.hoverIndex,
    };
  }

  #buildViewModel() {
    const asset = this.#asset();
    const tile = this.app?.state.getTile(this.currentInstrumentId) || {};
    const detail = this.#detailModel();
    const chart = this.#chart(tile, detail);
    const pair = asset?.baseCurrency && asset?.quoteCurrency ? `${asset.baseCurrency}/${asset.quoteCurrency}` : null;
    const badges = [
      this.currentPolicy?.assetLabel,
      asset?.sector || asset?.category ? titleCase(asset.sector || asset.category) : null,
      asset?.exchange ? titleCase(asset.exchange) : null,
      pair,
      ["currency", "currency_per_unit"].includes(this.currentPolicy?.priceUnit) && asset?.currency ? String(asset.currency).toUpperCase() : null,
    ].filter(Boolean);
    const change = finite(tile.change) ? `${tile.change > 0 ? "+" : ""}${this.#formatInstrumentValue(tile.change, tile)}` : "—";
    const percent = this.#formatPercent(tile.changePercent);
    const newsSource = this.news.state === "loading" ? "Loading source…" : this.news.state === "error" ? "Source unavailable" : formatNewsSourceNames(this.news.articles, this.news.sources);
    const marketUpdated = tile.asOf && Number.isFinite(Date.parse(tile.asOf)) ? `Last updated: ${formatTimestamp(tile.asOf)}` : "Last updated: —";
    const newsUpdated = this.news.updatedAt && Number.isFinite(Date.parse(this.news.updatedAt)) ? `${this.news.stale ? "Last confirmed" : "Last updated"}: ${formatTimestamp(this.news.updatedAt)}` : `${this.news.stale ? "Last confirmed" : "Last updated"}: —`;
    return {
      navigation: this.#navigation(),
      header: {
        symbol: displaySymbolOf(asset),
        name: asset?.name || "",
        badges,
        value: detail?.header.formattedValue || this.#formatInstrumentValue(tile.price, tile),
        changeLabel: `${change} (${percent})`,
        changePercent: finite(tile.changePercent) ? tile.changePercent : 0,
      },
      chart,
      stats: this.#stats(detail, tile),
      ranges: this.#ranges(tile),
      statisticalContext: this.#statisticalContext(tile),
      details: {
        state: this.requestState.details,
        sections: this.#detailSections(detail),
        message: this.requestState.details === "loading" ? "Loading applicable provider details…" : this.detailsError || "No applicable detail fields were returned.",
      },
      news: {
        supported: Boolean(this.currentPolicy?.capabilities.news.requestable),
        state: this.news.state,
        subtitle: `Recent coverage for ${asset?.symbol || asset?.id || "this instrument"}.`,
        articles: this.news.articles,
        message: this.news.state === "loading" ? "Loading recent coverage…" : this.news.message,
        provenance: `${newsSource} · ${newsUpdated}`,
      },
      provenance: {
        market: `Market data from ${sourceLabel(tile.source)} · ${marketUpdated}`,
        news: `News data from ${newsSource} · ${newsUpdated}`,
      },
    };
  }

  #refresh() {
    if (!this.open || !this.detailApi?.setModel) return;
    this.detailApi.setModel(this.#buildViewModel());
  }

  handleChartHover(index) {
    const next = Number.isInteger(index) && index >= 0 ? index : null;
    if (next === this.hoverIndex) return;
    this.hoverIndex = next;
    this.#refresh();
  }
}

export { HISTORY_RANGES };
