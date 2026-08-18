import { AppController } from "../services/AppController.js";
import { STARTER_WORKSPACE } from "../data/workspaces.js";
import { ControlBarView } from "../ui/views/ControlBarView.js";
import { BoardSnapshotView } from "../ui/views/BoardSnapshotView.js";
import { BoardNewsView } from "../ui/views/BoardNewsView.js";
import { ModalView } from "../ui/views/ModalView.js";
import { NewsController } from "../controllers/NewsController.js";
import { formatMarketMapTime } from "../utils/dateTime.js";
import { numberFormat } from "../utils/intlFormats.js";
import { systemTheme } from "../utils/systemTheme.js";
import { normalizeMaxBoardSize } from "../config.js";
import { openWithDetailTransition } from "../ui/motion/boardMotion.js";

function formatPrice(value, currency = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try {
    return numberFormat("en-US", {
      style: "currency",
      currency: /^[A-Z]{3}$/.test(currency || "") ? currency : "USD",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%`
    : "—";
}

function formatVolume(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? numberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value)
    : "—";
}

function formatRelativeTime(value) {
  return formatMarketMapTime(value, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const CANONICAL_INSTRUMENT_ID = /^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/;

function validateInitialInstruments(instruments) {
  const ids = new Set();
  for (const candidate of instruments) {
    const source = candidate?.instrument || candidate;
    const id = source?.id || candidate?.instrumentId;
    const symbol = source?.symbol || candidate?.symbol || candidate?.ticker;
    if (
      typeof id !== "string"
      || !CANONICAL_INSTRUMENT_ID.test(id.trim())
      || typeof symbol !== "string"
      || !symbol.trim()
    ) {
      throw new TypeError("Board instruments require canonical id and symbol");
    }
    const canonicalId = id.trim();
    if (ids.has(canonicalId)) {
      throw new Error(`Duplicate canonical instrument id: ${canonicalId}`);
    }
    ids.add(canonicalId);
  }
}

export function createMarketMap(options = {}) {
  const root = options.root;
  if (!root?.querySelector) throw new TypeError("createMarketMap requires a root Element");
  const container = root.querySelector("#marketmap");
  if (!container) throw new Error("MarketMap root must contain #marketmap");
  if (root.dataset.marketmapMounted === "true") throw new Error("MarketMap root is already mounted");

  const instruments = [...(
    options.instruments
    || options.assets
    || options.workspace?.instruments
    || STARTER_WORKSPACE.instruments
  )];
  const maxBoardSize = normalizeMaxBoardSize(options.maxBoardSize);
  if (instruments.length > maxBoardSize && options.allowInitialOversize !== true) {
    throw new RangeError(`Board accepts at most ${maxBoardSize} instruments`);
  }
  validateInitialInstruments(instruments);
  const theme = options.theme === "light" || options.theme === "dark"
    ? options.theme
    : systemTheme();
  const formatters = {
    formatPrice: options.formatters?.formatPrice || formatPrice,
    formatPercent: options.formatters?.formatPercent || formatPercent,
    formatVolume: options.formatters?.formatVolume || formatVolume,
    formatRelativeTime: options.formatters?.formatRelativeTime || formatRelativeTime,
  };

  const priorRootState = {
    hadAppClass: root.classList.contains("marketmap-app"),
    marketmapMounted: root.dataset.marketmapMounted,
    marketmapTheme: root.dataset.marketmapTheme,
    dsRoot: root.dataset.dsRoot,
    theme: root.dataset.theme,
    feedQuality: root.dataset.feedQuality,
  };
  const restoreRoot = () => {
    if (!priorRootState.hadAppClass) root.classList.remove("marketmap-app");
    for (const key of ["marketmapMounted", "marketmapTheme", "dsRoot", "theme", "feedQuality"]) {
      if (priorRootState[key] === undefined) delete root.dataset[key];
      else root.dataset[key] = priorRootState[key];
    }
  };

  let detailRoot = null;
  let modalView = null;
  let gridRoot = null;
  let app = null;
  let boardNewsView = null;
  let newsController = null;
  let boardSnapshotView = null;
  let controlBarView = null;
  let subscriptions = [];
  let ready = null;
  let newsReady = null;
  const teardown = () => {
    subscriptions.forEach((unsubscribe) => unsubscribe?.());
    subscriptions = [];
    controlBarView?.destroy();
    boardSnapshotView?.destroy();
    boardNewsView?.destroy();
    newsController?.destroy();
    modalView?.destroy();
    app?.destroy();
    gridRoot?.root?.unmount();
    detailRoot?.root?.unmount();
    restoreRoot();
  };

  try {
    root.classList.add("marketmap-app");
    root.dataset.marketmapMounted = "true";
    root.dataset.marketmapTheme = theme;
    root.dataset.dsRoot = "";
    root.dataset.theme = theme;
    container.replaceChildren();

    detailRoot = options.reactIslands?.mountInstrumentDetail?.(
      root.querySelector("#react-instrument-detail"),
      {
        onClose: () => modalView?.closeModal(),
        onRemove: () => modalView?.handleRemoveTicker(),
        onRangeChange: (range) => modalView?.setHistoryRange(range),
        onHoverChange: (index) => modalView?.handleChartHover(index),
        onNavigate: (offset) => modalView?.navigateInstrument(offset),
      },
    ) || null;

    modalView = new ModalView(instruments, {
      ...formatters,
      removeTicker: options.actions?.removeTicker,
    }, {
      root,
      setScrollLocked: options.setScrollLocked,
      onOverlayChange: options.onOverlayChange,
      detailApi: detailRoot,
    });
    modalView.init();

    const openInstrumentDetails = (index, context = {}) => openWithDetailTransition({
      document: root.ownerDocument,
      scopeElement: root,
      sourceElement: context.sourceElement,
      update: () => modalView.showAssetDetails(index),
    });
    gridRoot = options.reactIslands?.mountAssetGrid?.(container, {
      initialLayout: options.layout,
      onSelectTile: openInstrumentDetails,
      onNewsRetry: () => void app.refreshNews().catch(() => null),
      onNewsOpenChange: (open) => options.actions?.setNewsOpen?.(open),
      onReorder: (move) => controlBarView?.handleLayoutMove(move),
    });

    app = new AppController(instruments, {
      root,
      storage: options.storage,
      client: options.client,
      apiBaseUrl: options.apiBaseUrl,
      requestTimeoutMs: options.requestTimeoutMs,
      maxBoardSize,
      allowInitialOversize: options.allowInitialOversize,
      refreshPolicy: options.refreshPolicy,
      minimumRefreshMs: options.minimumRefreshMs,
      allowRefreshControl: options.allowRefreshControl,
      allowManualRefresh: options.allowManualRefresh,
      pauseWhenHidden: options.pauseWhenHidden,
      mountToastHost: options.reactIslands?.mountToastHost,
      gridApi: gridRoot,
    });
    modalView.setApp(app);

    boardNewsView = new BoardNewsView(instruments, {
      root,
      gridApi: gridRoot,
    });
    boardNewsView.init();
    newsController = new NewsController(app, instruments, {
      root,
      view: boardNewsView,
      refreshPolicy: options.newsRefreshPolicy || options.refreshPolicy,
      minimumRefreshMs: options.newsMinimumRefreshMs ?? options.minimumRefreshMs,
      maximumRetryMs: options.newsMaximumRetryMs,
      allowRefreshControl: options.allowRefreshControl,
      allowManualRefresh: options.allowManualRefresh,
      pauseWhenHidden: options.pauseWhenHidden,
      clock: options.newsClock,
      timer: options.newsTimer,
    });
    app.setNewsController(newsController);
    app.setViews({ modalView });

    boardSnapshotView = new BoardSnapshotView(app, instruments, {
      formatRelativeTime: formatters.formatRelativeTime,
      openInstrumentDetails: (instrumentId) => {
        const index = app.assets.findIndex((asset) => asset.id === instrumentId);
        if (index >= 0) openInstrumentDetails(index);
      },
      applyPulseFilters: (filters) => controlBarView?.setFilterValues(filters),
    }, { root });
    boardSnapshotView.init();

    controlBarView = new ControlBarView(app, instruments, {
      debounce: options.helpers?.debounce,
      showToast: (message, duration) => app.notify(message, duration),
      reorderBoard: (move) => options.actions?.reorderBoard?.(move),
      cycleTheme: options.actions?.cycleTheme,
      clearAllTickers: options.actions?.clearAllTickers,
      restoreDefaultTickers: options.actions?.restoreDefaultTickers,
      openAddTicker: () => options.actions?.openAddTickerModal?.(),
      boardState: options.boardState,
      switchBoard: options.actions?.switchBoard,
      createBoard: options.actions?.createBoard,
      renameBoard: options.actions?.renameBoard,
      duplicateBoard: options.actions?.duplicateBoard,
      deleteBoard: options.actions?.deleteBoard,
      setBoardDialogOpen: options.actions?.setBoardDialogOpen,
      closeModal: () => modalView.closeModal(),
    }, {
      root,
      onFilterChange: (shown, total, filtered) => boardSnapshotView.setResultCount(shown, total, filtered),
      onVisibleOrderChange: (orderedIds) => modalView.setNavigationOrder(orderedIds),
      mountConsoleActions: options.reactIslands?.mountConsoleActions,
      mountToolbar: options.reactIslands?.mountToolbar,
    });
    controlBarView.init();

    subscriptions = [
      app.state.on("tile:updated", (payload) => {
        boardSnapshotView.scheduleUpdate();
        modalView.updateModalIfOpen(payload);
        options.onTileUpdated?.(payload, app);
      }),
      app.state.on("tiles:batch_updated", (payload) => {
        boardSnapshotView.scheduleUpdate();
        modalView.updateModalIfOpen(payload);
        options.onTilesBatchUpdated?.(payload, app);
      }),
      app.state.on("feed:updated", (payload) => {
        boardSnapshotView.scheduleUpdate();
        options.onFeedUpdated?.(payload, app);
      }),
      app.state.on("board:updated", (payload) => {
        controlBarView.setInstruments(app.assets);
        boardSnapshotView.setInstruments(app.assets);
        options.onBoardUpdated?.(payload, app);
      }),
    ];

    ready = app.init();
    newsReady = app.newsReady;
  } catch (error) {
    try {
      teardown();
    } catch {}
    throw error;
  }
  let destroyed = false;
  return Object.freeze({
    app,
    root,
    ready,
    newsReady,
    views: Object.freeze({
      controlBarView,
      boardSnapshotView,
      boardNewsView,
      modalView,
    }),
    pause: (reason) => destroyed ? false : app.pause(reason),
    resume: (reason) => destroyed ? false : app.resume(reason),
    refresh: () => destroyed ? Promise.resolve(null) : app.refreshNow(),
    refreshNews: () => destroyed ? Promise.resolve(null) : app.refreshNews(),
    setAutoRefresh: (enabled) => destroyed ? false : app.setAutoRefresh(enabled),
    updateInstruments: (next, updateOptions) => destroyed
      ? false
      : app.applyExternalAssets(next, updateOptions),
    setLayoutState: (next) => destroyed ? false : gridRoot?.setLayoutState?.(next),
    setTheme(nextTheme) {
      if (destroyed) return false;
      if (nextTheme !== "light" && nextTheme !== "dark") return false;
      root.dataset.marketmapTheme = nextTheme;
      root.dataset.theme = nextTheme;
      return true;
    },
    getState: () => app.getState(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      teardown();
    },
  });
}
