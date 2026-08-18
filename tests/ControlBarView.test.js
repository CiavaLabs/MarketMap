// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { ControlBarView } from "../src/ui/views/ControlBarView.js";

const assets = [
  { id: "equity:AAPL:XNAS", symbol: "AAPL", name: "Apple", group: "Technology" },
  { id: "equity:JPM:XNYS", symbol: "JPM", name: "JPMorgan", group: "Financials" },
  { id: "equity:BAD:XNAS", symbol: "BAD", name: "Unavailable", group: "Technology" },
];

const DEFAULT_STATE = { search: "", assetClass: "all", category: "all", movement: "all", sort: "default" };

function quote(over) {
  return { price: 100, changePercent: 0, quality: "fresh", source: "yahoo", asOf: "2026-07-13T10:00:00.000Z", ...over };
}

function fakeToolbar() {
  const captured = { onChange: null, state: null, options: { assetClass: null, category: null }, values: [], mountOptions: null };
  const mountToolbar = (_island, opts) => {
    captured.mountOptions = opts;
    captured.onChange = opts.onChange;
    captured.state = opts.initialState;
    captured.options.assetClass = opts.assetClassOptions;
    captured.options.category = opts.categoryOptions;
    return {
      root: { unmount: vi.fn() },
      setOptions: ({ assetClass, category } = {}) => {
        if (assetClass) captured.options.assetClass = assetClass;
        if (category) captured.options.category = category;
      },
      setValues: (next) => captured.values.push(next),
      getState: () => captured.state,
    };
  };
  return { mountToolbar, captured };
}

function mount(states, appOver = {}, instruments = assets, helperOver = {}) {
  document.body.innerHTML = '<main class="marketmap-app" data-shell></main>';
  const root = document.querySelector("[data-shell]");
  renderMarketMapShell(root, { footer: false });
  const grid = root.querySelector("#marketmap");
  instruments.forEach((asset, index) => {
    const tile = document.createElement("button");
    tile.className = "asset-tile";
    tile.dataset.index = String(index);
    tile.dataset.instrumentId = asset.id;
    grid.appendChild(tile);
  });
  const app = {
    assets: instruments,
    state: { getTile: (identity) => states.get(identity) },
    gridApi: { setOrder: vi.fn() },
    ...appOver,
  };
  const helpers = {
    debounce: (callback) => callback,
    showToast: vi.fn(), cycleTheme: vi.fn(),
    reorderBoard: vi.fn(),
    openAddTicker: vi.fn(), clearAllTickers: vi.fn(), restoreDefaultTickers: vi.fn(), closeModal: vi.fn(),
    ...helperOver,
  };
  const onFilterChange = vi.fn();
  const { mountToolbar, captured } = fakeToolbar();
  const consoleCaptured = { options: null };
  const mountConsoleActions = vi.fn((_island, options) => {
    consoleCaptured.options = options;
    return { unmount: vi.fn() };
  });
  const view = new ControlBarView(app, instruments, helpers, {
    root,
    onFilterChange,
    mountConsoleActions,
    mountToolbar,
  });
  view.init();
  return { app, root, view, onFilterChange, helpers, captured, consoleCaptured };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("ControlBarView", () => {
  it("routes every unified console action through its host helper", () => {
    const { helpers, consoleCaptured } = mount(new Map(assets.map((asset) => [asset.id, quote({})])));
    consoleCaptured.options.onAddInstrument();
    consoleCaptured.options.onClearAll();
    consoleCaptured.options.onRestoreDefaults();
    consoleCaptured.options.onToggleTheme();
    expect(helpers.openAddTicker).toHaveBeenCalledOnce();
    expect(helpers.clearAllTickers).toHaveBeenCalledOnce();
    expect(helpers.restoreDefaultTickers).toHaveBeenCalledOnce();
    expect(helpers.cycleTheme).toHaveBeenCalledOnce();
  });

  it("filters the grid from application state and reports the result count", () => {
    const states = new Map([
      [assets[0].id, quote({ changePercent: 0 })],
      [assets[1].id, quote({ changePercent: null, quality: "delayed" })],
      [assets[2].id, quote({ price: null, changePercent: null, quality: "unavailable", hasInfo: false })],
    ]);
    const { app, onFilterChange, captured } = mount(states);

    captured.onChange({ ...DEFAULT_STATE, movement: "unavailable" }, "movement");

    expect(app.gridApi.setOrder).toHaveBeenLastCalledWith([assets[2].id]);
    expect(onFilterChange).toHaveBeenLastCalledWith(1, 3, true);
  });

  it("reports the whole board when no filter is active", () => {
    const { onFilterChange } = mount(new Map(assets.map((a) => [a.id, quote({})])));
    expect(onFilterChange).toHaveBeenLastCalledWith(3, 3, false);
  });

  it("defers search filtering when the host supplies no debounce", () => {
    vi.useFakeTimers();
    try {
      const { app, captured } = mount(
        new Map(assets.map((a) => [a.id, quote({})])),
        {},
        assets,
        { debounce: undefined },
      );
      const callsAfterInit = app.gridApi.setOrder.mock.calls.length;

      captured.onChange({ ...DEFAULT_STATE, search: "a" }, "search");
      captured.onChange({ ...DEFAULT_STATE, search: "ap" }, "search");
      captured.onChange({ ...DEFAULT_STATE, search: "apple" }, "search");
      expect(app.gridApi.setOrder).toHaveBeenCalledTimes(callsAfterInit);

      vi.advanceTimersByTime(250);
      expect(app.gridApi.setOrder).toHaveBeenCalledTimes(callsAfterInit + 1);
      expect(app.gridApi.setOrder).toHaveBeenLastCalledWith([assets[0].id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending search filter when the view is destroyed", () => {
    vi.useFakeTimers();
    try {
      const { app, view, captured } = mount(
        new Map(assets.map((a) => [a.id, quote({})])),
        {},
        assets,
        { debounce: undefined },
      );
      captured.onChange({ ...DEFAULT_STATE, search: "apple" }, "search");
      const callsBeforeDestroy = app.gridApi.setOrder.mock.calls.length;

      view.destroy();
      vi.advanceTimersByTime(1_000);

      expect(app.gridApi.setOrder).toHaveBeenCalledTimes(callsBeforeDestroy);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by free text over symbol and company name", () => {
    const { app, onFilterChange, captured } = mount(new Map(assets.map((a) => [a.id, quote({})])));
    captured.onChange({ ...DEFAULT_STATE, search: "apple" }, "search");
    expect(onFilterChange).toHaveBeenLastCalledWith(1, 3, true);
    expect(app.gridApi.setOrder).toHaveBeenLastCalledWith([assets[0].id]);
  });

  it("keeps normal bento geometry when exactly one instrument is visible below capacity", () => {
    const states = new Map([[assets[0].id, quote({})]]);
    const { app, root, view } = mount(states);
    const grid = root.querySelector("#marketmap");
    const instrumentTile = grid.querySelector(`[data-instrument-id="${assets[0].id}"]`);
    grid.replaceChildren(instrumentTile);
    app.assets = [assets[0]];

    view.setInstruments(app.assets);

    expect(grid.classList.contains("single-tile-mode")).toBe(false);
    expect(grid.lastElementChild).toBe(instrumentTile);
  });

  it("composes pulse-driven filters and mirrors them into the toolbar", () => {
    const instruments = assets.map((asset) => ({ ...asset, assetClass: "equity" }));
    const states = new Map([
      [instruments[0].id, quote({ changePercent: 1.2 })],
      [instruments[1].id, quote({ changePercent: -1.1 })],
      [instruments[2].id, quote({ changePercent: 0.1 })],
    ]);
    const { app, view, captured } = mount(states, {}, instruments);

    expect(view.setFilterValues({ assetClass: "equity", movement: "gaining" })).toBe(true);
    expect(app.gridApi.setOrder).toHaveBeenLastCalledWith([instruments[0].id]);
    expect(captured.values.at(-1)).toMatchObject({
      assetClass: "equity",
      movement: "gaining",
      category: "all",
    });

    expect(view.setFilterValues({ category: "Technology" })).toBe(true);
    expect(view.getFilterState()).toMatchObject({
      assetClass: "equity",
      movement: "gaining",
      category: "Technology",
    });
    expect(view.setFilterValues({ movement: "gaining" })).toBe(false);
  });

  it("seeds asset-class options and keeps category options contextual", () => {
    const instruments = [
      { ...assets[0], assetClass: "equity" },
      { ...assets[1], assetClass: "equity" },
      { id: "ARCX:SPY", symbol: "SPY", name: "SPDR ETF", assetClass: "etf", group: "Large Blend" },
    ];
    const states = new Map(instruments.map((asset) => [asset.id, quote({})]));
    const { onFilterChange, captured } = mount(states, {}, instruments);

    expect(captured.options.assetClass.map(({ value }) => value)).toEqual(["all", "equity", "etf"]);

    captured.onChange({ ...DEFAULT_STATE, assetClass: "etf", category: "all" }, "assetClass");

    expect(onFilterChange).toHaveBeenLastCalledWith(1, 3, true);
    expect(captured.options.category.map(({ label }) => label)).toEqual(["All", "Large Blend"]);
  });

  it("clears a calculated sort before applying a user reorder", () => {
    const states = new Map(assets.map((asset) => [asset.id, quote({})]));
    const { view, helpers, captured } = mount(states);
    captured.onChange({ ...DEFAULT_STATE, sort: "ticker" }, "sort");

    const move = { itemId: assets[1].id, beforeId: assets[0].id };
    view.handleLayoutMove(move);

    expect(view.getFilterState().sort).toBe("default");
    expect(captured.values).toContainEqual({ sort: "default" });
    expect(helpers.showToast).toHaveBeenCalledWith(
      "Custom order restored; calculated sorting was cleared.",
    );
    expect(helpers.reorderBoard).toHaveBeenCalledWith(move);
  });

  it("reports a refused board menu action instead of dropping it, and stays quiet on success", () => {
    const states = new Map(assets.map((asset) => [asset.id, quote({})]));
    const { helpers, captured } = mount(states, {}, assets, {
      deleteBoard: vi.fn(() => ({ ok: false, message: "Keep at least one board." })),
      duplicateBoard: vi.fn(() => ({ ok: true, board: { id: "board-2", name: "Semis copy" } })),
    });

    captured.mountOptions.onBoardDelete("board-1");
    expect(helpers.showToast).toHaveBeenCalledWith("Keep at least one board.");

    helpers.showToast.mockClear();
    const result = captured.mountOptions.onBoardDuplicate("board-1");
    expect(helpers.showToast).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, board: { id: "board-2", name: "Semis copy" } });
  });
});
