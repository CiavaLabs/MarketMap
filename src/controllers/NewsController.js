import { CONFIG } from "../config.js";
import { BatchRequestPlanner } from "../api/BatchRequestPlanner.js";
import { RefreshCoordinator } from "../core/RefreshCoordinator.js";
import {
  buildAssetPresentationPolicy,
  legacyCompatiblePresentationInput,
} from "../ui/models/assetPresentationPolicy.js";

function supportsNews(instrument) {
  try {
    return buildAssetPresentationPolicy(
      legacyCompatiblePresentationInput(instrument),
    ).capabilities.news.requestable;
  } catch {
    return false;
  }
}

function normalizeInstruments(instruments) {
  const seen = new Set();
  return (instruments || []).filter((instrument) => {
    const id = typeof instrument?.id === "string" ? instrument.id.trim() : "";
    if (!id || seen.has(id) || !supportsNews(instrument)) return false;
    seen.add(id);
    return true;
  });
}

function instrumentSetKey(instruments) {
  return instruments.map(({ id }) => id).sort().join("\u0000");
}

function serializableError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    code: error.code || "news_unavailable",
    message: error.message || "News is unavailable right now.",
    retryable: error.retryable !== false,
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
  };
}

function clonedArticle(article) {
  return { ...article, instrumentIds: [...(article.instrumentIds || [])] };
}

function firstValidTimestamp(values) {
  return values.find((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    || null;
}

function articleKey(article) {
  return article?.id || article?.url || null;
}

function mergeNewsChunks(ids, outcomes) {
  const articleLists = [];
  const errors = [];
  const sources = new Set();
  const refreshTimes = [];
  const confirmedTimes = [];
  let meta = null;

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      for (const instrumentId of outcome.items) {
        errors.push({
          instrumentId,
          code: outcome.reason?.code || "news_chunk_unavailable",
          message: outcome.reason?.message || "News is unavailable right now.",
          retryable: outcome.reason?.retryable !== false,
        });
      }
      continue;
    }
    const envelope = outcome.value || {};
    meta ||= envelope.meta || null;
    articleLists.push(Array.isArray(envelope.data?.articles) ? envelope.data.articles : []);
    errors.push(...(Array.isArray(envelope.errors) ? envelope.errors : []));
    for (const source of envelope.sources?.news || []) sources.add(source);
    const next = Date.parse(envelope.meta?.nextRefreshAt);
    if (Number.isFinite(next)) refreshTimes.push(next);
    const confirmed = Date.parse(envelope.meta?.lastUpdatedAt);
    if (Number.isFinite(confirmed)) confirmedTimes.push(confirmed);
  }

  const articles = [];
  const seen = new Set();
  const maximumDepth = Math.max(0, ...articleLists.map((list) => list.length));
  for (let index = 0; index < maximumDepth && articles.length < CONFIG.NEWS.BOARD_LIMIT; index += 1) {
    for (const list of articleLists) {
      const candidate = list[index];
      const key = articleKey(candidate);
      if (!candidate || !key || seen.has(key)) continue;
      seen.add(key);
      articles.push(clonedArticle(candidate));
      if (articles.length >= CONFIG.NEWS.BOARD_LIMIT) break;
    }
  }

  return {
    data: { articles },
    ...(errors.length ? { errors } : {}),
    ...(sources.size ? { sources: { news: [...sources] } } : {}),
    meta: {
      ...(meta || {}),
      nextRefreshAt: refreshTimes.length
        ? new Date(Math.min(...refreshTimes)).toISOString()
        : meta?.nextRefreshAt || null,
      ...(confirmedTimes.length
        ? { lastUpdatedAt: new Date(Math.min(...confirmedTimes)).toISOString() }
        : {}),
      requestedInstrumentCount: ids.length,
    },
  };
}

export class NewsController {
  constructor(app, instruments = [], options = {}) {
    if (!app || typeof app.getNewsBatch !== "function") {
      throw new TypeError("NewsController requires an AppController news facade");
    }
    this.app = app;
    this.view = options.view || null;
    this.instruments = normalizeInstruments(instruments);
    this.instrumentKey = instrumentSetKey(this.instruments);
    this.document = options.document || options.root?.ownerDocument || options.root || globalThis.document;
    this.now = typeof options.clock === "function"
      ? options.clock
      : typeof options.clock?.now === "function"
        ? () => options.clock.now()
        : Date.now;
    this.started = false;
    this.destroyed = false;
    this.generation = 0;
    this.requestController = null;
    this.pendingInstrumentRefresh = false;
    this.queuedAgainst = null;
    this.batchPlanner = options.batchPlanner || new BatchRequestPlanner({
      chunkSize: options.maxBatchIds ?? CONFIG.API.MAX_BATCH_IDS,
      concurrency: options.batchConcurrency ?? CONFIG.API.BATCH_CONCURRENCY,
    });
    this.state = {
      status: this.instruments.length ? "idle" : "empty",
      articles: [],
      errors: [],
      sources: [],
      quality: "fresh",
      lastUpdatedAt: null,
      nextRefreshAt: null,
      error: null,
    };

    this.refreshCoordinator = new RefreshCoordinator({
      refresh: ({ signal }) => this.#load({ signal }),
      refreshPolicy: options.refreshPolicy || CONFIG.REFRESH.POLICY,
      allowRefreshControl: options.allowRefreshControl !== false,
      allowManualRefresh: options.allowManualRefresh !== false,
      pauseWhenHidden: options.pauseWhenHidden !== false,
      minimumRefreshMs: options.minimumRefreshMs ?? CONFIG.REFRESH.MINIMUM_MS,
      maximumRetryMs: options.maximumRetryMs ?? 60_000,
      visibilityTarget: this.document,
      clock: options.clock,
      timer: options.timer || options.timers,
      onStateChange: (refreshState) => {
        if (this.destroyed || this.state.nextRefreshAt === refreshState.nextRefreshAt) return;
        this.state.nextRefreshAt = refreshState.nextRefreshAt;
        this.#render();
      },
    });
    this.view?.setInstruments?.(this.instruments);
    this.#render();
  }

  start() {
    if (this.destroyed) return Promise.resolve(null);
    if (this.started) return this.refreshCoordinator.inFlight || Promise.resolve(null);
    this.started = true;
    return this.refreshCoordinator.start({ immediate: this.instruments.length > 0 });
  }

  refreshNow() {
    if (this.destroyed || !this.started || this.instruments.length === 0) {
      return Promise.resolve(null);
    }
    return this.refreshCoordinator.refreshNow();
  }

  setAutoRefresh(enabled) {
    return this.refreshCoordinator.setAutoRefreshEnabled(enabled);
  }

  pause(reason = "host") {
    return this.refreshCoordinator.pause(reason);
  }

  resume(reason = "host") {
    return this.refreshCoordinator.resume(reason);
  }

  setInstruments(instruments = []) {
    if (this.destroyed) return false;
    const next = normalizeInstruments(instruments);
    const nextKey = instrumentSetKey(next);
    this.instruments = next;
    this.view?.setInstruments?.(next);
    if (nextKey === this.instrumentKey) {
      this.#render();
      return false;
    }

    this.instrumentKey = nextKey;
    this.generation += 1;
    this.requestController?.abort();
    if (next.length === 0) {
      this.pendingInstrumentRefresh = false;
      this.refreshCoordinator.setNextRefreshAt(null);
      this.#commit({
        status: "empty",
        articles: [],
        errors: [],
        sources: [],
        quality: "fresh",
        lastUpdatedAt: null,
        nextRefreshAt: null,
        error: null,
      });
      return true;
    }

    this.#commit({
      status: "loading",
      articles: [],
      errors: [],
      sources: [],
      quality: "fresh",
      lastUpdatedAt: null,
      nextRefreshAt: null,
      error: null,
    });
    if (this.started) this.#refreshAfterCurrentRequest();
    return true;
  }

  getState() {
    return {
      ...this.state,
      articles: this.state.articles.map(clonedArticle),
      errors: this.state.errors.map((error) => ({ ...error })),
      sources: [...this.state.sources],
      error: this.state.error ? { ...this.state.error } : null,
    };
  }

  destroy() {
    if (this.destroyed) return false;
    this.destroyed = true;
    this.generation += 1;
    this.pendingInstrumentRefresh = false;
    this.requestController?.abort();
    this.requestController = null;
    this.refreshCoordinator.destroy();
    this.app = null;
    this.view = null;
    return true;
  }

  #refreshAfterCurrentRequest() {
    const current = this.refreshCoordinator.inFlight;
    if (!current) {
      this.pendingInstrumentRefresh = false;
      void this.refreshCoordinator.refreshNow().catch(() => null);
      return;
    }

    this.pendingInstrumentRefresh = true;
    if (this.queuedAgainst === current) return;
    this.queuedAgainst = current;
    void current.catch(() => null).then(() => {
      if (this.queuedAgainst === current) this.queuedAgainst = null;
      if (
        this.destroyed
        || !this.started
        || !this.pendingInstrumentRefresh
        || this.instruments.length === 0
      ) {
        return null;
      }
      this.pendingInstrumentRefresh = false;
      return this.refreshCoordinator.refreshNow().catch(() => null);
    });
  }

  async #load({ signal }) {
    const generation = this.generation;
    const ids = this.instruments.map(({ id }) => id);
    this.pendingInstrumentRefresh = false;
    if (ids.length === 0) return { meta: { nextRefreshAt: null } };

    const controller = new AbortController();
    this.requestController = controller;
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", forwardAbort, { once: true });
    if (this.#active(generation)) {
      this.#commit({ status: "loading", error: null });
    }

    try {
      const outcomes = await this.batchPlanner.execute(
        ids,
        (chunk, context) => this.app.getNewsBatch(chunk, {
          limit: CONFIG.NEWS.BOARD_LIMIT,
          signal: context.signal,
          timeoutMs: CONFIG.API.NEWS_BATCH_TIMEOUT_MS,
        }),
        {
          signal: controller.signal,
          timeoutMs: CONFIG.API.NEWS_BATCH_TIMEOUT_MS,
        },
      );
      if (outcomes.length && outcomes.every(({ status }) => status === "rejected")) {
        throw outcomes[0].reason;
      }
      const envelope = mergeNewsChunks(ids, outcomes);
      if (!this.#active(generation) || controller.signal.aborted) {
        return { meta: { nextRefreshAt: null }, superseded: true };
      }
      const articles = Array.isArray(envelope?.data?.articles)
        ? envelope.data.articles.slice(0, CONFIG.NEWS.BOARD_LIMIT).map(clonedArticle)
        : [];
      const errors = Array.isArray(envelope?.errors)
        ? envelope.errors.map((error) => ({ ...error }))
        : [];
      const sources = [...new Set(envelope?.sources?.news || [])];
      const quality = sources.includes("last-known-good") ? "stale" : "fresh";
      const totalFailure = articles.length === 0 && errors.length >= ids.length;
      const confirmedAt = firstValidTimestamp([
        envelope?.meta?.lastUpdatedAt,
        envelope?.lastUpdatedAt,
      ]);
      const lastUpdatedAt = quality === "stale"
        ? confirmedAt
        : confirmedAt || firstValidTimestamp([
          envelope?.meta?.requestedAt,
          envelope?.meta?.generatedAt,
        ]) || new Date(this.now()).toISOString();
      this.#commit({
        status: totalFailure ? "error" : articles.length ? "ready" : "empty",
        articles,
        errors,
        sources,
        quality,
        lastUpdatedAt,
        nextRefreshAt: envelope?.meta?.nextRefreshAt || null,
        error: totalFailure ? {
          name: "Error",
          code: "news_unavailable",
          message: "News is unavailable right now.",
          retryable: errors.some((error) => error.retryable !== false),
        } : null,
      });
      return envelope;
    } catch (error) {
      if (!this.#active(generation) || controller.signal.aborted || error?.name === "AbortError") {
        return { meta: { nextRefreshAt: null }, superseded: true };
      }
      this.#commit({
        status: "error",
        articles: [],
        errors: [],
        sources: [],
        quality: "fresh",
        lastUpdatedAt: this.state.lastUpdatedAt,
        nextRefreshAt: null,
        error: serializableError(error),
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      if (this.requestController === controller) this.requestController = null;
    }
  }

  #active(generation) {
    return !this.destroyed && generation === this.generation;
  }

  #commit(patch) {
    this.state = { ...this.state, ...patch };
    this.#render();
  }

  #render() {
    this.view?.render?.(this.getState());
  }
}
