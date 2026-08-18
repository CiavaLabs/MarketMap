// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_SCHEMA_VERSION, createMarketMapExperience } from "../src/app/createMarketMapExperience.js";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { CONFIG } from "../src/config.js";
import { STARTER_WORKSPACE } from "../src/data/workspaces.js";
import { mountAssetGrid } from "../src/react/assetGrid.entry.jsx";
import { mountToastHost } from "../src/react/toastHost.entry.jsx";

const WORKSPACE = STARTER_WORKSPACE;
const AS_OF = "2026-07-13T14:30:00.000Z";

const instrument = (id, patch = {}) => ({
  id,
  symbol: id.split(":").at(-1),
  name: `${id} Inc.`,
  assetClass: "equity",
  exchange: "Nasdaq",
  mic: id.split(":")[0],
  currency: "USD",
  status: "active",
  ...patch,
});

const AAPL = instrument("XNAS:AAPL");
const MSFT = instrument("XNAS:MSFT");

const envelope = (data) => ({
  data,
  meta: { apiVersion: "v1", schemaVersion: 2, generatedAt: AS_OF, nextRefreshAt: null },
});

const quote = (item) => ({
  instrumentId: item.id,
  price: 100,
  change: 1,
  changePercent: 1,
  previousClose: 99,
  open: 99,
  dayHigh: 101,
  dayLow: 98,
  bid: null,
  ask: null,
  volume: 1_000,
  averageVolume3m: 900,
  marketState: "regular",
  asOf: AS_OF,
  fetchedAt: AS_OF,
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
});

function fakeClient(overrides = {}) {
  return {
    apiBaseUrl: "/api/market/v1",
    snapshot: vi.fn(async (ids) => envelope(ids.map((id) => quote({ id })))),
    profile: vi.fn(async (id) => envelope({ instrument: instrument(id), metrics: [], source: "yahoo" })),
    history: vi.fn(async (id, options = {}) => envelope({
      instrumentId: id,
      range: options.range || "1d",
      interval: options.interval || "5m",
      bars: [],
    })),
    search: vi.fn(async () => envelope([])),
    instrument: vi.fn(async (id) => envelope({
      instrument: instrument(id),
      capabilities: { quote: { status: "supported" } },
      addable: true,
      reasonCode: null,
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

function shell() {
  document.body.innerHTML = "<main data-marketmap-root></main>";
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false });
  return root;
}

const live = [];

function experience(options = {}) {
  const built = createMarketMapExperience({
    root: shell(),
    workspace: WORKSPACE,
    client: fakeClient(),
    refreshPolicy: "manual",
    persistTheme: false,
    reactIslands: { mountAssetGrid },
    ...options,
  });
  live.push(built);
  return built;
}

async function settle(built) {
  await built.ready;
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

const boardIds = (built) => built.getState().board.map(({ id }) => id);
const boardNames = (built) => built.getState().boards.map(({ name }) => name);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  while (live.length) live.pop().destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("experience configuration", () => {
  it.each([
    ["an empty list", []],
    ["a value that is not an array", "equity"],
    ["null", null],
  ])("refuses %s of enabled asset classes", (_label, enabledAssetClasses) => {
    expect(() => experience({ enabledAssetClasses })).toThrowError(/non-empty array/u);
  });

  it("refuses an asset class the build does not ship", () => {
    expect(() => experience({ enabledAssetClasses: ["equity", "warrant"] }))
      .toThrowError(/must be a subset of/u);
  });

  it("accepts a deduplicated subset", async () => {
    const built = experience({ enabledAssetClasses: ["equity", "equity"] });
    await settle(built);
    expect(built.getState().board.length).toBeGreaterThan(0);
  });
});

describe("storage resilience", () => {
  it("falls back to the workspace when the stored board is unreadable", async () => {
    const storage = memoryStorage();
    storage.getItem = vi.fn(() => "{ not json");
    const built = experience({ storage });
    await settle(built);

    expect(boardIds(built)).toEqual([...WORKSPACE.instrumentIds]);
  });

  it("falls back when reading storage throws outright", async () => {
    const storage = memoryStorage();
    storage.getItem = vi.fn(() => { throw new Error("storage disabled"); });
    const built = experience({ storage });
    await settle(built);

    expect(boardIds(built)).toEqual([...WORKSPACE.instrumentIds]);
  });

  it("keeps working when writing to storage throws", async () => {
    const storage = memoryStorage();
    storage.setItem = vi.fn(() => { throw new Error("quota exceeded"); });
    const built = experience({ storage });
    await settle(built);

    expect(boardIds(built).length).toBeGreaterThan(0);
  });

  it("works with no storage at all", async () => {
    const built = experience({ storage: null });
    await settle(built);
    expect(boardIds(built)).toEqual([...WORKSPACE.instrumentIds]);
  });

  it.each([
    ["a schema version from another release", { schemaVersion: 99, boards: [] }],
    ["boards that are not an array", { schemaVersion: BOARD_SCHEMA_VERSION, boards: {} }],
    ["a payload that is not an object", "boards"],
  ])("ignores a stored collection with %s", async (_label, saved) => {
    const storage = memoryStorage({ [CONFIG.STORAGE.BOARDS_V3]: saved });
    const built = experience({ storage });
    await settle(built);

    expect(boardIds(built)).toEqual([...WORKSPACE.instrumentIds]);
  });
});

describe("stored board collections", () => {
  const collection = (boards) => ({
    schemaVersion: BOARD_SCHEMA_VERSION,
    activeBoardId: boards[0]?.id,
    boards,
  });

  it.each([
    ["a blank id", { id: "  ", instruments: [AAPL] }],
    ["an over-long id", { id: "b".repeat(101), instruments: [AAPL] }],
    ["instruments that are not an array", { id: "b1", instruments: "AAPL" }],
    ["only unreadable instruments", { id: "b1", instruments: [{ id: "nope" }] }],
  ])("drops a stored board with %s", async (_label, board) => {
    const storage = memoryStorage({ [CONFIG.STORAGE.BOARDS_V3]: collection([board]) });
    const built = experience({ storage });
    await settle(built);

    expect(boardIds(built)).toEqual([...WORKSPACE.instrumentIds]);
  });

  it("keeps a board that legitimately holds nothing", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([
        { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
        { id: "empty", name: "Empty", instruments: [] },
      ]),
    });
    const built = experience({ storage });
    await settle(built);

    expect(boardNames(built)).toContain("Empty");
  });

  it("drops a repeated board id", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([
        { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
        { id: "twin", name: "Twin", instruments: [MSFT] },
        { id: "twin", name: "Twin again", instruments: [AAPL] },
      ]),
    });
    const built = experience({ storage });
    await settle(built);

    expect(built.getState().boards).toHaveLength(2);
  });

  it("resolves a name collision rather than showing two identical boards", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([
        { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
        { id: "a", name: "Watchlist", instruments: [MSFT] },
        { id: "b", name: "watchlist", instruments: [AAPL] },
        { id: "c", name: "Watchlist", instruments: [MSFT] },
      ]),
    });
    const built = experience({ storage });
    await settle(built);

    const names = boardNames(built);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => /\(\d+\)$/u.test(name))).toHaveLength(2);
  });

  it("names an unnamed board after its position", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([
        { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
        { id: "unnamed", instruments: [MSFT] },
      ]),
    });
    const built = experience({ storage });
    await settle(built);

    expect(boardNames(built).some((name) => /^Board \d+$/u.test(name))).toBe(true);
  });

  it("restores the workspace board when the collection declares no default", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([{ id: "only", name: "Only", instruments: [MSFT] }]),
    });
    const built = experience({ storage });
    await settle(built);

    const { boards } = built.getState();
    expect(boards.some((board) => board.name === WORKSPACE.name)).toBe(true);
    expect(boards).toHaveLength(2);
  });

  it("treats the board carrying the workspace id as the default", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: collection([
        { id: "other", name: "Other", instruments: [MSFT] },
        { id: WORKSPACE.id, name: "Renamed", instruments: [AAPL] },
      ]),
    });
    const built = experience({ storage });
    await settle(built);

    expect(boardNames(built)).toContain(WORKSPACE.name);
    expect(boardNames(built)).not.toContain("Renamed");
  });
});

describe("instrument canonicalization", () => {
  const boardOf = async (instruments) => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: { schemaVersion: 1, workspaceId: WORKSPACE.id, instruments },
    });
    const built = experience({
      storage,
      client: fakeClient({ instrument: vi.fn(async () => envelope({})) }),
    });
    await settle(built);
    return built;
  };

  it.each([
    ["a non-canonical id", { id: "AAPL", symbol: "AAPL" }],
    ["no id at all", { symbol: "AAPL" }],
    ["a blank symbol on an id with no suffix", { id: "XNAS:", symbol: "  " }],
  ])("drops an instrument with %s", async (_label, candidate) => {
    const built = await boardOf([candidate, AAPL]);
    expect(boardIds(built)).toEqual([AAPL.id]);
  });

  it("takes the symbol from the id when the record omits it", async () => {
    const built = await boardOf([{ id: "XNAS:AAPL" }]);
    expect(built.getState().board[0]).toMatchObject({ id: "XNAS:AAPL", symbol: "AAPL" });
  });

  it("drops a repeated instrument", async () => {
    const built = await boardOf([AAPL, AAPL, MSFT]);
    expect(boardIds(built)).toEqual([AAPL.id, MSFT.id]);
  });

  it.each([
    ["INDEX:^GSPC", "index"],
    ["FX:EURUSD", "fx"],
    ["CRYPTO:BTC-USD", "crypto"],
    ["FUTURE:CMX.GC.CONTINUOUS.1", "commodity_future"],
    ["RATE:^TNX", "rate_index"],
    ["XNAS:AAPL", "equity"],
  ])("infers %s as %s", async (id, assetClass) => {
    const built = await boardOf([{ id, symbol: id.split(":").at(-1) }]);
    expect(built.getState().board[0].assetClass).toBe(assetClass);
  });

  it("keeps an explicitly stated asset class over the inferred one", async () => {
    const built = await boardOf([{ id: "XNAS:SPY", symbol: "SPY", assetClass: "etf" }]);
    expect(built.getState().board[0].assetClass).toBe("etf");
  });

  it("never persists live quote data back into storage", async () => {
    const storage = memoryStorage();
    const built = experience({ storage });
    await settle(built);

    const saved = storage.read(CONFIG.STORAGE.BOARDS_V3);
    const persisted = saved.boards.flatMap((board) => board.instruments);
    for (const record of persisted) {
      expect(record).not.toHaveProperty("price");
      expect(record).not.toHaveProperty("capabilities");
      expect(record).not.toHaveProperty("addable");
      expect(record).not.toHaveProperty("reasonCode");
    }
  });
});

describe("work in flight across a board switch", () => {
  const twoBoards = () => ({
    schemaVersion: BOARD_SCHEMA_VERSION,
    activeBoardId: WORKSPACE.id,
    boards: [
      { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
      { id: "second", name: "Second", instruments: [MSFT] },
    ],
  });

  it("drops a validated addition whose board is no longer active", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const storage = memoryStorage({ [CONFIG.STORAGE.BOARDS_V3]: twoBoards() });
    const built = experience({
      storage,
      client: fakeClient({
        instrument: vi.fn(async (id) => {
          if (id === "XNAS:NVDA") await gate;
          return envelope({ instrument: instrument(id), addable: true, reasonCode: null });
        }),
      }),
    });
    await settle(built);

    const pending = built.addInstrument({ id: "XNAS:NVDA", symbol: "NVDA" });
    built.switchBoard("second");
    release();
    await vi.runOnlyPendingTimersAsync();

    expect(await pending).toBe(false);
    expect(boardIds(built)).toEqual([MSFT.id]);
    built.switchBoard(WORKSPACE.id);
    expect(boardIds(built)).toEqual([AAPL.id]);
  });

  it("keeps an addition that stays on its own board", async () => {
    const storage = memoryStorage({ [CONFIG.STORAGE.BOARDS_V3]: twoBoards() });
    const built = experience({ storage });
    await settle(built);

    expect(await built.addInstrument({ id: "XNAS:NVDA", symbol: "NVDA" })).toBe(true);
    expect(boardIds(built)).toContain("XNAS:NVDA");
  });

  it("opens a stored board that is over the host limit, and still refuses to grow it", async () => {
    const oversized = Array.from({ length: 5 }, (_, index) => instrument(`XNAS:B${index}`));
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: {
        schemaVersion: BOARD_SCHEMA_VERSION,
        activeBoardId: WORKSPACE.id,
        boards: [
          { id: WORKSPACE.id, isDefault: true, instruments: [AAPL] },
          { id: "big", name: "Big", instruments: oversized },
        ],
      },
    });
    const built = experience({ storage, maxBoardSize: 2 });
    await settle(built);

    expect(built.switchBoard("big")).toBe(true);
    expect(boardIds(built)).toEqual(oversized.map(({ id }) => id));
    expect(built.getState().activeBoardId).toBe("big");
    expect(storage.read(CONFIG.STORAGE.BOARDS_V3).activeBoardId).toBe("big");

    expect(await built.addInstrument({ id: "XNAS:NVDA", symbol: "NVDA" })).toBe(false);
    expect(boardIds(built)).toEqual(oversized.map(({ id }) => id));
    expect(built.removeInstrument(oversized[0].id)).toBe(true);
    expect(boardIds(built)).toEqual(oversized.slice(1).map(({ id }) => id));
  });

  it("keeps boards and the active board in step when a delete falls back to an oversized board", async () => {
    const oversized = Array.from({ length: 5 }, (_, index) => instrument(`XNAS:B${index}`));
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: {
        schemaVersion: BOARD_SCHEMA_VERSION,
        activeBoardId: "small",
        boards: [
          { id: WORKSPACE.id, isDefault: true, instruments: oversized },
          { id: "small", name: "Small", instruments: [AAPL] },
        ],
      },
    });
    const built = experience({ storage, maxBoardSize: 2 });
    await settle(built);

    expect(built.deleteBoard("small")).toEqual({ ok: true });
    const state = built.getState();
    expect(state.activeBoardId).toBe(WORKSPACE.id);
    expect(state.boards.map(({ id }) => id)).toEqual([WORKSPACE.id]);
    expect(storage.read(CONFIG.STORAGE.BOARDS_V3).boards.map(({ id }) => id))
      .toEqual([WORKSPACE.id]);
  });

  it("switches to and persists a duplicate of an oversized board", async () => {
    const oversized = Array.from({ length: 5 }, (_, index) => instrument(`XNAS:B${index}`));
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: {
        schemaVersion: BOARD_SCHEMA_VERSION,
        activeBoardId: "small",
        boards: [
          { id: WORKSPACE.id, isDefault: true, instruments: oversized },
          { id: "small", name: "Small", instruments: [AAPL] },
        ],
      },
    });
    const built = experience({ storage, maxBoardSize: 2 });
    await settle(built);

    const result = built.duplicateBoard(WORKSPACE.id);
    expect(result.ok).toBe(true);
    expect(built.getState().activeBoardId).toBe(result.board.id);
    expect(storage.read(CONFIG.STORAGE.BOARDS_V3).boards.map(({ id }) => id))
      .toContain(result.board.id);
  });
});

describe("edits made while descriptor hydration is pending", () => {
  const hydrating = () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: WORKSPACE.id,
        instruments: [{ id: AAPL.id, symbol: "AAPL" }, { id: MSFT.id, symbol: "MSFT" }],
      },
    });
    const resolver = vi.fn(async (id) => {
      if (id === AAPL.id || id === MSFT.id) await gate;
      return envelope({ instrument: instrument(id), addable: true, reasonCode: null });
    });
    const built = experience({ storage, client: fakeClient({ instrument: resolver }) });
    return {
      built,
      storage,
      async open() {
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
        expect(resolver).toHaveBeenCalled();
      },
      async finish() {
        release();
        await settle(built);
      },
    };
  };

  it("keeps an instrument added while the resolver was running", async () => {
    const { built, open, finish } = hydrating();
    await open();

    await built.addInstrument({ id: "XNAS:NVDA", symbol: "NVDA" });
    await finish();

    expect(boardIds(built)).toEqual([AAPL.id, MSFT.id, "XNAS:NVDA"]);
  });

  it("does not resurrect an instrument removed while the resolver was running", async () => {
    const { built, open, finish } = hydrating();
    await open();

    await built.removeInstrument(MSFT.id);
    await finish();

    expect(boardIds(built)).toEqual([AAPL.id]);
  });

  it("persists the board the user actually left behind", async () => {
    const { built, storage, open, finish } = hydrating();
    await open();

    await built.removeInstrument(MSFT.id);
    await finish();

    const saved = storage.read(CONFIG.STORAGE.BOARDS_V3);
    const active = saved.boards.find((board) => board.id === saved.activeBoardId);
    expect(active.instruments.map(({ id }) => id)).toEqual([AAPL.id]);
  });
});

describe("board callbacks and restoration", () => {
  it("tells the host about an order changed by a drag", async () => {
    const onBoardChange = vi.fn();
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: WORKSPACE.id,
        instruments: [AAPL, MSFT],
      },
    });
    const built = experience({ storage, onBoardChange });
    await settle(built);
    onBoardChange.mockClear();

    await built.reorderBoard({ itemId: MSFT.id, beforeId: AAPL.id });

    expect(onBoardChange).toHaveBeenCalledOnce();
    expect(onBoardChange.mock.calls[0][0].map(({ id }) => id)).toEqual([MSFT.id, AAPL.id]);
  });

  it("restores an oversized board from the clear undo", async () => {
    const oversized = Array.from({ length: 5 }, (_, index) => instrument(`XNAS:B${index}`));
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARD]: {
        schemaVersion: 1,
        workspaceId: WORKSPACE.id,
        instruments: oversized,
      },
    });
    const root = shell();
    const built = createMarketMapExperience({
      root,
      workspace: WORKSPACE,
      storage,
      maxBoardSize: 3,
      client: fakeClient(),
      refreshPolicy: "manual",
      persistTheme: false,
      reactIslands: { mountAssetGrid, mountToastHost },
    });
    live.push(built);
    await settle(built);
    expect(boardIds(built)).toHaveLength(5);

    expect(built.clearAllTickers()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(boardIds(built)).toEqual([]);

    const undo = [...root.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Undo");
    expect(undo).toBeTruthy();
    undo.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(boardIds(built)).toHaveLength(5);
  });

  it("keeps a sector the runtime discovered across a board switch", async () => {
    const storage = memoryStorage({
      [CONFIG.STORAGE.BOARDS_V3]: {
        schemaVersion: BOARD_SCHEMA_VERSION,
        activeBoardId: WORKSPACE.id,
        boards: [
          { id: WORKSPACE.id, isDefault: true, instruments: [{ id: AAPL.id, symbol: "AAPL" }] },
          { id: "second", name: "Second", instruments: [MSFT] },
        ],
      },
    });
    const built = experience({ storage });
    await settle(built);
    expect(built.getState().board[0].sector).toBeUndefined();

    built.app.applyInstrumentEnrichment(AAPL.id, { sector: "Technology" });
    await settle(built);
    expect(built.getState().board[0].sector).toBe("Technology");

    built.switchBoard("second");
    built.switchBoard(WORKSPACE.id);
    await settle(built);

    expect(built.getState().board[0].sector).toBe("Technology");
  });
});
