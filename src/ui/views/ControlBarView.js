import { Lifecycle } from "../../core/Lifecycle.js";
import { perfStart, perfEnd } from "../../utils/perfHelpers.js";
import { selectBoardSamples, selectFilteredInstrumentIds, resolveSector } from "../models/boardSelectors.js";

const ALL_OPTION = { value: "all", label: "All" };
const SEARCH_FILTER_DEBOUNCE_MS = 250;
const DEFAULT_FILTER_STATE = Object.freeze({
  search: "",
  assetClass: "all",
  category: "all",
  movement: "all",
  sort: "default",
});

function assetClassLabel(assetClass) {
  return assetClass === "fx"
    ? "FX"
    : String(assetClass).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export class ControlBarView {
  constructor(app, instruments, helpers = {}, options = {}) {
    this.app = app;
    this.instruments = instruments || [];
    this.helpers = helpers;
    this.root = options.root || document;
    this.document = this.root.ownerDocument || this.root;
    this.lifecycle = new Lifecycle();
    this.onFilterChange = options.onFilterChange || (() => {});
    this.onVisibleOrderChange = options.onVisibleOrderChange || (() => {});
    this.mountConsoleActions = options.mountConsoleActions;
    this.mountToolbar = options.mountToolbar;
    this.consoleActionsRoot = null;
    this.toolbarRoot = null;
    this.filterState = { ...DEFAULT_FILTER_STATE };
    this.applyFiltersDebounced = () => this.applyFilters();
  }

  init() {
    this.#mountConsoleActions();
    this.#mountToolbar();
    this.#setupKeyboardShortcuts();
    this.applyFilters();
  }

  destroy() {
    this.consoleActionsRoot?.unmount();
    this.consoleActionsRoot = null;
    this.toolbarRoot?.root?.unmount();
    this.toolbarRoot = null;
    this.lifecycle.destroy();
  }

  setInstruments(instruments) {
    this.instruments = instruments || [];
    this.#syncOptions();
    this.applyFilters();
  }

  getFilterState() {
    return { ...this.filterState };
  }

  resetFilters() {
    this.filterState = { ...DEFAULT_FILTER_STATE };
    this.toolbarRoot?.setOptions?.({ category: this.#categoryOptions("all") });
    this.toolbarRoot?.setValues?.(this.filterState);
    this.applyFilters();
  }

  setFilterValues(patch = {}) {
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => Object.hasOwn(DEFAULT_FILTER_STATE, key)),
    );
    if (!Object.keys(allowed).length) return false;
    const assetClassChanged = Object.hasOwn(allowed, "assetClass")
      && allowed.assetClass !== this.filterState.assetClass;
    const next = { ...this.filterState, ...allowed };
    if (assetClassChanged && !Object.hasOwn(allowed, "category")) next.category = "all";
    const changed = Object.entries(next).some(([key, value]) => value !== this.filterState[key]);
    if (!changed) return false;

    this.filterState = next;
    if (assetClassChanged) {
      this.toolbarRoot?.setOptions?.({ category: this.#categoryOptions(next.assetClass) });
    }
    this.toolbarRoot?.setValues?.(next);
    this.applyFilters();
    return true;
  }

  setBoardState(boardState) {
    this.helpers.boardState = boardState;
    this.toolbarRoot?.setBoards?.(boardState);
  }

  #announceBoardAction(action, ...args) {
    const result = action?.(...args);
    if (result?.ok === false && result.message) this.helpers.showToast?.(result.message);
    return result;
  }

  handleLayoutMove(move) {
    if (!move?.itemId) return;
    if (this.filterState.sort !== "default") {
      this.filterState.sort = "default";
      this.toolbarRoot?.setValues?.({ sort: "default" });
      this.helpers.showToast?.("Custom order restored; calculated sorting was cleared.");
      this.applyFilters();
    }
    this.helpers.reorderBoard?.(move);
  }

  applyFilters() {
    const perfId = perfStart("applyFilters");
    let processed = 0;
    try {
      const filters = this.getFilterState();
      const samples = selectBoardSamples({
        instruments: this.#instruments(),
        getTile: (identity) => this.app?.state?.getTile?.(identity),
      });
      const orderedIds = selectFilteredInstrumentIds(samples, filters);
      const shown = new Set(orderedIds);
      processed = samples.length;

      this.app?.gridApi?.setOrder(orderedIds);
      this.onVisibleOrderChange(orderedIds);

      const container = this.#byId("marketmap");
      if (container) {
        const atCapacity = (this.app?.assets?.length ?? 0) >= (this.app?.maxBoardSize ?? Infinity);
        container.classList.toggle("single-tile-mode", shown.size === 1 && atCapacity);
      }

      const filtered = String(filters.search || "").trim() !== ""
        || filters.assetClass !== "all"
        || filters.category !== "all"
        || filters.movement !== "all";
      this.onFilterChange(shown.size, samples.length, filtered);
    } finally {
      perfEnd(perfId, Math.max(processed, 1));
    }
  }

  #mountConsoleActions() {
    const island = this.#byId("react-console-actions");
    if (!island || typeof this.mountConsoleActions !== "function") return;
    const showTheme = island.dataset.themeControl !== "false";
    this.consoleActionsRoot = this.mountConsoleActions(island, {
      onAddInstrument: () => this.helpers.openAddTicker?.(),
      onClearAll: () => this.helpers.clearAllTickers?.(),
      onRestoreDefaults: () => this.helpers.restoreDefaultTickers?.(),
      onToggleTheme: showTheme ? () => this.helpers.cycleTheme?.() : undefined,
      showTheme,
    });
  }

  #mountToolbar() {
    const island = this.#byId("react-toolbar");
    if (!island || typeof this.mountToolbar !== "function") return;
    this.applyFiltersDebounced = this.#debouncedFilters(SEARCH_FILTER_DEBOUNCE_MS);
    this.toolbarRoot = this.mountToolbar(island, {
      initialState: this.filterState,
      assetClassOptions: this.#assetClassOptions(),
      categoryOptions: this.#categoryOptions("all"),
      boardState: this.helpers.boardState,
      onChange: (state, source) => this.#handleFilterChange(state, source),
      onBoardSwitch: (boardId) => this.helpers.switchBoard?.(boardId),
      onBoardCreate: (name) => this.helpers.createBoard?.(name),
      onBoardRename: (boardId, name) => this.helpers.renameBoard?.(boardId, name),
      onBoardDuplicate: (boardId) => this.#announceBoardAction(this.helpers.duplicateBoard, boardId),
      onBoardDelete: (boardId) => this.#announceBoardAction(this.helpers.deleteBoard, boardId),
      onBoardDialogOpenChange: (open) => this.helpers.setBoardDialogOpen?.(open),
    });
  }

  #debouncedFilters(delayMs) {
    if (typeof this.helpers.debounce === "function") {
      return this.helpers.debounce(() => this.applyFilters(), delayMs);
    }
    let timer = null;
    return () => {
      this.lifecycle.clearTimeout(timer);
      timer = this.lifecycle.timeout(() => {
        timer = null;
        this.applyFilters();
      }, delayMs);
    };
  }

  #handleFilterChange(state, source) {
    this.filterState = { ...state };
    if (source === "assetClass" || source === "reset") {
      this.toolbarRoot?.setOptions?.({ category: this.#categoryOptions(state.assetClass) });
    }
    if (source === "search") this.applyFiltersDebounced();
    else this.applyFilters();
  }

  #syncOptions() {
    if (!this.toolbarRoot?.setOptions) return;
    const assetClassOptions = this.#assetClassOptions();
    if (!assetClassOptions.some((option) => option.value === this.filterState.assetClass)) {
      this.filterState.assetClass = "all";
    }
    const categoryOptions = this.#categoryOptions(this.filterState.assetClass);
    if (!categoryOptions.some((option) => option.value === this.filterState.category)) {
      this.filterState.category = "all";
    }
    this.toolbarRoot.setOptions({ assetClass: assetClassOptions, category: categoryOptions });
    this.toolbarRoot.setValues?.({
      assetClass: this.filterState.assetClass,
      category: this.filterState.category,
    });
  }

  #assetClassOptions() {
    const classes = [...new Set(this.#instruments()
      .map((asset) => asset?.assetClass)
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return [ALL_OPTION, ...classes.map((assetClass) => ({
      value: assetClass,
      label: assetClassLabel(assetClass),
    }))];
  }

  #categoryOptions(assetClass) {
    const contextual = assetClass === "all"
      ? this.#instruments()
      : this.#instruments().filter((asset) => asset.assetClass === assetClass);
    const groups = [...new Set(contextual.map((asset) => this.#group(asset)))]
      .sort((a, b) => a.localeCompare(b));
    return [ALL_OPTION, ...groups.map((group) => ({ value: group, label: group }))];
  }

  #setupKeyboardShortcuts() {
    this.lifecycle.listen(this.root, "keydown", (event) => {
      if (event.key === "Escape") return;
      if (event.target?.closest?.("input, textarea, select, button, summary, a, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "t") {
        const theme = this.#byId("theme-btn");
        if (theme && !theme.disabled) theme.click();
      }
    });
  }

  #instruments() {
    return this.app?.assets || this.instruments || [];
  }

  #group(asset) {
    return resolveSector(asset);
  }

  #byId(id) {
    return this.root.querySelector(`#${id}`);
  }
}
