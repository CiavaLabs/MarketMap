import { clonePlain } from "../../shared/clonePlain.js";
import { EventEmitter } from "./EventEmitter.js";

const QUALITY_VALUES = new Set(["fresh", "delayed", "stale", "unavailable"]);
const MARKET_STATE_VALUES = new Set(["pre", "regular", "post", "closed", "continuous", "unknown"]);
const CANONICAL_INSTRUMENT_ID = /^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/;
const QUOTE_NUMBER_FIELDS = [
  "price",
  "change",
  "changePercent",
  "open",
  "previousClose",
  "dayHigh",
  "dayLow",
  "bid",
  "ask",
  "volume",
  "averageVolume3m",
];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSymbol(value) {
  return nonEmptyString(value) ? value.trim().toUpperCase() : null;
}

function normalizeInstrument(candidate) {
  const source = candidate?.instrument || candidate;
  const id = source?.id ?? candidate?.instrumentId;
  const symbol = source?.symbol ?? candidate?.symbol ?? candidate?.ticker;
  if (!nonEmptyString(id) || !CANONICAL_INSTRUMENT_ID.test(id.trim())) {
    throw new TypeError("Instrument requires a canonical id");
  }
  if (!nonEmptyString(symbol)) throw new TypeError(`Instrument ${id} requires a symbol`);

  return Object.freeze({
    ...source,
    id: id.trim(),
    symbol: symbol.trim(),
    name: source.name || symbol.trim(),
    status: source.status || "unknown",
  });
}

function emptyQuoteState(instrument) {
  return {
    instrument,
    instrumentId: instrument.id,
    id: instrument.id,
    symbol: instrument.symbol,
    ticker: instrument.symbol,
    name: instrument.name,
    assetClass: instrument.assetClass || null,
    exchange: instrument.exchange || null,
    mic: instrument.mic || null,
    sector: instrument.sector || instrument.category || null,
    category: instrument.category || null,
    price: null,
    value: null,
    change: null,
    changePercent: null,
    previousClose: null,
    open: null,
    dayHigh: null,
    dayLow: null,
    high: null,
    low: null,
    bid: null,
    ask: null,
    volume: null,
    averageVolume3m: null,
    avgVolume: null,
    marketState: "unknown",
    asOf: null,
    fetchedAt: null,
    currency: instrument.currency || null,
    quality: "unavailable",
    source: null,
    priceUnit: instrument.priceUnit || "currency",
    session: null,
    fieldAvailability: {},
    dataQuality: null,
    provenance: null,
    error: null,
    hasInfo: false,
    lastTradeTs: 0,
    dirty: true,
  };
}

function nullableFiniteNumber(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Quote ${field} must be a finite number or null`);
  }
  return value;
}

function timestampOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (!nonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Quote ${field} must be a valid timestamp or null`);
  }
  return value;
}

function cloneError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      code: error.code || "unknown_error",
      message: error.message,
      retryable: Boolean(error.retryable),
    };
  }
  if (typeof error === "string") return { code: "unknown_error", message: error };
  return { ...error };
}

function publicTile(tile) {
  return {
    ...tile,
    instrument: { ...tile.instrument },
    error: cloneError(tile.error),
  };
}

export class StateManager extends EventEmitter {
  constructor(initialInstruments = [], options = {}) {
    super();
    this.clock = options.clock || (() => Date.now());
    this.state = {
      tiles: new Map(),
      symbolLookup: new Map(),
      instrumentIndex: new Map(),
      marketStatus: new Map(),
    };
    this.reconcileTiles(initialInstruments, { preserveExistingData: false, emit: false });
  }

  reinitializeTiles(instruments) {
    return this.reconcileTiles(instruments, { preserveExistingData: false });
  }

  reconcileTiles(instruments = [], options = {}) {
    if (!Array.isArray(instruments)) throw new TypeError("instruments must be an array");
    const preserveExistingData = options.preserveExistingData ?? false;
    const existing = this.state.tiles;
    const nextTiles = new Map();
    const nextIndex = new Map();
    const symbolIds = new Map();

    instruments.forEach((candidate, index) => {
      const instrument = normalizeInstrument(candidate);
      if (nextTiles.has(instrument.id)) {
        throw new Error(`Duplicate canonical instrument id: ${instrument.id}`);
      }

      const previous = preserveExistingData ? existing.get(instrument.id) : null;
      const tile = previous
        ? {
            ...previous,
            instrument,
            instrumentId: instrument.id,
            id: instrument.id,
            symbol: instrument.symbol,
            ticker: instrument.symbol,
            name: instrument.name,
            assetClass: instrument.assetClass || null,
            exchange: instrument.exchange || null,
            mic: instrument.mic || null,
            sector: instrument.sector || instrument.category || null,
            category: instrument.category || null,
            currency: previous.currency || instrument.currency || null,
            dirty: true,
          }
        : emptyQuoteState(instrument);

      nextTiles.set(instrument.id, tile);
      nextIndex.set(instrument.id, index);
      const symbol = normalizeSymbol(instrument.symbol);
      if (!symbolIds.has(symbol)) symbolIds.set(symbol, new Set());
      symbolIds.get(symbol).add(instrument.id);
    });

    const symbolLookup = new Map();
    symbolIds.forEach((ids, symbol) => {
      if (ids.size === 1) symbolLookup.set(symbol, ids.values().next().value);
    });

    this.state.tiles = nextTiles;
    this.state.instrumentIndex = nextIndex;
    this.state.symbolLookup = symbolLookup;
    if (options.emit !== false) {
      this.emit("tiles:reinitialized", {
        count: nextTiles.size,
        instrumentIds: [...nextTiles.keys()],
      });
    }
    return nextTiles.size;
  }

  resolveInstrumentId(identity) {
    const value = typeof identity === "object" && identity !== null
      ? identity.instrumentId || identity.id || identity.symbol || identity.ticker
      : identity;
    if (!nonEmptyString(value)) return null;
    if (this.state.tiles.has(value)) return value;
    return this.state.symbolLookup.get(normalizeSymbol(value)) || null;
  }

  getTile(identity) {
    const instrumentId = this.resolveInstrumentId(identity);
    return instrumentId ? this.state.tiles.get(instrumentId) : undefined;
  }

  getAllTiles() {
    return this.state.tiles;
  }

  getInstrumentIndex(identity) {
    const instrumentId = this.resolveInstrumentId(identity);
    return instrumentId ? this.state.instrumentIndex.get(instrumentId) ?? -1 : -1;
  }

  applyQuoteSnapshot(quote, options = {}) {
    if (!quote || typeof quote !== "object") throw new TypeError("QuoteSnapshot must be an object");
    if (!nonEmptyString(quote.instrumentId)) {
      throw new TypeError("QuoteSnapshot requires instrumentId");
    }
    const instrumentId = this.resolveInstrumentId(quote.instrumentId);
    if (!instrumentId || instrumentId !== quote.instrumentId) {
      if (options.ignoreUnknown) return null;
      throw new Error(`Unknown canonical instrument id: ${quote.instrumentId}`);
    }
    if (!QUALITY_VALUES.has(quote.quality)) {
      throw new TypeError(`Unsupported quote quality: ${String(quote.quality)}`);
    }
    const marketState = quote.session?.phase || quote.marketState || "unknown";
    if (!MARKET_STATE_VALUES.has(marketState)) {
      throw new TypeError(`Unsupported market state: ${String(marketState)}`);
    }

    const normalizedNumbers = Object.fromEntries(
      QUOTE_NUMBER_FIELDS.map((field) => [field, nullableFiniteNumber(quote[field], field)]),
    );
    const valueAvailability = quote.fieldAvailability?.value || quote.fieldAvailability?.price;
    const valueAvailabilityStatus = typeof valueAvailability === "string"
      ? valueAvailability
      : valueAvailability?.status;
    const valueUsable = quote.dataQuality?.status !== "unusable"
      && !["not_applicable", "unsupported", "temporarily_unavailable", "invalid"]
        .includes(valueAvailabilityStatus);
    const tile = this.state.tiles.get(instrumentId);
    const oldPrice = tile.price;
    Object.assign(tile, normalizedNumbers, {
      high: normalizedNumbers.dayHigh,
      low: normalizedNumbers.dayLow,
      avgVolume: normalizedNumbers.averageVolume3m,
      value: quote.value ?? normalizedNumbers.price,
      marketState,
      asOf: timestampOrNull(quote.asOf, "asOf"),
      fetchedAt: timestampOrNull(quote.fetchedAt, "fetchedAt"),
      currency: quote.currency == null ? null : String(quote.currency),
      quality: quote.quality,
      source: quote.provenance?.source || quote.source || null,
      priceUnit: quote.priceUnit || tile.instrument.priceUnit || "currency",
      session: quote.session ? clonePlain(quote.session) : null,
      fieldAvailability: quote.fieldAvailability ? clonePlain(quote.fieldAvailability) : {},
      dataQuality: quote.dataQuality ? clonePlain(quote.dataQuality) : null,
      provenance: quote.provenance ? clonePlain(quote.provenance) : null,
      error: cloneError(options.error || quote.error),
      hasInfo: normalizedNumbers.price !== null && quote.quality !== "unavailable" && valueUsable,
      dirty: true,
    });
    tile.lastTradeTs = tile.asOf ? Date.parse(tile.asOf) : 0;

    const payload = {
      instrumentId,
      id: instrumentId,
      symbol: tile.symbol,
      ticker: tile.symbol,
      index: this.state.instrumentIndex.get(instrumentId),
      oldPrice,
      newPrice: tile.price,
      quote: { ...quote },
      tile: publicTile(tile),
    };
    if (options.emit !== false) this.emit("tile:updated", payload);
    return payload;
  }

  applyQuoteBatch(quotes = [], options = {}) {
    if (!Array.isArray(quotes)) throw new TypeError("quotes must be an array");
    const appliedIds = new Set();
    const items = [];
    const rejected = [];

    quotes.forEach((quote) => {
      let result;
      try {
        result = this.applyQuoteSnapshot(quote, {
          emit: false,
          ignoreUnknown: options.ignoreUnknown,
        });
      } catch (error) {
        rejected.push({
          instrumentId: quote?.instrumentId,
          code: error?.code || "schema_invalid",
          message: error?.message || "Quote failed validation",
          retryable: false,
        });
        return;
      }
      if (!result) return;
      appliedIds.add(result.instrumentId);
      items.push(result);
    });

    const errors = [...(Array.isArray(options.errors) ? options.errors : []), ...rejected];
    const markedIds = new Set();
    errors.forEach((error) => {
      const instrumentId = this.resolveInstrumentId(error?.instrumentId || error?.id || error?.symbol);
      if (!instrumentId || appliedIds.has(instrumentId) || markedIds.has(instrumentId)) return;
      const result = this.markUnavailable(instrumentId, error, { emit: false });
      if (!result) return;
      markedIds.add(instrumentId);
      items.push(result);
    });

    const summary = items.map(({ instrumentId, symbol, index }) => ({
      instrumentId,
      id: instrumentId,
      symbol,
      ticker: symbol,
      index,
    }));
    const payload = {
      items: summary,
      instrumentIds: summary.map((item) => item.instrumentId),
      tickers: summary,
      errors: errors.map(cloneError),
    };
    this.emit("tiles:batch_updated", payload);
    return payload;
  }

  updateTile(identity, quoteData) {
    const instrumentId = this.resolveInstrumentId(identity);
    if (!instrumentId) return null;
    return this.applyQuoteSnapshot({ ...quoteData, instrumentId });
  }

  markUnavailable(identity, error = null, options = {}) {
    const instrumentId = this.resolveInstrumentId(identity);
    if (!instrumentId) return null;
    const tile = this.state.tiles.get(instrumentId);
    const oldPrice = tile.price;
    for (const field of QUOTE_NUMBER_FIELDS) tile[field] = null;
    Object.assign(tile, {
      value: null,
      high: null,
      low: null,
      avgVolume: null,
      marketState: "unknown",
      session: null,
      fieldAvailability: {},
      dataQuality: null,
      provenance: null,
      asOf: null,
      fetchedAt: options.fetchedAt || null,
      quality: "unavailable",
      source: null,
      error: cloneError(error),
      hasInfo: false,
      lastTradeTs: 0,
      dirty: true,
    });
    const payload = {
      instrumentId,
      id: instrumentId,
      symbol: tile.symbol,
      ticker: tile.symbol,
      index: this.state.instrumentIndex.get(instrumentId),
      oldPrice,
      newPrice: null,
      tile: publicTile(tile),
    };
    if (options.emit !== false) this.emit("tile:updated", payload);
    return payload;
  }

  resetTileInfo(identity) {
    return this.markUnavailable(identity, null);
  }

  resetAllTiles() {
    this.state.tiles.forEach((tile) => this.markUnavailable(tile.instrumentId, null, { emit: false }));
    this.emit("tiles:reset", { instrumentIds: [...this.state.tiles.keys()] });
  }

  setMarketStatus(exchange, isOpen) {
    const oldStatus = this.state.marketStatus.get(exchange);
    this.state.marketStatus.set(exchange, isOpen);
    if (oldStatus !== isOpen) this.emit("market:status", { exchange, isOpen, oldStatus });
  }

  getMarketStatus(exchange) {
    return this.state.marketStatus.has(exchange) ? this.state.marketStatus.get(exchange) : null;
  }

  isTradeStale(identity, staleThresholdMs = 300_000) {
    const tile = this.getTile(identity);
    if (!tile || tile.quality === "stale" || tile.quality === "unavailable" || !tile.asOf) return true;
    return this.clock() - Date.parse(tile.asOf) > staleThresholdMs;
  }

  serialize() {
    return {
      schemaVersion: 1,
      tiles: [...this.state.tiles.values()].map((tile) => ({
        instrumentId: tile.instrumentId,
        price: tile.price,
        change: tile.change,
        changePercent: tile.changePercent,
        previousClose: tile.previousClose,
        open: tile.open,
        dayHigh: tile.dayHigh,
        dayLow: tile.dayLow,
        bid: tile.bid,
        ask: tile.ask,
        volume: tile.volume,
        averageVolume3m: tile.averageVolume3m,
        marketState: tile.marketState,
        asOf: tile.asOf,
        fetchedAt: tile.fetchedAt,
        currency: tile.currency,
        quality: tile.quality,
        source: tile.source,
        error: cloneError(tile.error),
      })),
      timestamp: this.clock(),
    };
  }

  deserialize(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.tiles)) return false;
    const restored = [];
    snapshot.tiles.forEach((data) => {
      const instrumentId = this.resolveInstrumentId(data?.instrumentId);
      if (!instrumentId) return;
      const tile = this.state.tiles.get(instrumentId);
      try {
        Object.assign(tile, {
          price: nullableFiniteNumber(data.price, "price"),
          change: nullableFiniteNumber(data.change, "change"),
          changePercent: nullableFiniteNumber(data.changePercent, "changePercent"),
          previousClose: nullableFiniteNumber(data.previousClose, "previousClose"),
          open: nullableFiniteNumber(data.open, "open"),
          dayHigh: nullableFiniteNumber(data.dayHigh, "dayHigh"),
          dayLow: nullableFiniteNumber(data.dayLow, "dayLow"),
          bid: nullableFiniteNumber(data.bid, "bid"),
          ask: nullableFiniteNumber(data.ask, "ask"),
          volume: nullableFiniteNumber(data.volume, "volume"),
          averageVolume3m: nullableFiniteNumber(data.averageVolume3m, "averageVolume3m"),
          marketState: MARKET_STATE_VALUES.has(data.marketState) ? data.marketState : "unknown",
          asOf: timestampOrNull(data.asOf, "asOf"),
          fetchedAt: timestampOrNull(data.fetchedAt, "fetchedAt"),
          currency: data.currency || tile.instrument.currency || null,
          quality: QUALITY_VALUES.has(data.quality) ? data.quality : "unavailable",
          source: data.source || null,
          error: cloneError(data.error),
          dirty: true,
        });
      } catch {
        return;
      }
      tile.high = tile.dayHigh;
      tile.low = tile.dayLow;
      tile.avgVolume = tile.averageVolume3m;
      tile.hasInfo = tile.price !== null && tile.quality !== "unavailable";
      tile.lastTradeTs = tile.asOf ? Date.parse(tile.asOf) : 0;
      restored.push(instrumentId);
    });
    this.emit("state:restored", { snapshot, instrumentIds: restored });
    return true;
  }
}
