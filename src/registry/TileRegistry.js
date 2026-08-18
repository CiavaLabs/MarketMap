import { FixedHistory } from "../core/FixedHistory.js";

const DEFAULT_QUOTE_HISTORY_LENGTH = 60;
const MAX_QUOTE_HISTORY_LENGTH = 120;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSymbol(value) {
  return nonEmptyString(value) ? value.trim().toUpperCase() : null;
}

function instrumentFrom(candidate) {
  const instrument = candidate?.instrument || candidate;
  const id = instrument?.id ?? candidate?.instrumentId;
  const symbol = instrument?.symbol ?? candidate?.symbol ?? candidate?.ticker;
  if (!nonEmptyString(id) || !nonEmptyString(symbol)) {
    throw new TypeError("TileRegistry assets require canonical id and symbol");
  }
  return { ...instrument, id: id.trim(), symbol: symbol.trim() };
}

function boundedCapacity(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_QUOTE_HISTORY_LENGTH;
  return Math.min(parsed, MAX_QUOTE_HISTORY_LENGTH);
}

function quoteRecord(quote) {
  if (!quote || typeof quote !== "object") return null;
  if (typeof quote.price !== "number" || !Number.isFinite(quote.price)) return null;
  if (quote.quality === "unavailable") return null;
  if (typeof quote.asOf !== "string" || !Number.isFinite(Date.parse(quote.asOf))) return null;
  return Object.freeze({
    price: quote.price,
    changePercent: typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent)
      ? quote.changePercent
      : null,
    asOf: quote.asOf,
    fetchedAt: typeof quote.fetchedAt === "string" ? quote.fetchedAt : null,
    quality: quote.quality || "fresh",
    source: quote.source || null,
  });
}

export class TileRegistry {
  constructor(assets = [], options = {}) {
    this.root = options.root || (typeof document !== "undefined" ? document : null);
    this.historyLength = boundedCapacity(options.historyLength);
    this.quoteHistory = new Map();
    this.historySeries = new Map();
    this.setAssets(assets);
  }

  setAssets(assets = []) {
    if (!Array.isArray(assets)) throw new TypeError("assets must be an array");
    const instruments = assets.map(instrumentFrom);
    const idLookup = new Map();
    const symbolIds = new Map();

    instruments.forEach((instrument, index) => {
      if (idLookup.has(instrument.id)) throw new Error(`Duplicate canonical instrument id: ${instrument.id}`);
      idLookup.set(instrument.id, index);
      const symbol = normalizeSymbol(instrument.symbol);
      if (!symbolIds.has(symbol)) symbolIds.set(symbol, new Set());
      symbolIds.get(symbol).add(instrument.id);
    });

    this.assets = instruments;
    this.assetIndexLookup = idLookup;
    this.symbolLookup = new Map();
    symbolIds.forEach((ids, symbol) => {
      if (ids.size !== 1) return;
      const instrumentId = ids.values().next().value;
      this.symbolLookup.set(symbol, instrumentId);
      this.assetIndexLookup.set(symbol, idLookup.get(instrumentId));
    });

    const activeIds = new Set(idLookup.keys());
    for (const instrumentId of this.quoteHistory.keys()) {
      if (!activeIds.has(instrumentId)) this.quoteHistory.delete(instrumentId);
    }
    for (const instrumentId of this.historySeries.keys()) {
      if (!activeIds.has(instrumentId)) this.historySeries.delete(instrumentId);
    }
    activeIds.forEach((instrumentId) => {
      if (!this.quoteHistory.has(instrumentId)) {
        this.quoteHistory.set(instrumentId, new FixedHistory(this.historyLength));
      }
    });
  }

  resolveInstrumentId(identity) {
    const value = typeof identity === "object" && identity !== null
      ? identity.instrumentId || identity.id || identity.symbol || identity.ticker
      : identity;
    if (!nonEmptyString(value)) return null;
    if (this.assetIndexLookup.has(value) && this.assets[this.assetIndexLookup.get(value)]?.id === value) {
      return value;
    }
    return this.symbolLookup.get(normalizeSymbol(value)) || null;
  }

  getAssetIndex(identity) {
    const instrumentId = this.resolveInstrumentId(identity);
    return instrumentId ? this.assetIndexLookup.get(instrumentId) ?? -1 : -1;
  }

  appendQuote(identity, quote, maxLength = this.historyLength) {
    const instrumentId = this.resolveInstrumentId(identity);
    const record = quoteRecord(quote);
    if (!instrumentId || !record) return 0;

    const capacity = boundedCapacity(maxLength);
    let history = this.quoteHistory.get(instrumentId);
    if (!(history instanceof FixedHistory) || history.capacity !== capacity) {
      const previous = history instanceof FixedHistory ? history.toArray() : [];
      history = new FixedHistory(capacity, previous.slice(-capacity));
      this.quoteHistory.set(instrumentId, history);
    }

    const values = history.toArray();
    const last = values.at(-1);
    if (last) {
      const nextTime = Date.parse(record.asOf);
      const lastTime = Date.parse(last.asOf);
      if (nextTime < lastTime) return history.length;
      if (nextTime === lastTime) {
        values[values.length - 1] = record;
        history = new FixedHistory(capacity, values);
        this.quoteHistory.set(instrumentId, history);
        return history.length;
      }
    }

    return history.push(record);
  }

  setQuoteHistory(identity, quotes = []) {
    const instrumentId = this.resolveInstrumentId(identity);
    if (!instrumentId || !Array.isArray(quotes)) return 0;
    this.quoteHistory.set(instrumentId, new FixedHistory(this.historyLength));
    quotes
      .slice()
      .sort((a, b) => Date.parse(a?.asOf) - Date.parse(b?.asOf))
      .forEach((quote) => this.appendQuote(instrumentId, quote));
    return this.quoteHistory.get(instrumentId).length;
  }

  getQuoteHistory(identity) {
    const instrumentId = this.resolveInstrumentId(identity);
    const history = instrumentId ? this.quoteHistory.get(instrumentId) : null;
    return history instanceof FixedHistory
      ? history.toArray().map((quote) => ({ ...quote }))
      : [];
  }

  getHistory(identity) {
    return this.getQuoteHistory(identity).map((quote) => quote.price);
  }

  setHistorySeries(identity, bars = []) {
    const instrumentId = this.resolveInstrumentId(identity);
    if (!instrumentId) return 0;
    const closes = (Array.isArray(bars) ? bars : []).map((bar) => {
      const value = typeof bar === "number"
        ? bar
        : Object.hasOwn(bar || {}, "displayClose")
          ? bar.displayClose
          : bar?.close;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
    this.historySeries.set(instrumentId, closes);
    return closes.filter((value) => value != null).length;
  }

  getHistorySeries(identity) {
    const instrumentId = this.resolveInstrumentId(identity);
    return instrumentId ? this.historySeries.get(instrumentId) || [] : [];
  }

  resetQuoteHistory(identity) {
    if (identity === undefined) {
      this.quoteHistory.forEach((history) => history.clear());
    } else {
      const instrumentId = this.resolveInstrumentId(identity);
      this.quoteHistory.get(instrumentId)?.clear();
    }
  }

  destroy() {
    this.quoteHistory.clear();
    this.historySeries.clear();
  }
}
