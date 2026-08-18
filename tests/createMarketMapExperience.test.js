// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketMapExperience } from "../src/app/createMarketMapExperience.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { CONFIG } from "../src/config.js";
import { STARTER_WORKSPACE } from "../src/data/workspaces.js";
import { mountAssetGrid } from "../src/react/assetGrid.entry.jsx";
import { mountAddInstrument } from "../src/react/addInstrument.entry.jsx";
import { mountConsoleActions } from "../src/react/consoleActions.entry.jsx";
import { mountInstrumentDetail } from "../src/react/instrumentDetail.entry.jsx";
import { mountToastHost } from "../src/react/toastHost.entry.jsx";

const ISLANDS = { mountAssetGrid, mountAddInstrument, mountConsoleActions };
const resultRows = (root) => [...root.querySelectorAll(".mm-search-result")];
const rowButton = (row) => row.querySelector("button");
const addCountText = (root) => root.querySelector("#add-ticker-count")?.textContent;
const isAddModalOpen = (root) => Boolean(root.querySelector('[role="dialog"] .mm-add-dialog__heading'));

const AS_OF = "2026-07-13T14:30:00.000Z";
const FETCHED_AT = "2026-07-13T14:30:01.000Z";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  exchange: "NASDAQ",
  mic: "XNAS",
  currency: "USD",
  sector: "Technology",
  status: "active",
});

const MSFT = Object.freeze({
  id: "XNAS:MSFT",
  symbol: "MSFT",
  name: "Microsoft Corporation",
  assetClass: "equity",
  exchange: "NASDAQ",
  mic: "XNAS",
  currency: "USD",
  sector: "Technology",
  status: "active",
});

const JPM = Object.freeze({
  id: "XNYS:JPM",
  symbol: "JPM",
  name: "JPMorgan Chase & Co.",
  assetClass: "equity",
  exchange: "NYSE",
  mic: "XNYS",
  currency: "USD",
  sector: "Financials",
  status: "active",
});

const TSLA = Object.freeze({
  id: "XNAS:TSLA",
  symbol: "TSLA",
  name: "Tesla, Inc.",
  assetClass: "equity",
  exchange: "NASDAQ",
  mic: "XNAS",
  currency: "USD",
  sector: "Consumer Discretionary",
  status: "active",
});

const IBM = Object.freeze({
  id: "XNYS:IBM",
  symbol: "IBM",
  name: "International Business Machines Corporation",
  assetClass: "equity",
  exchange: "NYSE",
  mic: "XNYS",
  currency: "USD",
  sector: "Technology",
  status: "active",
});

const BTC = Object.freeze({
  id: "XCRY:BTC-USD",
  symbol: "BTC-USD",
  name: "Bitcoin USD",
  assetClass: "crypto",
  exchange: "Crypto",
  currency: "USD",
  status: "active",
});

const LEGACY_GOLD = Object.freeze({
  id: "FUTURE:GC=F",
  symbol: "GC=F",
  name: "Gold Futures",
  assetClass: "commodity_future",
  exchange: "COMEX",
  currency: "USD",
  status: "active",
  providerSymbols: { yahoo: "GC=F" },
});

const WORKSPACE = Object.freeze({
  id: "client-test-equities",
  name: "Client test equities",
  assetClass: "equity",
  instruments: Object.freeze([AAPL, MSFT]),
});

function quote(instrument) {
  return {
    instrumentId: instrument.id,
    price: instrument.id === TSLA.id ? 319.27 : 205.64,
    change: 1.2,
    changePercent: 0.59,
    open: 204.3,
    previousClose: 204.44,
    dayHigh: 206.1,
    dayLow: 203.8,
    bid: 205.6,
    ask: 205.7,
    volume: 12_340_000,
    averageVolume3m: 18_900_000,
    marketState: "regular",
    asOf: AS_OF,
    fetchedAt: FETCHED_AT,
    currency: "USD",
    quality: "fresh",
    source: "yahoo",
  };
}

function envelope(data, errors = []) {
  return {
    data,
    meta: {
      apiVersion: "v1",
      schemaVersion: 1,
      requestId: "req-experience-test",
      generatedAt: FETCHED_AT,
      nextRefreshAt: null,
    },
    ...(errors.length ? { errors } : {}),
  };
}

function v2Descriptor(instrument) {
  const venue = instrument.assetClass === "crypto"
    ? { code: "CCC", name: "Crypto Aggregate", mic: null, kind: "crypto_network" }
    : {
        code: instrument.exchange === "NYSE" ? "NYQ" : "NMS",
        name: instrument.exchange,
        mic: instrument.mic,
        kind: "exchange",
      };
  return {
    ...instrument,
    displaySymbol: instrument.symbol,
    assetSubtype: instrument.assetClass === "crypto" ? "spot_pair" : "unknown",
    venue,
    priceUnit: "currency",
    providerSymbols: {
      yahoo: { symbol: instrument.symbol, verified: true, verifiedAt: AS_OF },
    },
    mappingStatus: "resolved",
  };
}

function searchRow(instrument, addable = instrument.assetClass === "equity") {
  return {
    instrument: v2Descriptor(instrument),
    candidate: null,
    mappingStatus: "resolved",
    addable,
    reasonCode: addable ? null : "asset_class_disabled",
  };
}

function fakeClient(overrides = {}) {
  const directory = new Map([AAPL, MSFT, JPM, TSLA, IBM, BTC].map((item) => [item.id, item]));
  return {
    apiBaseUrl: "/api/market/v1",
    snapshot: vi.fn(async (ids) => envelope(ids.map((id) => quote(directory.get(id))))),
    profile: vi.fn(async (id) => envelope({
      instrument: directory.get(id),
      source: "yahoo",
      quality: "fresh",
      asOf: AS_OF,
      metrics: [],
    })),
    history: vi.fn(async (id, options = {}) => envelope({
      instrumentId: id,
      range: options.range || "1d",
      interval: options.interval || "5m",
      bars: [],
    })),
    search: vi.fn(async () => envelope([searchRow(TSLA), searchRow(BTC, false)])),
    instrument: vi.fn(async (id) => envelope({
      instrument: directory.get(id) ? v2Descriptor(directory.get(id)) : null,
      capabilities: { quote: { status: "supported" } },
      addable: Boolean(directory.get(id)),
      reasonCode: directory.get(id) ? null : "identity_unsupported",
    })),
    health: vi.fn(async () => envelope({ status: "ok" })),
    ...overrides,
  };
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    read(key) {
      const raw = values.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
  };
}

function fullShell(options = {}) {
  document.body.innerHTML = '<main data-marketmap-root></main>';
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false, ...options });
  return root;
}

async function settle(experience) {
  await experience.ready;
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

async function openAddDialog(experience) {
  expect(experience.openAddTickerModal()).toBe(true);
  await vi.runOnlyPendingTimersAsync();
}

function boardIds(experience) {
  return experience.getState().board.map(({ id }) => id);
}

function persistedCollection(storage) {
  return storage.read(CONFIG.STORAGE.BOARDS_V3);
}

function persistedActiveBoard(storage) {
  const collection = persistedCollection(storage);
  return collection.boards.find((board) => board.id === collection.activeBoardId);
}

describe("createMarketMapExperience canonical board", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    document.body.dataset.theme = "site";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.body.dataset.theme;
  });

  it("loads a canonical board without persisting quote data", async () => {
    const savedBoard = {
      schemaVersion: 1,
      workspaceId: WORKSPACE.id,
      instruments: [JPM],
      updatedAt: "2026-07-12T09:00:00.000Z",
    };
    const storage = memoryStorage({ [CONFIG.STORAGE.BOARD]: savedBoard });
    const client = fakeClient();
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid, mountInstrumentDetail },
    });

    await settle(experience);

    expect(boardIds(experience)).toEqual([JPM.id]);
    expect(client.snapshot.mock.calls[0][0]).toEqual([JPM.id]);
    const jpmTile = root.querySelector(".asset-tile:not(.add-tile)");
    expect(jpmTile?.dataset.instrumentId).toBe(JPM.id);
    expect(jpmTile?.textContent).toContain("JPM");
    expect(storage.read(CONFIG.STORAGE.BOARD)).toEqual(savedBoard);
    savedBoard.instruments.forEach((instrument) => {
      expect(instrument).not.toHaveProperty("price");
      expect(instrument).not.toHaveProperty("change");
      expect(instrument).not.toHaveProperty("quote");
      expect(instrument).not.toHaveProperty("basePrice");
    });
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("migrates a schema v1 board to the v3 collection preserving order and provider symbols", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: WORKSPACE.id,
        instruments: [MSFT, JPM],
        updatedAt: "2026-07-12T09:00:00.000Z",
      },
    });
    const client = fakeClient();
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
    });
    await settle(experience);

    expect(boardIds(experience)).toEqual([MSFT.id, JPM.id]);
    const migrated = persistedCollection(storage);
    const activeBoard = persistedActiveBoard(storage);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.boards).toHaveLength(1);
    expect(activeBoard.instruments.map(({ id }) => id)).toEqual([MSFT.id, JPM.id]);
    activeBoard.instruments.forEach((instrument) => {
      expect(instrument.displaySymbol).toBe(instrument.symbol);
      expect(instrument.venue.mic).toBe(instrument.mic);
      expect(instrument.priceUnit).toBe("currency");
      expect(instrument.providerSymbols.yahoo.verified).toBe(true);
    });
    expect(storage.read(CONFIG.STORAGE.BOARD).schemaVersion).toBe(1);

    await experience.addInstrument({
      ...TSLA,
      providerSymbols: { yahoo: { symbol: "TSLA", verified: true, verifiedAt: AS_OF } },
    });
    const tsla = persistedActiveBoard(storage).instruments.find(({ id }) => id === TSLA.id);
    expect(tsla.providerSymbols.yahoo.symbol).toBe("TSLA");

    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("migrates schema v2 order and movable news state into the v3 collection", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD_V2]: {
        schemaVersion: 2,
        workspaceId: WORKSPACE.id,
        instruments: [AAPL, MSFT, JPM],
        layout: { newsPosition: 1, newsOpen: false },
      },
    });
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid },
    });
    await settle(experience);

    expect(experience.getState().layout).toEqual({ newsPosition: 1, newsOpen: false });
    expect(root.querySelector('[data-cell="news"]')?.dataset.open).toBe("false");

    await experience.reorderBoard({
      itemId: MSFT.id,
      beforeId: AAPL.id,
    });
    expect(boardIds(experience)).toEqual([MSFT.id, AAPL.id, JPM.id]);
    expect(experience.setNewsOpen(true)).toBe(true);
    expect(persistedActiveBoard(storage)).toMatchObject({
      layout: { newsPosition: 2, newsOpen: true },
    });
    expect(persistedActiveBoard(storage).instruments.map(({ id }) => id))
      .toEqual([MSFT.id, AAPL.id, JPM.id]);
    expect(storage.read(CONFIG.STORAGE.BOARD_V2).layout)
      .toEqual({ newsPosition: 1, newsOpen: false });

    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps three named boards independent across switching and reload", async () => {
    const storage = memoryStorage();
    const firstRoot = fullShell();
    const first = createMarketMapExperience({
      root: firstRoot,
      workspace: WORKSPACE,
      storage,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid },
    });
    await settle(first);

    const semisResult = first.createBoard("Semis");
    expect(semisResult.ok).toBe(true);
    const semisId = semisResult.board.id;
    expect(boardIds(first)).toEqual([]);
    await first.addInstrument(TSLA);
    expect(first.setNewsOpen(false)).toBe(true);
    await first.reorderBoard({
      itemId: "__marketmap_news__",
      beforeId: TSLA.id,
    });

    const duplicateResult = first.duplicateBoard(semisId);
    expect(duplicateResult.ok).toBe(true);
    const watchlistId = duplicateResult.board.id;
    expect(first.renameBoard(watchlistId, "Watchlist")).toMatchObject({ ok: true });
    await first.addInstrument(JPM);
    expect(boardIds(first)).toEqual([TSLA.id, JPM.id]);

    expect(first.switchBoard(WORKSPACE.id)).toBe(true);
    await first.reorderBoard({ itemId: MSFT.id, beforeId: AAPL.id });
    expect(boardIds(first)).toEqual([MSFT.id, AAPL.id]);
    expect(first.getState().boards.map(({ name }) => name))
      .toEqual([WORKSPACE.name, "Semis", "Watchlist"]);
    expect(first.renameBoard(WORKSPACE.id, "Renamed")).toMatchObject({ ok: false });
    expect(first.deleteBoard(WORKSPACE.id)).toMatchObject({ ok: false });
    first.destroy();

    const secondRoot = fullShell();
    const second = createMarketMapExperience({
      root: secondRoot,
      workspace: WORKSPACE,
      storage,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid },
    });
    await settle(second);

    expect(second.getState().activeBoardId).toBe(WORKSPACE.id);
    expect(boardIds(second)).toEqual([MSFT.id, AAPL.id]);
    expect(second.switchBoard(semisId)).toBe(true);
    expect(boardIds(second)).toEqual([TSLA.id]);
    expect(second.getState().layout).toEqual({ newsPosition: 0, newsOpen: false });
    expect(second.switchBoard(watchlistId)).toBe(true);
    expect(boardIds(second)).toEqual([TSLA.id, JPM.id]);
    expect(second.getState().layout).toEqual({ newsPosition: 0, newsOpen: false });
    expect(persistedCollection(storage)).toMatchObject({
      schemaVersion: 3,
      activeBoardId: watchlistId,
      nextBoardSequence: 3,
    });

    await vi.runOnlyPendingTimersAsync();
    second.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("undoes both board deletion and clearing from actionable toasts", async () => {
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage: memoryStorage(),
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid, mountToastHost },
    });
    await settle(experience);
    const created = experience.createBoard("Semis");
    await experience.addInstrument(TSLA);
    const deletedId = created.board.id;

    expect(experience.deleteBoard(deletedId)).toMatchObject({ ok: true });
    expect(experience.getState().boards.map(({ id }) => id)).not.toContain(deletedId);
    await vi.advanceTimersByTimeAsync(0);
    const deletionUndo = [...root.querySelectorAll("button")]
      .find((button) => button.textContent === "Undo");
    expect(deletionUndo).not.toBeNull();
    deletionUndo.click();
    expect(experience.getState().activeBoardId).toBe(deletedId);
    expect(boardIds(experience)).toEqual([TSLA.id]);

    expect(experience.clearAllTickers()).toBe(true);
    expect(boardIds(experience)).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    const clearUndo = [...root.querySelectorAll("button")]
      .filter((button) => button.textContent === "Undo")
      .at(-1);
    expect(clearUndo).not.toBeNull();
    clearUndo.click();
    expect(boardIds(experience)).toEqual([TSLA.id]);

    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("migrates the legacy gold future ID explicitly without enabling the asset class", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: WORKSPACE.id,
        instruments: [LEGACY_GOLD],
      },
    });
    const client = fakeClient({
      snapshot: vi.fn(async () => envelope([])),
    });
    const experience = createMarketMapExperience({
      root: fullShell(),
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
    });
    await settle(experience);

    const [gold] = persistedActiveBoard(storage).instruments;
    expect(gold).toMatchObject({
      id: "FUTURE:CMX.GC.CONTINUOUS.1",
      symbol: "GC=F",
      assetClass: "commodity_future",
      assetSubtype: "continuous_front",
      venue: { code: "CMX", mic: "XCEC", kind: "futures_exchange" },
      providerSymbols: { yahoo: expect.objectContaining({ symbol: "GC=F" }) },
    });
    expect(client.instrument).toHaveBeenCalledWith(
      "FUTURE:CMX.GC.CONTINUOUS.1",
      expect.objectContaining({ providerSymbol: "GC=F" }),
    );
    experience.destroy();
  });

  it("starts from the workspace when no board is stored", async () => {
    const storage = memoryStorage();
    const client = fakeClient();
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
    });

    await settle(experience);

    expect(boardIds(experience)).toEqual([AAPL.id, MSFT.id]);
    expect(client.snapshot.mock.calls[0][0]).toEqual([AAPL.id, MSFT.id]);

    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("migrates only the exact legacy 24-name default to the new 40-name workspace", async () => {
    const legacyDefault = STARTER_WORKSPACE.instruments.slice(0, 24);
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: STARTER_WORKSPACE.id,
        instruments: legacyDefault,
      },
    });
    const client = fakeClient({
      snapshot: vi.fn(async () => envelope([])),
    });
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      workspace: STARTER_WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
    });

    await settle(experience);
    expect(boardIds(experience)).toEqual(STARTER_WORKSPACE.instrumentIds);
    expect(boardIds(experience)).toHaveLength(40);
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens and closes the add-instrument dialog island without leaking timers", async () => {
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      storage: memoryStorage(),
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);

    expect(isAddModalOpen(root)).toBe(false);
    await openAddDialog(experience);
    expect(isAddModalOpen(root)).toBe(true);
    expect(root.querySelector("#add-ticker-input")).not.toBeNull();
    experience.closeAddTickerModal();
    expect(isAddModalOpen(root)).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("searches globally, validates additions, then removes, clears, and restores", async () => {
    const storage = memoryStorage();
    const client = fakeClient();
    const onBoardChange = vi.fn();
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      persistTheme: false,
      onBoardChange,
      reactIslands: ISLANDS,
    });
    await settle(experience);

    await openAddDialog(experience);
    expect(addCountText(root)).toBe("1 / 60");
    const results = await experience.searchInstruments("tesla", { assetClass: "equity" });

    expect(client.search).toHaveBeenCalledWith("tesla", expect.objectContaining({
      assetClass: "equity",
      includeUnsupported: true,
      limit: 20,
      signal: expect.any(AbortSignal),
    }));
    expect(results.map(({ id }) => id)).toEqual([TSLA.id]);
    const rows = resultRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.instrumentId).toBe(TSLA.id);
    expect(rows[0].textContent).not.toContain("Bitcoin");

    const firstBoardChange = new Promise((resolve) => {
      onBoardChange.mockImplementationOnce(resolve);
    });
    const addButton = rowButton(rows[0]);
    addButton.click();
    expect(rowButton(resultRows(root)[0]).disabled).toBe(true);
    expect(rowButton(resultRows(root)[0]).textContent).toBe("Validating…");
    await firstBoardChange;
    await Promise.resolve();

    expect(client.instrument).toHaveBeenCalledWith(TSLA.id, expect.anything());
    expect(client.profile).not.toHaveBeenCalled();
    expect(boardIds(experience)).toEqual([AAPL.id, TSLA.id]);
    expect(isAddModalOpen(root)).toBe(false);
    expect(persistedActiveBoard(storage).instruments.map(({ id }) => id)).toEqual([
      AAPL.id,
      TSLA.id,
    ]);

    expect(experience.removeInstrument(TSLA.id)).toBe(true);
    expect(boardIds(experience)).toEqual([AAPL.id]);
    expect(experience.removeInstrument(TSLA.id)).toBe(false);

    experience.clearAllTickers();
    expect(boardIds(experience)).toEqual([]);
    expect(persistedActiveBoard(storage).instruments).toEqual([]);

    experience.restoreDefaultTickers();
    expect(boardIds(experience)).toEqual([AAPL.id]);
    expect(persistedActiveBoard(storage).instruments).toEqual([
      expect.objectContaining({ id: AAPL.id, symbol: "AAPL" }),
    ]);
    expect(onBoardChange).toHaveBeenCalledTimes(4);
    persistedActiveBoard(storage).instruments.forEach((instrument) => {
      expect(instrument).not.toHaveProperty("price");
      expect(instrument).not.toHaveProperty("change");
      expect(instrument).not.toHaveProperty("quote");
      expect(instrument).not.toHaveProperty("basePrice");
    });
    await vi.runOnlyPendingTimersAsync();
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders an unknown venue as disabled instead of offering Add", async () => {
    const unsupported = {
      instrument: null,
      candidate: {
        providerSymbol: "OMV.VI",
        name: "OMV AG",
        assetClass: "equity",
        venue: { code: "VIE", name: "Vienna", mic: null, kind: "unknown" },
        currency: "EUR",
      },
      mappingStatus: "unsupported",
      addable: false,
      reasonCode: "unsupported_venue",
    };
    const client = fakeClient({ search: vi.fn(async () => envelope([unsupported])) });
    const experience = createMarketMapExperience({
      root: fullShell(),
      instruments: [AAPL],
      storage: memoryStorage(),
      client,
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);
    await openAddDialog(experience);
    await experience.searchInstruments("omv");

    const row = resultRows(experience.root)[0];
    expect(row.textContent).toContain("Unsupported venue");
    expect(rowButton(row)).toMatchObject({ disabled: true, textContent: "Unavailable" });
    expect(client.instrument).toHaveBeenCalledTimes(1);
    expect(client.instrument).toHaveBeenCalledWith(AAPL.id, expect.any(Object));
    experience.destroy();
  });

  it("supports a host feature-policy rollback without deleting the board", async () => {
    const root = fullShell();
    const client = fakeClient({
      search: vi.fn(async () => envelope([searchRow(BTC, true)])),
      instrument: vi.fn(async () => envelope({
        instrument: v2Descriptor(BTC),
        capabilities: { quote: { status: "supported" } },
        addable: true,
        reasonCode: null,
      })),
    });
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      enabledAssetClasses: ["equity"],
      storage: memoryStorage(),
      client,
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);

    expect(experience.enabledAssetClasses).toEqual(["equity"]);
    await openAddDialog(experience);
    await experience.searchInstruments("bitcoin");
    expect(resultRows(root)[0].textContent).toContain("Not enabled");
    expect(rowButton(resultRows(root)[0]).disabled).toBe(true);
    experience.closeAddTickerModal();
    await expect(experience.addInstrument(BTC)).resolves.toBe(false);
    expect(boardIds(experience)).toEqual([AAPL.id]);
    expect(client.instrument).toHaveBeenCalledTimes(2);
    experience.destroy();
  });

  it("keeps intrinsically unsupported single bonds visible with their specific reason", async () => {
    const bond = {
      candidate: { providerSymbol: "US91282", name: "US Treasury", assetClass: "bond" },
      instrument: null,
      mappingStatus: "unsupported",
      addable: false,
      reasonCode: "single_bond_unsupported",
    };
    const experience = createMarketMapExperience({
      root: fullShell(),
      instruments: [AAPL],
      storage: memoryStorage(),
      client: fakeClient({ search: vi.fn(async () => envelope([bond])) }),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);

    await openAddDialog(experience);
    await experience.searchInstruments("treasury");

    expect(resultRows(experience.root)[0].textContent)
      .toContain("Single bonds not supported");
    expect(rowButton(resultRows(experience.root)[0]).disabled).toBe(true);
    experience.destroy();
  });

  it("rehydrates and preserves an oversized persisted board while allowing reductions", async () => {
    const instruments = Array.from({ length: 21 }, (_, index) => ({
      ...AAPL,
      id: `XNAS:T${String(index).padStart(2, "0")}`,
      symbol: `T${String(index).padStart(2, "0")}`,
      name: `Test ${index}`,
    }));
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD_V2]: {
        schemaVersion: 2,
        workspaceId: WORKSPACE.id,
        instruments,
      },
    });
    const experience = createMarketMapExperience({
      root: fullShell(),
      workspace: WORKSPACE,
      maxBoardSize: 20,
      storage,
      client: fakeClient({ snapshot: vi.fn(async () => envelope([])) }),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });

    await settle(experience);
    expect(boardIds(experience)).toHaveLength(21);
    expect(experience.openAddTickerModal()).toBe(false);
    expect(experience.removeInstrument(instruments[0].id)).toBe(true);
    expect(boardIds(experience)).toHaveLength(20);
    experience.destroy();
  });

  it("enforces default 60 and custom 20/80 board limits without silent explicit truncation", async () => {
    const assets = Array.from({ length: 61 }, (_, index) => ({
      ...AAPL,
      id: `XNAS:T${String(index).padStart(2, "0")}`,
      symbol: `T${String(index).padStart(2, "0")}`,
      name: `Test ${index}`,
    }));
    const quietClient = fakeClient({
      snapshot: vi.fn(async () => envelope([])),
      historyBatch: vi.fn(async () => envelope([])),
    });

    expect(() => createMarketMapExperience({
      root: fullShell(),
      instruments: assets,
      storage: memoryStorage(),
      client: quietClient,
      refreshPolicy: "manual",
      persistTheme: false,
    })).toThrow("at most 60");
    expect(() => createMarketMapExperience({
      root: fullShell(),
      instruments: assets.slice(0, 21),
      maxBoardSize: 20,
      storage: memoryStorage(),
      client: quietClient,
      refreshPolicy: "manual",
      persistTheme: false,
    })).toThrow("at most 20");
    expect(() => createMarketMapExperience({
      root: fullShell(),
      instruments: Array.from({ length: 101 }, (_, index) => ({
        ...AAPL,
        id: `XNAS:H${index}`,
        symbol: `H${index}`,
      })),
      maxBoardSize: 100,
      storage: memoryStorage(),
      client: quietClient,
      refreshPolicy: "manual",
      persistTheme: false,
    })).toThrow("at most 100");

    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      instruments: assets,
      maxBoardSize: 80,
      storage: memoryStorage(),
      client: quietClient,
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);
    expect(boardIds(experience)).toHaveLength(61);
    await openAddDialog(experience);
    expect(addCountText(root)).toBe("61 / 80");
    experience.destroy();
  });

  it("keeps Add instrument available after clearing and adding the first instrument", async () => {
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      storage: memoryStorage(),
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: ISLANDS,
    });
    await settle(experience);

    experience.clearAllTickers();
    expect(root.querySelectorAll(".asset-tile:not(.add-tile)")).toHaveLength(0);
    expect(root.querySelector(".add-tile")).toBeNull();
    expect(root.querySelector("#add-instrument-btn")).not.toBeNull();

    await expect(experience.addInstrument(TSLA)).resolves.toBe(true);
    const grid = root.querySelector("#marketmap");
    expect(root.querySelectorAll(".asset-tile:not(.add-tile)")).toHaveLength(1);
    expect(root.querySelector(".add-tile")).toBeNull();
    expect(grid.classList.contains("single-tile-mode")).toBe(false);
    expect(experience.openAddTickerModal()).toBe(true);

    experience.closeAddTickerModal();
    await vi.runOnlyPendingTimersAsync();
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scopes theme and overlay state, aborts modal work, and remounts cleanly", async () => {
    const storage = memoryStorage();
    const client = fakeClient();
    const setScrollLocked = vi.fn();
    const onOverlayChange = vi.fn();
    const onThemeRequest = vi.fn();
    const root = fullShell({ themeControl: false });
    const first = createMarketMapExperience({
      root,
      instruments: [AAPL],
      workspace: WORKSPACE,
      storage,
      client,
      refreshPolicy: "manual",
      theme: "dark",
      persistTheme: false,
      themeControl: false,
      setScrollLocked,
      onOverlayChange,
      onThemeRequest,
      reactIslands: { mountAssetGrid, mountInstrumentDetail },
    });
    await settle(first);

    expect(root.querySelector("#theme-btn")).toBeNull();
    expect(first.setTheme("light")).toBe(true);
    expect(root.dataset.marketmapTheme).toBe("light");
    expect(onThemeRequest).toHaveBeenLastCalledWith("light");
    expect(document.body.dataset.theme).toBe("site");
    expect(first.pause("host-test")).toBe(true);
    expect(first.resume("host-test")).toBe(true);

    root.querySelector(".asset-tile:not(.add-tile)").click();
    expect(first.views.modalView.isOpen()).toBe(true);
    expect(root.querySelector("#instrument-detail-dialog")).not.toBeNull();
    expect(setScrollLocked).toHaveBeenLastCalledWith(true);
    expect(onOverlayChange).toHaveBeenLastCalledWith(true);
    first.views.modalView.closeModal();
    expect(first.views.modalView.isOpen()).toBe(false);
    expect(setScrollLocked).toHaveBeenLastCalledWith(false);
    expect(onOverlayChange).toHaveBeenLastCalledWith(false);

    first.destroy();
    first.destroy();
    expect(root.dataset.marketmapMounted).toBeUndefined();
    expect(root.dataset.marketmapTheme).toBeUndefined();
    expect(root.classList.contains("marketmap-app")).toBe(false);
    expect(first.resume("host-test")).toBe(false);
    expect(first.setTheme("dark")).toBe(false);
    expect(root.dataset.marketmapTheme).toBeUndefined();
    await vi.runOnlyPendingTimersAsync();
    expect(vi.getTimerCount()).toBe(0);

    const second = createMarketMapExperience({
      root,
      instruments: [AAPL],
      workspace: WORKSPACE,
      storage,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid },
    });
    await settle(second);
    expect(root.querySelectorAll(".asset-tile:not(.add-tile)")).toHaveLength(1);
    second.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores host design-system attributes and overlay state during teardown", async () => {
    const root = fullShell();
    root.dataset.theme = "host-light";
    const setScrollLocked = vi.fn();
    const onOverlayChange = vi.fn();
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      storage: memoryStorage(),
      client: fakeClient(),
      refreshPolicy: "manual",
      theme: "dark",
      persistTheme: false,
      setScrollLocked,
      onOverlayChange,
    });
    await settle(experience);

    experience.views.modalView.showAssetDetails(0);
    expect(onOverlayChange).toHaveBeenLastCalledWith(true);
    experience.destroy();

    expect(setScrollLocked).toHaveBeenLastCalledWith(false);
    expect(onOverlayChange).toHaveBeenLastCalledWith(false);
    expect(root.dataset.theme).toBe("host-light");
    expect(root.hasAttribute("data-ds-root")).toBe(false);
  });

  it("rejects duplicate and incomplete mounts without installing a lifecycle", async () => {
    const storage = memoryStorage();
    const root = fullShell();
    const experience = createMarketMapExperience({
      root,
      instruments: [AAPL],
      storage,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
    });

    expect(() => createMarketMapExperience({
      root,
      instruments: [AAPL],
      storage,
      client: fakeClient(),
    })).toThrow("already mounted");

    await settle(experience);
    experience.destroy();
    expect(vi.getTimerCount()).toBe(0);

    document.body.innerHTML = '<main data-incomplete-root></main>';
    const incomplete = document.querySelector("[data-incomplete-root]");
    expect(() => createMarketMapExperience({ root: incomplete, storage })).toThrow(
      "must contain #marketmap",
    );
    expect(incomplete.dataset.marketmapMounted).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
