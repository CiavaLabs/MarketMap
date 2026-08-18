import { CONFIG, normalizeMaxBoardSize } from "../config.js";
import { Lifecycle } from "../core/Lifecycle.js";
import { RefreshCoordinator } from "../core/RefreshCoordinator.js";
import { StateManager } from "../core/StateManager.js";
import { TileController } from "../controllers/TileController.js";
import { TileRegistry } from "../registry/TileRegistry.js";
import { MarketDataClient } from "../api/MarketDataClient.js";
import { computeTiers } from "../ui/models/tileTiering.js";
import { selectHistoryPriceBasis } from "../ui/models/historyPresentationPolicy.js";

const TIER_RECOMPUTE_MS = 45_000;
const TILE_HISTORY_CANDIDATES = Object.freeze([
  Object.freeze({ range: "5d", interval: "15m" }),
  Object.freeze({ range: "1d", interval: "5m" }),
  Object.freeze({ range: "1m", interval: "1d" }),
]);
const CANONICAL_INSTRUMENT_ID = /^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/;

function sameTiers(previous, next) {
  if (previous.size !== next.size) return false;
  for (const [instrumentId, tier] of next) {
    if (previous.get(instrumentId) !== tier) return false;
  }
  return true;
}

function normalizeInstrument(candidate) {
  const source = candidate?.instrument || candidate;
  const id = source?.id || candidate?.instrumentId;
  const symbol = source?.symbol || candidate?.symbol;
  if (
    typeof id !== "string"
    || !CANONICAL_INSTRUMENT_ID.test(id.trim())
    || typeof symbol !== "string"
    || !symbol.trim()
  ) {
    throw new TypeError("Board instruments require canonical id and symbol");
  }
  return {
    ...source,
    id: id.trim(),
    symbol: symbol.trim(),
    name: source.name || symbol.trim(),
    status: source.status || "unknown",
  };
}

function quoteFromTile(tile, quality = tile.quality, source = tile.source) {
  return {
    instrumentId: tile.instrumentId,
    assetClass: tile.assetClass,
    value: tile.value ?? tile.price,
    price: tile.price,
    priceUnit: tile.priceUnit || tile.instrument?.priceUnit || "currency",
    change: tile.change,
    changePercent: tile.changePercent,
    open: tile.open,
    previousClose: tile.previousClose,
    dayHigh: tile.dayHigh,
    dayLow: tile.dayLow,
    bid: tile.bid,
    ask: tile.ask,
    volume: tile.volume,
    averageVolume3m: tile.averageVolume3m,
    marketState: tile.marketState || "unknown",
    ...(tile.session ? { session: structuredClone(tile.session) } : {}),
    ...(tile.fieldAvailability ? { fieldAvailability: structuredClone(tile.fieldAvailability) } : {}),
    ...(tile.dataQuality ? { dataQuality: structuredClone(tile.dataQuality) } : {}),
    ...(tile.provenance ? { provenance: structuredClone(tile.provenance) } : {}),
    asOf: tile.asOf,
    fetchedAt: tile.fetchedAt,
    currency: tile.currency,
    quality,
    source,
  };
}

function historyCapabilityFor(asset) {
  return asset?.capabilities?.history || null;
}

function canRequestHistory(asset, range, interval, priceBasis) {
  const capability = historyCapabilityFor(asset);
  if (!capability) return true;
  if (capability.status === "unsupported") return false;
  if (capability.ranges && !capability.ranges[range]?.includes(interval)) return false;
  if (capability.priceBases && !capability.priceBases.includes(priceBasis)) return false;
  return true;
}

function historiesFromEnvelope(envelope) {
  return Array.isArray(envelope?.data)
    ? envelope.data
    : Array.isArray(envelope?.data?.histories)
      ? envelope.data.histories
      : [];
}

function hasSparklineData(series) {
  if (!Array.isArray(series?.bars)) return false;
  let usablePoints = 0;
  for (const bar of series.bars) {
    const value = Object.hasOwn(bar || {}, "displayClose") ? bar.displayClose : bar?.close;
    if (typeof value === "number" && Number.isFinite(value)) usablePoints += 1;
    if (usablePoints >= 2) return true;
  }
  return false;
}

function hasNoCurrentSession(tile) {
  const session = tile?.session;
  return session?.phase === "closed"
    && session?.isTrading === false
    && session?.regularStart == null
    && session?.regularEnd == null;
}

function supersededAbortError() {
  const error = typeof DOMException === "function"
    ? new DOMException("Board refresh was superseded", "AbortError")
    : Object.assign(new Error("Board refresh was superseded"), { name: "AbortError" });
  error.superseded = true;
  return error;
}

function totalSnapshotFailure(ids, quotes, errors) {
  if (quotes.length > 0 || !ids.length || !Array.isArray(errors)) return null;
  const failedIds = new Set(errors.map((error) => error?.instrumentId).filter(Boolean));
  if (!ids.every((instrumentId) => failedIds.has(instrumentId))) return null;

  const error = new Error("Latest market data is unavailable for every instrument");
  error.name = "SnapshotUnavailableError";
  error.code = "snapshot_unavailable";
  error.retryable = errors.some((item) => item?.retryable !== false);
  error.itemErrors = errors.map((item) => ({ ...item }));
  return error;
}

export class AppController {
  constructor(instruments, options = {}) {
    this.root = options.root || document;
    this.document = this.root.ownerDocument || this.root;
    this.storage = options.storage ?? null;
    this.lifecycle = new Lifecycle();
    this.destroyed = false;
    this.toastHostRoot = null;
    this.notifyToast = null;
    const toastIsland = this.root.querySelector?.("#react-toast-host");
    if (toastIsland && typeof options.mountToastHost === "function") {
      const { root, notify } = options.mountToastHost(toastIsland);
      this.toastHostRoot = root;
      this.notifyToast = notify;
    }
    this.maxBoardSize = normalizeMaxBoardSize(options.maxBoardSize);
    if (!Array.isArray(instruments)
      || (instruments.length > this.maxBoardSize && options.allowInitialOversize !== true)) {
      throw new RangeError(`Board accepts at most ${this.maxBoardSize} instruments`);
    }
    this.assets = instruments.map(normalizeInstrument);
    this.modalView = null;
    this.newsController = null;
    this.feed = {
      status: "idle",
      quality: "unavailable",
      available: 0,
      total: this.assets.length,
      lastUpdatedAt: null,
      error: null,
    };

    this.client = options.client || new MarketDataClient({
      apiBaseUrl: options.apiBaseUrl || CONFIG.API.BASE_URL,
      timeoutMs: options.requestTimeoutMs ?? CONFIG.API.REQUEST_TIMEOUT_MS,
    });
    this.analyticsSupport = null;
    this.serverCapabilities = null;
    this.state = new StateManager(this.assets);
    this.tileRegistry = new TileRegistry(this.assets, {
      root: this.root,
      historyLength: CONFIG.UI.QUOTE_HISTORY_LENGTH,
    });
    this.historyLoadInFlight = false;
    this.historyLastRequestedAt = Number.NEGATIVE_INFINITY;
    this.historyRefreshMs = Math.max(0, options.historyRefreshMs ?? CONFIG.REFRESH.HISTORY_MS);
    this.clock = typeof options.clock === "function" ? options.clock : Date.now;
    this.historyAbort = null;
    this.snapshotAbort = null;
    this.boardGeneration = 0;
    this.queuedBoardRefresh = null;
    this.gridApi = options.gridApi || null;
    this.gridApi?.setOrder(this.assets.map((asset) => asset.id));
    this.gridApi?.setIndexById(new Map(this.assets.map((asset, index) => [asset.id, index])));
    this.tileController = new TileController({
      state: this.state,
      registry: this.tileRegistry,
      historyLength: CONFIG.UI.QUOTE_HISTORY_LENGTH,
      gridApi: this.gridApi,
    });
    this.tierMap = new Map();
    this.compactTierUntil = new Map();
    this.tierRecomputeTimer = null;
    this.subscriptions = [];
    this.#subscribeToState();

    this.refreshCoordinator = new RefreshCoordinator({
      refresh: ({ signal }) => this.refreshSnapshot({ signal }),
      refreshPolicy: options.refreshPolicy || CONFIG.REFRESH.POLICY,
      allowRefreshControl: options.allowRefreshControl !== false,
      allowManualRefresh: options.allowManualRefresh !== false,
      pauseWhenHidden: options.pauseWhenHidden !== false,
      minimumRefreshMs: options.minimumRefreshMs ?? CONFIG.REFRESH.MINIMUM_MS,
      visibilityTarget: this.document,
      onStateChange: (state) => {
        this.state.emit("refresh:state", state);
        this.#renderFeedStatus();
      },
      onError: (error) => {
        this.feed.error = error;
      },
    });
    this.ready = Promise.resolve(null);
    this.newsReady = Promise.resolve(null);
    this.#startTierRecompute();
  }

  #recomputeTiers() {
    const now = this.clock();
    const samples = this.assets.map((asset) => ({
      instrumentId: asset.id,
      changePercent: this.state.getTile(asset.id)?.changePercent ?? null,
    }));
    const previous = this.tierMap;
    const next = computeTiers(samples, previous);
    for (const [instrumentId, eligibleAt] of this.compactTierUntil) {
      if (eligibleAt <= now || !next.has(instrumentId)) {
        this.compactTierUntil.delete(instrumentId);
      } else {
        next.set(instrumentId, "compact");
      }
    }
    this.tierMap = next;
    if (sameTiers(previous, next)) return;
    this.gridApi?.setTiers(next);
  }

  #startTierRecompute() {
    const view = this.document?.defaultView;
    if (!view || typeof view.setInterval !== "function") return;
    this.tierRecomputeTimer = view.setInterval(() => {
      if (!this.destroyed) this.#recomputeTiers();
    }, TIER_RECOMPUTE_MS);
  }

  #subscribeToState() {
    this.subscriptions.push(
      this.state.on("tile:updated", (payload) => this.tileController.handleTileUpdated(payload)),
      this.state.on("tiles:batch_updated", (payload) => this.tileController.handleTilesBatchUpdated(payload)),
      this.state.on("tiles:reset", () => this.paintAll()),
      this.state.on("state:restored", () => this.paintAll()),
    );
  }

  setViews({ modalView } = {}) {
    if (modalView) this.modalView = modalView;
  }

  setNewsController(newsController) {
    this.newsController = newsController || null;
  }

  init() {
    if (this.destroyed) return Promise.resolve(null);
    this.#renderFeedStatus();
    this.paintAll();
    this.#ensureHistoryLoaded();
    this.ready = this.refreshCoordinator.start().catch(() => null);
    this.newsReady = this.ready
      .then(() => this.destroyed ? null : this.newsController?.start())
      .catch(() => null);
    return this.ready;
  }

  async refreshSnapshot({ signal } = {}) {
    if (this.destroyed || this.assets.length === 0) {
      return { data: [], meta: { nextRefreshAt: null } };
    }
    const previousStatus = this.feed.status;
    this.feed.status = "loading";
    this.feed.error = null;
    this.#renderFeedStatus();

    const generation = this.boardGeneration;
    const ids = this.assets.map((asset) => asset.id);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason || supersededAbortError());
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    this.snapshotAbort?.abort(supersededAbortError());
    this.snapshotAbort = controller;

    try {
      const envelope = await this.client.snapshot(ids, { signal: controller.signal });
      if (controller.signal.aborted || generation !== this.boardGeneration) {
        throw supersededAbortError();
      }
      const quotes = [...(envelope.data || [])];
      const snapshotFailure = totalSnapshotFailure(ids, quotes, envelope.errors);
      if (snapshotFailure) throw snapshotFailure;
      const quotedIds = new Set(quotes.map((quote) => quote.instrumentId));
      const unavailableErrors = [];
      for (const error of envelope.errors || []) {
        const tile = this.state.getTile(error?.instrumentId);
        if (!quotedIds.has(error?.instrumentId) && tile?.price !== null && tile?.asOf) {
          quotes.push({
            ...quoteFromTile(tile, "stale"),
            error,
          });
          quotedIds.add(error.instrumentId);
        } else {
          unavailableErrors.push(error);
        }
      }
      this.state.applyQuoteBatch(quotes, { errors: unavailableErrors });
      this.#ensureHistoryLoaded();
      this.#recomputeTiers();
      this.#updateFeedSummary();
      this.feed.status = "ready";
      this.feed.lastUpdatedAt = envelope.meta?.generatedAt || new Date().toISOString();
      this.feed.error = null;
      this.state.emit("feed:updated", { ...this.feed, meta: envelope.meta });
      this.#renderFeedStatus();
      return envelope;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.boardGeneration || error?.name === "AbortError") {
        this.feed.status = previousStatus;
        throw supersededAbortError();
      }
      this.#handleRefreshFailure(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      if (this.snapshotAbort === controller) this.snapshotAbort = null;
    }
  }

  #handleRefreshFailure(error) {
    const recoverableQuotes = [];
    const unavailableErrors = [];
    this.state.getAllTiles().forEach((tile) => {
      if (tile.price !== null && tile.asOf) {
        recoverableQuotes.push(quoteFromTile(tile, "stale"));
      } else {
        const itemError = error?.itemErrors?.find(
          (candidate) => candidate?.instrumentId === tile.instrumentId,
        );
        unavailableErrors.push({
          instrumentId: tile.instrumentId,
          code: itemError?.code || error?.code || "market_data_request_failed",
          message: itemError?.message || error?.message || "Latest market data is unavailable",
          retryable: itemError?.retryable ?? (error?.retryable !== false),
        });
      }
    });
    this.state.applyQuoteBatch(recoverableQuotes, { errors: unavailableErrors });
    this.#updateFeedSummary();
    this.feed.status = "error";
    this.feed.error = error;
    this.state.emit("feed:updated", { ...this.feed });
    this.#renderFeedStatus();
  }

  #updateFeedSummary() {
    const tiles = [...this.state.getAllTiles().values()];
    const available = tiles.filter((tile) => (
      tile.hasInfo !== false
      && tile.dataQuality?.status !== "unusable"
      && tile.quality !== "unavailable"
      && tile.price !== null
    ));
    const qualities = new Set(available.map((tile) => tile.quality));
    this.feed.available = available.length;
    this.feed.total = tiles.length;
    this.feed.quality = available.length === 0
      ? "unavailable"
      : qualities.has("stale")
        ? "stale"
        : qualities.has("delayed")
          ? "delayed"
          : "fresh";
  }

  #renderFeedStatus() {
    if (this.root?.dataset) this.root.dataset.feedQuality = this.feed.quality;
  }

  async searchSymbols(query, options = {}) {
    const envelope = await this.client.search(query, options);
    return envelope.data || [];
  }

  async resolveInstrument(candidate, options = {}) {
    const instrument = normalizeInstrument(candidate);
    const yahooMapping = candidate?.providerSymbols?.yahoo
      ?? candidate?.instrument?.providerSymbols?.yahoo;
    const providerSymbol = typeof yahooMapping === "string" ? yahooMapping : yahooMapping?.symbol;
    const envelope = await this.client.instrument(instrument.id, { ...options, providerSymbol });
    const resolved = envelope.data;
    if (!resolved?.instrument?.id || resolved.instrument.id !== instrument.id) {
      throw new Error(`Unable to validate ${instrument.symbol}`);
    }
    return normalizeInstrument({
      ...resolved.instrument,
      capabilities: resolved.capabilities || {},
      addable: resolved.addable === true,
      reasonCode: resolved.reasonCode || null,
    });
  }

  async validateInstrument(candidate, options = {}) {
    const instrument = await this.resolveInstrument(candidate, options);
    if (instrument.addable !== true) {
      throw new Error(instrument.reasonCode
        ? `This instrument cannot be added yet (${instrument.reasonCode.replaceAll("_", " ")}).`
        : `Unable to validate ${instrument.symbol}`);
    }
    return instrument;
  }

  async getDetails(instrumentId, options = {}) {
    return (await this.client.details(instrumentId, options)).data;
  }

  applyInstrumentEnrichment(instrumentId, patch) {
    const index = this.assets.findIndex((asset) => asset.id === instrumentId);
    if (index < 0 || !patch) return false;
    const current = this.assets[index];
    let changed = false;
    const next = { ...current };
    for (const key of ["sector", "category", "group"]) {
      const value = patch[key];
      if (typeof value === "string" && value && value !== current[key]) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) return false;
    this.assets = [...this.assets.slice(0, index), next, ...this.assets.slice(index + 1)];
    this.state.reconcileTiles(this.assets, { preserveExistingData: true });
    this.tileRegistry.setAssets(this.assets);
    this.state.emit("board:updated", { instruments: this.assets.map((item) => ({ ...item })) });
    return true;
  }

  async getHistory(instrumentId, options = {}) {
    const asset = this.assets.find((candidate) => candidate.id === instrumentId);
    const range = options.range || "1d";
    const interval = options.interval || "5m";
    const declaredBases = historyCapabilityFor(asset)?.priceBases || [];
    const priceBasis = options.priceBasis
      || selectHistoryPriceBasis({ assetClass: asset?.assetClass, range, interval, priceBases: declaredBases });
    if (!canRequestHistory(asset, range, interval, priceBasis)) {
      const error = new Error(`History is unavailable for ${instrumentId}`);
      error.code = "unsupported_semantics";
      error.retryable = false;
      throw error;
    }
    return (await this.client.history(instrumentId, {
      ...options,
      range,
      interval,
      priceBasis,
    })).data;
  }

  async #serverCapabilities() {
    if (!this.serverCapabilities) {
      this.serverCapabilities = Promise.resolve()
        .then(() => this.client.health?.())
        .then((envelope) => {
          const capabilities = envelope?.data?.capabilities;
          return Array.isArray(capabilities) ? new Set(capabilities) : null;
        })
        .catch(() => null);
    }
    return this.serverCapabilities;
  }

  async getMovementAnalytics(instrumentId, options = {}) {
    if (this.analyticsSupport === false) return null;
    if (this.analyticsSupport === null) {
      const capabilities = await this.#serverCapabilities();
      if (capabilities && !capabilities.has("analytics-snapshot")) {
        this.analyticsSupport = false;
        return null;
      }
    }
    try {
      const envelope = await this.client.analyticsSnapshot([instrumentId], options);
      this.analyticsSupport = true;
      return envelope.data.find((item) => item.instrumentId === instrumentId) || null;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.status === 501 || error?.status === 404 || error?.code === "not_implemented") {
        this.analyticsSupport = false;
        return null;
      }
      throw error;
    }
  }

  getNews(instrumentId, options = {}) {
    return this.client.news(instrumentId, options);
  }

  getNewsBatch(instrumentIds, options = {}) {
    return this.client.newsBatch(instrumentIds, options);
  }

  refreshNow() {
    return this.refreshCoordinator.refreshNow();
  }

  setAutoRefresh(enabled) {
    const marketResult = this.refreshCoordinator.setAutoRefreshEnabled(enabled);
    const newsResult = this.newsController?.setAutoRefresh(enabled) ?? true;
    return marketResult && newsResult;
  }

  getRefreshState() {
    return this.refreshCoordinator.getState();
  }

  pause(reason = "host") {
    const marketResult = this.refreshCoordinator.pause(reason);
    const newsResult = this.newsController?.pause(reason) ?? false;
    return marketResult || newsResult;
  }

  resume(reason = "host") {
    const marketResult = this.refreshCoordinator.resume(reason);
    const newsResult = this.newsController?.resume(reason) ?? false;
    return marketResult || newsResult;
  }

  refreshNews() {
    return this.ready.then(() => this.destroyed ? null : this.newsController?.refreshNow());
  }

  canAddTicker() {
    return this.assets.length < this.maxBoardSize;
  }

  applyExternalAssets(nextAssets, options = {}) {
    if (!Array.isArray(nextAssets)
      || (options.allowOversize !== true
        && nextAssets.length > this.maxBoardSize
        && nextAssets.length > this.assets.length)) {
      throw new RangeError(`Board accepts at most ${this.maxBoardSize} instruments`);
    }
    const normalizedAssets = nextAssets.map(normalizeInstrument);
    const normalizedIds = new Set(normalizedAssets.map((asset) => asset.id));
    if (normalizedIds.size !== normalizedAssets.length) {
      throw new Error("Duplicate canonical instrument id in board update");
    }
    this.boardGeneration += 1;
    const generation = this.boardGeneration;
    this.snapshotAbort?.abort(supersededAbortError());
    const previousOrder = this.assets.map((asset) => asset.id);
    const previousIds = new Set(previousOrder);
    const identityChanged = normalizedAssets.length !== previousOrder.length
      || normalizedAssets.some((asset, index) => asset.id !== previousOrder[index]);
    this.assets = normalizedAssets;
    const compactInsertIds = new Set(options.compactInsertIds || []);
    const compactUntil = this.clock() + TIER_RECOMPUTE_MS;
    for (const asset of this.assets) {
      if (!previousIds.has(asset.id) && compactInsertIds.has(asset.id)) {
        this.compactTierUntil.set(asset.id, compactUntil);
      }
    }
    if (identityChanged) {
      this.historyAbort?.abort();
      this.historyAbort = null;
      this.historyLoadInFlight = false;
      this.historyLastRequestedAt = Number.NEGATIVE_INFINITY;
    }
    this.state.reconcileTiles(this.assets, { preserveExistingData: true });
    this.tileRegistry.setAssets(this.assets);
    this.#syncRendererWithRegistry();
    this.modalView?.updateAssets(this.assets);
    this.newsController?.setInstruments(this.assets);
    const nextIds = new Set(this.assets.map((asset) => asset.id));
    for (const id of previousIds) {
      if (!nextIds.has(id)) this.gridApi?.remove(id);
    }
    this.gridApi?.setOrder(this.assets.map((asset) => asset.id));
    this.gridApi?.setIndexById(new Map(this.assets.map((asset, index) => [asset.id, index])));
    this.paintAll();
    this.#recomputeTiers();
    this.feed.total = this.assets.length;
    this.state.emit("board:updated", { instruments: this.assets.map((item) => ({ ...item })) });
    if (options.refresh !== false && this.assets.length) {
      const active = this.refreshCoordinator.inFlight;
      if (active) {
        const queued = Promise.resolve(active)
          .catch(() => null)
          .then(() => {
            if (this.destroyed || generation !== this.boardGeneration || !this.assets.length) return null;
            return this.refreshNow().catch(() => null);
          });
        this.queuedBoardRefresh = queued;
        void queued.finally(() => {
          if (this.queuedBoardRefresh === queued) this.queuedBoardRefresh = null;
        });
      } else {
        void this.refreshNow().catch(() => null);
      }
    }
    return true;
  }

  #syncRendererWithRegistry() {
    if (!this.tileController?.renderer) return;
    Object.assign(this.tileController.renderer, {
      assets: this.tileRegistry.assets,
      assetIndexLookup: this.tileRegistry.assetIndexLookup,
      historySeries: this.tileRegistry.historySeries,
    });
  }

  #ensureHistoryLoaded() {
    if (this.destroyed || this.historyLoadInFlight) return;
    if (typeof this.client.historyBatch !== "function") return;
    const requestedAt = this.clock();
    if (requestedAt - this.historyLastRequestedAt < this.historyRefreshMs) return;
    const ids = this.assets
      .filter((asset) => TILE_HISTORY_CANDIDATES.some(({ range, interval }) => (
        canRequestHistory(asset, range, interval, "raw")
      )))
      .map((asset) => asset.id);
    if (!ids.length) return;
    this.historyLoadInFlight = true;
    this.historyLastRequestedAt = requestedAt;
    const controller = new AbortController();
    this.historyAbort = controller;
    Promise.resolve()
      .then(async () => {
        const unresolved = new Set(ids);
        for (const { range, interval } of TILE_HISTORY_CANDIDATES) {
          if (!unresolved.size || this.destroyed || controller.signal.aborted) break;
          const candidateIds = this.assets
            .filter((asset) => unresolved.has(asset.id)
              && canRequestHistory(asset, range, interval, "raw")
              && !(range === "1d" && hasNoCurrentSession(this.state.getTile(asset.id))))
            .map((asset) => asset.id);
          if (!candidateIds.length) continue;

          const envelope = await this.client.historyBatch(candidateIds, {
            range,
            interval,
            signal: controller.signal,
            timeoutMs: CONFIG.API.HISTORY_BATCH_TIMEOUT_MS,
          });
          if (this.destroyed || controller.signal.aborted) return;
          for (const series of historiesFromEnvelope(envelope)) {
            if (!unresolved.has(series.instrumentId) || !hasSparklineData(series)) continue;
            this.tileRegistry.setHistorySeries(series.instrumentId, series.bars);
            unresolved.delete(series.instrumentId);
          }
        }
      })
      .then(() => {
        if (this.destroyed || controller.signal.aborted) return;
        this.paintAll();
      })
      .catch(() => null)
      .finally(() => {
        if (this.historyAbort !== controller) return;
        this.historyAbort = null;
        this.historyLoadInFlight = false;
      });
  }


  paintTile(identity, index) {
    this.tileController.renderImmediate(identity, index);
  }

  paintAll() {
    this.tileController.renderAll();
  }

  notify(message, duration = 2_800, action) {
    this.notifyToast?.(message, duration, action);
  }

  getState() {
    return {
      board: this.assets.map((instrument) => ({ ...instrument })),
      feed: { ...this.feed },
      refresh: this.getRefreshState(),
      news: this.newsController?.getState() || {
        status: this.assets.length ? "idle" : "empty",
        articles: [],
        errors: [],
        sources: [],
        quality: "fresh",
        lastUpdatedAt: null,
        nextRefreshAt: null,
        error: null,
      },
      market: this.state.serialize(),
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.snapshotAbort?.abort(supersededAbortError());
    this.historyAbort?.abort();
    if (this.tierRecomputeTimer != null) {
      (this.document?.defaultView || globalThis).clearInterval(this.tierRecomputeTimer);
      this.tierRecomputeTimer = null;
    }
    this.newsController?.destroy();
    this.refreshCoordinator.destroy();
    this.subscriptions.forEach((unsubscribe) => unsubscribe?.());
    this.subscriptions.length = 0;
    this.tileController.destroy();
    this.tileRegistry.destroy();
    this.toastHostRoot?.unmount();
    this.toastHostRoot = null;
    this.lifecycle.destroy();
  }
}
