import { createMarketMap } from "./createMarketMap.js";
import { CONFIG, normalizeMaxBoardSize } from "../config.js";
import {
  DEFAULT_WORKSPACE_ID,
  getWorkspace,
  STARTER_WORKSPACE,
} from "../data/workspaces.js";
import { Lifecycle } from "../core/Lifecycle.js";
import {
  DEFAULT_NEWS_POSITION,
  MAX_BOARD_NAME_LENGTH,
  moveBoardSequenceItem,
} from "../ui/models/boardLayout.js";
import { enrichmentFromDetails } from "../ui/models/instrumentEnrichment.js";
import { systemTheme } from "../utils/systemTheme.js";
import { displaySymbolOf } from "../ui/models/instrumentFormat.js";

const BOARD_SCHEMA_VERSION = 3;
const PREVIOUS_BOARD_SCHEMA_VERSION = 2;
const LEGACY_BOARD_SCHEMA_VERSION = 1;
const LEGACY_DEFAULT_BOARD_SIZE = 24;
const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 250;
const LEGACY_FUTURE_ID = "FUTURE:GC=F";
const GOLD_CONTINUOUS_ID = "FUTURE:CMX.GC.CONTINUOUS.1";
const SEARCH_REASON_LABELS = Object.freeze({
  unsupported_venue: "Unsupported venue",
  identity_ambiguous: "Identity ambiguous",
  identity_incomplete: "Identity incomplete",
  identity_provisional: "Identity unconfirmed",
  asset_class_disabled: "Not enabled",
  quote_unsupported: "Quote unavailable",
  unsupported_asset: "Not supported",
  single_bond_unsupported: "Single bonds not supported",
  unsupported_bond: "Single bonds not supported",
  single_bond: "Single bonds not supported",
});

const ADD_ASSET_CLASSES = Object.freeze([
  ["equity", "Equity"],
  ["etf", "ETF"],
  ["index", "Index"],
  ["fx", "FX"],
  ["crypto", "Crypto"],
  ["commodity_future", "Commodity future"],
  ["rate_index", "Rate index"],
]);

const ASSET_CLASS_TONE = Object.freeze({
  equity: "accent",
  etf: "gain",
  index: "violet",
  fx: "warn",
  crypto: "loss",
  commodity_future: "warn",
  rate_index: "violet",
});

function avatarToneFor(assetClass) {
  return ASSET_CLASS_TONE[assetClass] || "neutral";
}

function monogramOf(text) {
  return String(text || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneProviderSymbols(value) {
  if (!isObject(value)) return null;
  const mappings = {};
  for (const [provider, mapping] of Object.entries(value)) {
    if (typeof mapping === "string" && mapping.trim()) {
      mappings[provider] = mapping.trim();
    } else if (isObject(mapping) && typeof mapping.symbol === "string" && mapping.symbol.trim()) {
      mappings[provider] = { ...mapping, symbol: mapping.symbol.trim() };
    }
  }
  return Object.keys(mappings).length ? mappings : null;
}

function migrateLegacyBoardInstrument(candidate) {
  if (candidate?.id !== LEGACY_FUTURE_ID && candidate?.instrumentId !== LEGACY_FUTURE_ID) {
    return candidate;
  }
  const providerSymbols = isObject(candidate.providerSymbols)
    ? candidate.providerSymbols
    : {};
  const yahooMapping = typeof providerSymbols.yahoo === "string"
    ? { symbol: providerSymbols.yahoo, verified: false }
    : providerSymbols.yahoo;
  return {
    ...candidate,
    id: GOLD_CONTINUOUS_ID,
    displaySymbol: "GC",
    symbol: "GC=F",
    name: candidate.name || "Gold Futures (continuous front)",
    assetClass: "commodity_future",
    assetSubtype: "continuous_front",
    venue: { code: "CMX", name: "COMEX", mic: "XCEC", kind: "futures_exchange" },
    exchange: "COMEX",
    currency: candidate.currency || "USD",
    priceUnit: "currency",
    providerSymbols: {
      ...providerSymbols,
      yahoo: yahooMapping || { symbol: "GC=F", verified: false },
    },
  };
}

function inferredAssetClass(id) {
  const namespace = id.split(":", 1)[0];
  return {
    INDEX: "index",
    FX: "fx",
    CRYPTO: "crypto",
    FUTURE: "commodity_future",
    RATE: "rate_index",
  }[namespace] || "equity";
}

function canonicalInstrument(candidate) {
  const source = migrateLegacyBoardInstrument(candidate?.instrument || candidate);
  const id = source?.id || candidate?.instrumentId;
  const symbol = source?.symbol || candidate?.symbol || (typeof id === "string" ? id.split(":")[1] : null);
  if (
    typeof id !== "string"
    || !/^[A-Z0-9]{2,12}:[A-Z0-9^.=_-]+$/.test(id.trim())
    || typeof symbol !== "string"
    || !symbol.trim()
  ) {
    return null;
  }
  const providerSymbols = cloneProviderSymbols(source.providerSymbols);
  return {
    id: id.trim(),
    symbol: symbol.trim().toUpperCase(),
    ...(source.displaySymbol ? { displaySymbol: source.displaySymbol } : {}),
    name: source.name || symbol.trim().toUpperCase(),
    assetClass: source.assetClass || inferredAssetClass(id.trim()),
    ...(source.assetSubtype ? { assetSubtype: source.assetSubtype } : {}),
    ...(isObject(source.venue) ? { venue: { ...source.venue } } : {}),
    ...(source.exchange ? { exchange: source.exchange } : {}),
    ...(source.mic ? { mic: source.mic } : {}),
    ...(source.currency ? { currency: source.currency } : {}),
    ...(source.quoteCurrency ? { quoteCurrency: source.quoteCurrency } : {}),
    ...(source.baseCurrency ? { baseCurrency: source.baseCurrency } : {}),
    ...(source.priceUnit ? { priceUnit: source.priceUnit } : {}),
    ...(source.country ? { country: source.country } : {}),
    ...(source.sector ? { sector: source.sector } : {}),
    ...(source.category ? { category: source.category } : {}),
    ...(providerSymbols ? { providerSymbols } : {}),
    ...(isObject(source.capabilities) ? { capabilities: structuredClone(source.capabilities) } : {}),
    ...(typeof source.addable === "boolean" ? { addable: source.addable } : {}),
    ...(source.reasonCode ? { reasonCode: source.reasonCode } : {}),
    status: source.status || "unknown",
  };
}

function persistedInstrument(instrument) {
  const { capabilities, addable, reasonCode, ...descriptor } = instrument;
  return descriptor;
}

function normalizeSearchResult(candidate) {
  const instrument = canonicalInstrument(candidate);
  const provisional = isObject(candidate?.candidate) ? candidate.candidate : null;
  const quoteCapability = instrument?.capabilities?.quote;
  const quoteRequestable = !quoteCapability || quoteCapability.status !== "unsupported";
  return {
    instrument,
    candidate: provisional,
    mappingStatus: candidate?.mappingStatus || (instrument ? "resolved" : "unsupported"),
    addable: quoteRequestable
      && (typeof candidate?.addable === "boolean" ? candidate.addable : Boolean(instrument)),
    reasonCode: quoteRequestable ? candidate?.reasonCode || null : "quote_unsupported",
  };
}

function uniqueSearchResults(candidates, limit = 20) {
  const seen = new Set();
  const results = [];
  for (const candidate of candidates || []) {
    const result = normalizeSearchResult(candidate);
    const key = result.instrument?.id || result.candidate?.providerSymbol;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length >= limit) break;
  }
  return results;
}

function uniqueInstruments(candidates, limit = Number.POSITIVE_INFINITY) {
  const seen = new Set();
  const instruments = [];
  for (const candidate of candidates || []) {
    const instrument = canonicalInstrument(candidate);
    if (!instrument || seen.has(instrument.id)) continue;
    seen.add(instrument.id);
    instruments.push(instrument);
    if (instruments.length >= limit) break;
  }
  return instruments;
}

function normalizeEnabledAssetClasses(value = CONFIG.ENABLED_ASSET_CLASSES) {
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError("enabledAssetClasses must be a non-empty array");
  }
  const allowed = new Set(CONFIG.ENABLED_ASSET_CLASSES);
  const normalized = [...new Set(value.map((assetClass) => String(assetClass).trim()))];
  if (normalized.some((assetClass) => !allowed.has(assetClass))) {
    throw new RangeError(`enabledAssetClasses must be a subset of ${CONFIG.ENABLED_ASSET_CLASSES.join(", ")}`);
  }
  return Object.freeze(normalized);
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function resolveStorage(root, requested) {
  if (requested !== undefined) return requested;
  try {
    return root.ownerDocument.defaultView?.localStorage || null;
  } catch {
    return null;
  }
}

function boardInstrumentsFrom(saved, defaults, expectedVersion) {
  if (!isObject(saved) || saved.schemaVersion !== expectedVersion || !Array.isArray(saved.instruments)) {
    return null;
  }
  const instruments = uniqueInstruments(saved.instruments);
  if (!instruments.length && saved.instruments.length !== 0) return null;
  const isLegacyDefault = instruments.length === LEGACY_DEFAULT_BOARD_SIZE
    && defaults.length > LEGACY_DEFAULT_BOARD_SIZE
    && instruments.every((instrument, index) => instrument.id === defaults[index]?.id);
  return isLegacyDefault ? defaults : instruments;
}

function normalizedBoardLayout(candidate, instrumentCount) {
  const source = isObject(candidate) ? candidate : {};
  const requestedPosition = Number(source.newsPosition);
  return {
    newsPosition: Number.isInteger(requestedPosition)
      ? Math.min(Math.max(0, requestedPosition), instrumentCount)
      : Math.min(DEFAULT_NEWS_POSITION, instrumentCount),
    newsOpen: source.newsOpen !== false,
  };
}

function reconciledBoardLayout(layout, previousInstruments, nextInstruments) {
  const beforeNews = new Set(
    previousInstruments
      .slice(0, layout.newsPosition)
      .map((instrument) => instrument.id),
  );
  return {
    ...layout,
    newsPosition: nextInstruments.filter((instrument) => beforeNews.has(instrument.id)).length,
  };
}

function normalizedBoardName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name && name.length <= MAX_BOARD_NAME_LENGTH ? name : null;
}

function sameBoardName(left, right) {
  return String(left).localeCompare(String(right), undefined, { sensitivity: "accent" }) === 0;
}

function availableBoardName(boards, requested) {
  const requestedName = String(requested || "").trim().replace(/\s+/g, " ");
  const base = (requestedName || "Untitled board").slice(0, MAX_BOARD_NAME_LENGTH).trimEnd();
  const taken = (candidate) => boards.some((board) => sameBoardName(board.name, candidate));
  if (!taken(base)) return base;
  let suffix = 2;
  while (true) {
    const ending = ` (${suffix})`;
    const candidate = `${base.slice(0, MAX_BOARD_NAME_LENGTH - ending.length).trimEnd()}${ending}`;
    if (!taken(candidate)) return candidate;
    suffix += 1;
  }
}

function defaultBoardRecord(workspace, instruments, layout) {
  return {
    id: workspace.id,
    name: workspace.name,
    workspaceId: workspace.id,
    isDefault: true,
    instruments,
    layout,
  };
}

function savedBoardCollection(saved, defaults, workspace) {
  if (!isObject(saved) || saved.schemaVersion !== BOARD_SCHEMA_VERSION || !Array.isArray(saved.boards)) {
    return null;
  }
  const seenIds = new Set();
  const boards = [];
  for (const candidate of saved.boards) {
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    if (!id || id.length > 100 || seenIds.has(id) || !Array.isArray(candidate.instruments)) continue;
    const instruments = uniqueInstruments(candidate.instruments);
    if (!instruments.length && candidate.instruments.length) continue;
    seenIds.add(id);
    boards.push({
      id,
      name: availableBoardName(boards, candidate.name || `Board ${boards.length + 1}`),
      workspaceId: candidate.workspaceId || workspace.id,
      isDefault: candidate.isDefault === true,
      instruments,
      layout: normalizedBoardLayout(candidate.layout, instruments.length),
    });
  }
  if (!boards.length) return null;

  let defaultIndex = boards.findIndex((board) => board.isDefault);
  if (defaultIndex < 0) defaultIndex = boards.findIndex((board) => board.id === workspace.id);
  if (defaultIndex < 0) {
    boards.unshift(defaultBoardRecord(
      workspace,
      defaults,
      normalizedBoardLayout(null, defaults.length),
    ));
    defaultIndex = 0;
  }
  boards.forEach((board, index) => {
    board.isDefault = index === defaultIndex;
    if (board.isDefault) board.name = workspace.name;
  });
  const named = [{ name: workspace.name }];
  boards.forEach((board) => {
    if (board.isDefault) return;
    board.name = availableBoardName(named, board.name);
    named.push(board);
  });

  const activeBoardId = boards.some((board) => board.id === saved.activeBoardId)
    ? saved.activeBoardId
    : boards[defaultIndex].id;
  const highestSequence = boards.reduce((highest, board) => {
    const match = /^board-(\d+)$/.exec(board.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return {
    boards,
    activeBoardId,
    nextBoardSequence: Math.max(
      Number.isInteger(saved.nextBoardSequence) ? saved.nextBoardSequence : 1,
      highestSequence + 1,
    ),
    migrated: false,
    hydrationBoardIds: boards.filter((board) => board.instruments.length).map((board) => board.id),
  };
}

function singleBoardCollection({
  workspace,
  instruments,
  layout,
  migrated,
  needsHydration,
}) {
  const board = defaultBoardRecord(workspace, instruments, layout);
  return {
    boards: [board],
    activeBoardId: board.id,
    nextBoardSequence: 1,
    migrated,
    hydrationBoardIds: needsHydration ? [board.id] : [],
  };
}

function loadPersistedBoards(storage, defaults, workspace) {
  const savedCollection = savedBoardCollection(
    readJson(storage, CONFIG.STORAGE.BOARDS_V3),
    defaults,
    workspace,
  );
  if (savedCollection) return savedCollection;

  const currentSaved = readJson(storage, CONFIG.STORAGE.BOARD_V2);
  const current = boardInstrumentsFrom(
    currentSaved,
    defaults,
    PREVIOUS_BOARD_SCHEMA_VERSION,
  );
  if (current !== null) {
    return singleBoardCollection({
      workspace,
      instruments: current,
      layout: normalizedBoardLayout(currentSaved.layout, current.length),
      migrated: true,
      needsHydration: current.length > 0,
    });
  }
  const legacySaved = readJson(storage, CONFIG.STORAGE.BOARD);
  const legacy = boardInstrumentsFrom(
    legacySaved,
    defaults,
    LEGACY_BOARD_SCHEMA_VERSION,
  );
  if (legacy !== null) {
    return singleBoardCollection({
      workspace,
      instruments: legacy,
      layout: normalizedBoardLayout(null, legacy.length),
      migrated: true,
      needsHydration: legacy.length > 0,
    });
  }
  return singleBoardCollection({
    workspace,
    instruments: defaults,
    layout: normalizedBoardLayout(null, defaults.length),
    migrated: false,
    needsHydration: defaults.length > 0,
  });
}

function resultRowDescriptor(candidate, alreadyAdded) {
  const result = normalizeSearchResult(candidate);
  const instrument = result.instrument;
  const display = instrument || result.candidate;
  const symbol = displaySymbolOf(display) || "Unknown";
  const subtitle = [
    display?.name && display.name !== symbol ? display.name : null,
    display?.assetClass,
    display?.venue?.name || display?.venue?.mic || display?.exchange || display?.mic,
    display?.currency,
    instrument?.country,
    result.reasonCode ? SEARCH_REASON_LABELS[result.reasonCode] || result.reasonCode.replaceAll("_", " ") : null,
  ].filter(Boolean).join(" · ");
  const unavailable = !instrument || !result.addable;
  return {
    id: instrument?.id || display?.providerSymbol || symbol,
    instrument,
    monogram: monogramOf(symbol),
    tone: avatarToneFor(display?.assetClass),
    title: symbol,
    subtitle,
    state: alreadyAdded ? "added" : unavailable ? "unavailable" : "add",
  };
}

export function createMarketMapExperience(options = {}) {
  const root = options.root;
  if (!root?.querySelector) {
    throw new TypeError("createMarketMapExperience requires a root Element");
  }
  if (root.dataset.marketmapMounted === "true") {
    throw new Error("MarketMap root is already mounted");
  }
  if (!root.querySelector("#marketmap")) {
    throw new Error("MarketMap root must contain #marketmap");
  }

  const document = root.ownerDocument;
  const window = document.defaultView;
  const lifecycle = new Lifecycle();
  const storage = resolveStorage(root, options.storage);
  const originalTheme = root.dataset.marketmapTheme;
  const originalDesignSystemTheme = root.getAttribute("data-theme");
  const originalDesignSystemRoot = root.getAttribute("data-ds-root");
  const hadMarketMapClass = root.classList.contains("marketmap-app");
  const workspace = options.workspace
    || getWorkspace(options.defaultWorkspace || DEFAULT_WORKSPACE_ID)
    || STARTER_WORKSPACE;
  const maxBoardSize = normalizeMaxBoardSize(options.maxBoardSize);
  const enabledAssetClasses = normalizeEnabledAssetClasses(options.enabledAssetClasses);
  const supplied = uniqueInstruments(options.instruments || workspace.instruments);
  if (options.instruments && supplied.length > maxBoardSize) {
    throw new RangeError(`This board accepts at most ${maxBoardSize} instruments.`);
  }
  const defaults = options.instruments ? supplied : supplied.slice(0, maxBoardSize);
  const persisted = options.instruments
    ? singleBoardCollection({
        workspace,
        instruments: defaults,
        layout: normalizedBoardLayout(options.layout, defaults.length),
        migrated: false,
        needsHydration: defaults.length > 0,
      })
    : loadPersistedBoards(storage, defaults, workspace);
  let boards = persisted.boards;
  let activeBoardId = persisted.activeBoardId;
  let nextBoardSequence = persisted.nextBoardSequence;
  const hydrationBoardIds = new Set(persisted.hydrationBoardIds);
  const initialBoard = boards.find((board) => board.id === activeBoardId) || boards[0];
  let instruments = initialBoard.instruments;
  let boardLayout = initialBoard.layout;
  let runtime = null;
  let destroyed = false;
  let searchController = null;
  let searchSequence = 0;
  let searchTimer = null;
  let recentlyRemoved = [];
  const activeOverlays = new Set();

  let addModalApi = null;
  let addModalOpen = false;
  let currentQuery = "";
  let shownRows = [];
  const searchFilters = { assetClass: "all", venue: "all", currency: "all" };
  const addAssetClassOptions = [
    { value: "all", label: "All asset classes" },
    ...ADD_ASSET_CLASSES.map(([value, label]) => ({
      value,
      label,
      disabled: !enabledAssetClasses.includes(value),
    })),
  ];

  function syncScrollLock() {
    options.setScrollLocked?.(activeOverlays.size > 0);
  }

  function setOverlay(name, active) {
    if (active) activeOverlays.add(name);
    else activeOverlays.delete(name);
    syncScrollLock();
    options.onOverlayChange?.(activeOverlays.size > 0);
  }

  function boardSummaries() {
    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      instrumentCount: board.instruments.length,
      isDefault: board.isDefault,
    }));
  }

  function currentBoardState() {
    return { boards: boardSummaries(), activeBoardId };
  }

  function syncBoardSwitcher() {
    const next = currentBoardState();
    runtime?.views?.controlBarView?.setBoardState(next);
    options.onBoardsChange?.({
      activeBoardId: next.activeBoardId,
      boards: next.boards.map((board) => ({ ...board })),
    });
  }

  function persistBoard() {
    const updatedAt = new Date().toISOString();
    boards = boards.map((board) => board.id === activeBoardId ? {
      ...board,
      instruments: [...instruments],
      layout: { ...boardLayout },
      updatedAt,
    } : board);
    return writeJson(storage, CONFIG.STORAGE.BOARDS_V3, {
      schemaVersion: BOARD_SCHEMA_VERSION,
      activeBoardId,
      nextBoardSequence,
      boards: boards.map((board) => ({
        id: board.id,
        name: board.name,
        workspaceId: board.workspaceId,
        isDefault: board.isDefault,
        instruments: board.instruments.map(persistedInstrument),
        layout: { ...board.layout },
        updatedAt: board.updatedAt || updatedAt,
      })),
      updatedAt,
    });
  }

  function notify(message, duration, action) {
    runtime?.app.notify(message, duration, action);
  }

  function renderSearchMessage(message) {
    shownRows = [];
    addModalApi?.setContent({ rows: [], heading: null, message });
  }

  function renderResultRows(rows, heading = null) {
    shownRows = rows;
    addModalApi?.setContent({ rows, heading, message: "" });
  }

  function renderBoardCount() {
    addModalApi?.setCount(`${instruments.length} / ${maxBoardSize}`);
  }

  function setRowState(id, state) {
    shownRows = shownRows.map((row) => (row.id === id ? { ...row, state } : row));
    addModalApi?.setContent({ rows: shownRows, heading: null, message: "" });
  }

  function renderInitialSuggestions() {
    const suggestions = recentlyRemoved.filter(
      (candidate) => !instruments.some((current) => current.id === candidate.id),
    );
    if (!suggestions.length) {
      renderSearchMessage("");
      return;
    }
    renderResultRows(suggestions.map((instrument) => resultRowDescriptor(instrument, false)), "Recently removed");
  }

  function abortSearch() {
    searchController?.abort();
    searchController = null;
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  }

  function openAddTickerModal() {
    if (destroyed) return false;
    if (instruments.length >= maxBoardSize) {
      notify(`This board already contains the maximum of ${maxBoardSize} instruments.`);
      return false;
    }
    currentQuery = "";
    addModalOpen = true;
    setOverlay("add", true);
    renderBoardCount();
    renderInitialSuggestions();
    addModalApi?.setOpen(true);
    return true;
  }

  function teardownAddModal() {
    if (!addModalOpen) return;
    addModalOpen = false;
    abortSearch();
    setOverlay("add", false);
  }

  function closeAddTickerModal() {
    teardownAddModal();
    addModalApi?.setOpen(false);
  }

  async function applyBoard(nextInstruments, updateOptions = {}) {
    if (destroyed) return instruments;
    const normalized = uniqueInstruments(nextInstruments);
    if (
      updateOptions.allowOversize !== true
      && normalized.length > maxBoardSize
      && normalized.length > instruments.length
    ) {
      throw new RangeError(`This board accepts at most ${maxBoardSize} instruments.`);
    }
    const previous = instruments;
    const previousLayout = boardLayout;
    const { layout: requestedLayout, ...runtimeOptions } = updateOptions;
    instruments = normalized;
    boardLayout = requestedLayout
      ? normalizedBoardLayout(requestedLayout, instruments.length)
      : reconciledBoardLayout(boardLayout, previous, instruments);
    runtime.updateInstruments(instruments, runtimeOptions);
    runtime.setLayoutState(boardLayout);
    persistBoard();
    renderBoardCount();
    syncBoardSwitcher();
    if (updateOptions.notify !== false) {
      options.onBoardChange?.(instruments.map((instrument) => ({ ...instrument })));
    }
    if (
      previousLayout.newsPosition !== boardLayout.newsPosition
      || previousLayout.newsOpen !== boardLayout.newsOpen
    ) {
      options.onBoardLayoutChange?.({ ...boardLayout });
    }
    return instruments;
  }

  async function reorderBoard(move) {
    if (destroyed || !move?.itemId) return false;
    const moved = moveBoardSequenceItem({
      instrumentIds: instruments.map((instrument) => instrument.id),
      newsPosition: boardLayout.newsPosition,
      itemId: move.itemId,
      beforeId: move.beforeId,
    });
    if (!moved.changed) return false;
    const nextLayout = { ...boardLayout, newsPosition: moved.newsPosition };
    const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
    const reordered = moved.instrumentIds.map((id) => byId.get(id)).filter(Boolean);
    const instrumentOrderChanged = reordered.some((instrument, index) => (
      instrument.id !== instruments[index]?.id
    ));
    if (instrumentOrderChanged) {
      await applyBoard(reordered, { refresh: false, layout: nextLayout });
    } else {
      boardLayout = nextLayout;
      runtime.setLayoutState(boardLayout);
      persistBoard();
      options.onBoardLayoutChange?.({ ...boardLayout });
    }
    return true;
  }

  function setNewsOpen(open) {
    if (destroyed || boardLayout.newsOpen === Boolean(open)) return false;
    boardLayout = { ...boardLayout, newsOpen: Boolean(open) };
    runtime.setLayoutState(boardLayout);
    persistBoard();
    options.onBoardLayoutChange?.({ ...boardLayout });
    return true;
  }

  async function rehydrateBoardDescriptors(boardId) {
    if (!hydrationBoardIds.has(boardId) || destroyed) return instruments;
    const board = boards.find((candidate) => candidate.id === boardId);
    if (!board) return instruments;
    hydrationBoardIds.delete(boardId);
    const pending = [...board.instruments];
    if (!pending.length) return instruments;
    const resolved = await Promise.all(pending.map(async (instrument) => {
      try {
        const fresh = await runtime.app.resolveInstrument(instrument);
        const descriptor = canonicalInstrument({ ...instrument, ...fresh });
        return descriptor ? [instrument.id, descriptor] : null;
      } catch (error) {
        if (error?.name === "AbortError") return null;
        return null;
      }
    }));
    if (destroyed) return instruments;
    const byId = new Map(resolved.filter(Boolean));
    if (!byId.size) return instruments;
    if (activeBoardId === boardId) {
      return applyBoard(
        instruments.map((instrument) => byId.get(instrument.id) || instrument),
        { refresh: false, notify: false },
      );
    }
    let hydrated = [];
    boards = boards.map((candidate) => {
      if (candidate.id !== boardId) return candidate;
      hydrated = candidate.instruments.map((instrument) => byId.get(instrument.id) || instrument);
      return { ...candidate, instruments: hydrated };
    });
    persistBoard();
    syncBoardSwitcher();
    return hydrated;
  }

  function handleAddFromResults(id) {
    const row = shownRows.find((candidate) => candidate.id === id);
    if (row?.instrument) void addInstrument(row.instrument);
  }

  function enrichInstrumentSectorInBackground(instrument) {
    if (instrument.sector || instrument.category || instrument.group) return;
    runtime.app.getDetails(instrument.id, {})
      .then((details) => runtime.app.applyInstrumentEnrichment?.(instrument.id, enrichmentFromDetails(details)))
      .catch(() => {});
  }

  async function addInstrument(candidate) {
    if (destroyed) return false;
    if (instruments.some((instrument) => instrument.id === candidate.id)) return false;
    if (instruments.length >= maxBoardSize) {
      notify(`This board accepts at most ${maxBoardSize} instruments.`);
      return false;
    }
    const originBoardId = activeBoardId;
    setRowState(candidate.id, "validating");
    try {
      const validated = canonicalInstrument(await runtime.app.validateInstrument(candidate));
      if (!validated || !enabledAssetClasses.includes(validated.assetClass)) {
        throw new Error(`This release currently supports validated ${enabledAssetClasses.join(", ")} instruments only.`);
      }
      if (destroyed || activeBoardId !== originBoardId) return false;
      await applyBoard([...instruments, validated], { compactInsertIds: [validated.id] });
      enrichInstrumentSectorInBackground(validated);
      notify(`${validated.symbol} added to the board.`);
      closeAddTickerModal();
      return true;
    } catch (error) {
      if (error?.name === "AbortError") return false;
      setRowState(candidate.id, "retry");
      notify(error?.message || "Unable to validate this instrument.");
      return false;
    }
  }

  async function search(query, overrides = {}) {
    if (destroyed) return [];
    const normalized = String(query || "").trim();
    if (normalized.length < MIN_SEARCH_QUERY_LENGTH) {
      renderSearchMessage(`Enter at least ${MIN_SEARCH_QUERY_LENGTH} characters.`);
      return [];
    }
    const filters = { ...searchFilters, ...overrides };
    const assetClass = filters.assetClass === "all" ? undefined : filters.assetClass;
    abortSearch();
    const sequence = ++searchSequence;
    searchController = new AbortController();
    renderSearchMessage("Finding matches…");
    try {
      const results = await runtime.app.searchSymbols(normalized, {
        assetClass,
        venue: filters.venue === "all" ? undefined : filters.venue,
        currency: filters.currency === "all" ? undefined : filters.currency,
        includeUnsupported: true,
        limit: 20,
        signal: searchController.signal,
      });
      if (sequence !== searchSequence || !addModalOpen) return [];
      const normalizedResults = uniqueSearchResults(results, 20)
        .filter((result) => {
          const resultClass = result.instrument?.assetClass || result.candidate?.assetClass;
          return !assetClass || resultClass === assetClass;
        })
        .map((result) => {
          const resultClass = result.instrument?.assetClass || result.candidate?.assetClass;
          return resultClass && !enabledAssetClasses.includes(resultClass) && result.addable
            ? { ...result, addable: false, reasonCode: "asset_class_disabled" }
            : result;
        });
      if (!normalizedResults.length) {
        renderSearchMessage("No matching instruments found.");
        return [];
      }
      renderResultRows(normalizedResults.map((result) => resultRowDescriptor(
        result,
        Boolean(result.instrument && instruments.some((current) => current.id === result.instrument.id)),
      )));
      return normalizedResults
        .filter((result) => result.instrument && result.addable)
        .map((result) => result.instrument);
    } catch (error) {
      if (error?.name !== "AbortError" && sequence === searchSequence) {
        renderSearchMessage(error?.message || "Search is temporarily unavailable.");
      }
      return [];
    } finally {
      if (sequence === searchSequence) searchController = null;
    }
  }

  function validateBoardName(value, excludedBoardId = null) {
    const name = normalizedBoardName(value);
    if (!name) {
      return {
        ok: false,
        message: String(value || "").trim()
          ? `Board names can contain at most ${MAX_BOARD_NAME_LENGTH} characters.`
          : "Enter a board name.",
      };
    }
    const duplicate = boards.some((board) => (
      board.id !== excludedBoardId && sameBoardName(board.name, name)
    ));
    return duplicate
      ? { ok: false, message: "Choose a distinct board name." }
      : { ok: true, name };
  }

  function nextCustomBoardId() {
    let id;
    do {
      id = `board-${nextBoardSequence}`;
      nextBoardSequence += 1;
    } while (boards.some((board) => board.id === id));
    return id;
  }

  function switchBoard(boardId) {
    if (destroyed) return false;
    const target = boards.find((board) => board.id === boardId);
    if (!target) return false;
    if (activeBoardId === target.id) return true;

    if (addModalOpen) closeAddTickerModal();
    runtime.views.modalView.closeModal();
    activeBoardId = target.id;
    instruments = [...target.instruments];
    boardLayout = { ...target.layout };
    recentlyRemoved = [];
    runtime.updateInstruments(instruments, { allowOversize: true });
    runtime.setLayoutState(boardLayout);
    runtime.views.controlBarView.resetFilters();
    renderBoardCount();
    persistBoard();
    syncBoardSwitcher();
    options.onBoardChange?.(instruments.map((instrument) => ({ ...instrument })));
    options.onBoardLayoutChange?.({ ...boardLayout });
    options.onActiveBoardChange?.({
      ...boardSummaries().find((board) => board.id === activeBoardId),
    });
    if (hydrationBoardIds.has(activeBoardId)) {
      void rehydrateBoardDescriptors(activeBoardId);
    }
    return true;
  }

  function createBoard(name) {
    if (destroyed) return { ok: false, message: "Market Map is no longer active." };
    const validated = validateBoardName(name);
    if (!validated.ok) return validated;
    const board = {
      id: nextCustomBoardId(),
      name: validated.name,
      workspaceId: workspace.id,
      isDefault: false,
      instruments: [],
      layout: normalizedBoardLayout(null, 0),
    };
    boards = [...boards, board];
    switchBoard(board.id);
    return { ok: true, board: boardSummaries().find(({ id }) => id === board.id) };
  }

  function renameBoard(boardId, name) {
    if (destroyed) return { ok: false, message: "Market Map is no longer active." };
    const board = boards.find((candidate) => candidate.id === boardId);
    if (!board) return { ok: false, message: "Board not found." };
    if (board.isDefault) {
      return { ok: false, message: `${workspace.name} keeps its default name.` };
    }
    const validated = validateBoardName(name, boardId);
    if (!validated.ok) return validated;
    boards = boards.map((candidate) => candidate.id === boardId
      ? { ...candidate, name: validated.name }
      : candidate);
    persistBoard();
    syncBoardSwitcher();
    return { ok: true, board: boardSummaries().find(({ id }) => id === boardId) };
  }

  function duplicateBoard(boardId = activeBoardId) {
    if (destroyed) return { ok: false, message: "Market Map is no longer active." };
    const source = boards.find((board) => board.id === boardId);
    if (!source) return { ok: false, message: "Board not found." };
    const duplicate = {
      ...source,
      id: nextCustomBoardId(),
      name: availableBoardName(boards, `${source.name} copy`),
      isDefault: false,
      instruments: source.instruments.map((instrument) => ({ ...instrument })),
      layout: { ...source.layout },
    };
    boards = [...boards, duplicate];
    if (hydrationBoardIds.has(source.id)) hydrationBoardIds.add(duplicate.id);
    switchBoard(duplicate.id);
    notify(`${duplicate.name} created.`, 2_800);
    return { ok: true, board: boardSummaries().find(({ id }) => id === duplicate.id) };
  }

  function undoDeletedBoard(deleted) {
    if (destroyed || boards.some((board) => board.id === deleted.board.id)) return false;
    const restored = {
      ...deleted.board,
      name: availableBoardName(boards, deleted.board.name),
      instruments: deleted.board.instruments.map((instrument) => ({ ...instrument })),
      layout: { ...deleted.board.layout },
    };
    const insertionIndex = Math.min(Math.max(0, deleted.index), boards.length);
    boards = [
      ...boards.slice(0, insertionIndex),
      restored,
      ...boards.slice(insertionIndex),
    ];
    if (deleted.needsHydration) hydrationBoardIds.add(restored.id);
    switchBoard(restored.id);
    return true;
  }

  function deleteBoard(boardId = activeBoardId) {
    if (destroyed) return { ok: false, message: "Market Map is no longer active." };
    const index = boards.findIndex((board) => board.id === boardId);
    if (index < 0) return { ok: false, message: "Board not found." };
    const board = boards[index];
    if (board.isDefault) {
      return { ok: false, message: `${workspace.name} cannot be deleted.` };
    }
    if (boards.length <= 1) return { ok: false, message: "Keep at least one board." };
    const deleted = {
      board: {
        ...board,
        instruments: board.instruments.map((instrument) => ({ ...instrument })),
        layout: { ...board.layout },
      },
      index,
      needsHydration: hydrationBoardIds.delete(board.id),
    };
    boards = boards.filter((candidate) => candidate.id !== boardId);
    if (activeBoardId === boardId) {
      const fallback = boards[Math.min(index, boards.length - 1)]
        || boards.find((candidate) => candidate.isDefault)
        || boards[0];
      switchBoard(fallback.id);
    } else {
      persistBoard();
      syncBoardSwitcher();
    }
    notify(`${board.name} deleted.`, 8_000, {
      label: "Undo",
      onClick: () => undoDeletedBoard(deleted),
    });
    return { ok: true };
  }

  function removeInstrument(instrumentId) {
    if (destroyed) return false;
    const next = instruments.filter((instrument) => instrument.id !== instrumentId);
    if (next.length === instruments.length) return false;
    const removed = instruments.find((instrument) => instrument.id === instrumentId);
    if (removed) {
      recentlyRemoved = [removed, ...recentlyRemoved.filter((item) => item.id !== removed.id)].slice(0, 6);
    }
    void applyBoard(next);
    notify(`${removed?.symbol || "Instrument"} removed from the board.`);
    return true;
  }

  function clearAllTickers() {
    if (destroyed) return false;
    if (!instruments.length) return false;
    const clearedBoardId = activeBoardId;
    const snapshot = {
      instruments: instruments.map((instrument) => ({ ...instrument })),
      layout: { ...boardLayout },
    };
    void applyBoard([]);
    notify("Board cleared. Real data remains available through search.", 8_000, {
      label: "Undo",
      onClick: () => {
        const board = boards.find((candidate) => candidate.id === clearedBoardId);
        if (!board) return false;
        if (activeBoardId === clearedBoardId) {
          applyBoard(snapshot.instruments, { layout: snapshot.layout, allowOversize: true })
            .catch(() => notify("The board could not be restored."));
        } else {
          boards = boards.map((candidate) => candidate.id === clearedBoardId
            ? {
                ...candidate,
                instruments: snapshot.instruments,
                layout: snapshot.layout,
              }
            : candidate);
          persistBoard();
          syncBoardSwitcher();
        }
        return true;
      },
    });
    return true;
  }

  function restoreDefaultTickers() {
    if (destroyed) return false;
    const defaultBoard = boards.find((board) => board.isDefault);
    if (!defaultBoard) return false;
    const layout = normalizedBoardLayout(null, defaults.length);
    if (activeBoardId === defaultBoard.id) {
      void applyBoard(defaults, { layout });
    } else {
      boards = boards.map((board) => board.id === defaultBoard.id
        ? { ...board, instruments: defaults, layout }
        : board);
      switchBoard(defaultBoard.id);
    }
    notify(`Default ${workspace.name} board restored.`);
    return true;
  }

  function initialTheme() {
    if (options.theme === "light" || options.theme === "dark") return options.theme;
    if (options.persistTheme !== false) {
      try {
        const saved = storage?.getItem(CONFIG.STORAGE.THEME);
        if (saved === "light" || saved === "dark") return saved;
      } catch {}
    }
    if (root.dataset.marketmapTheme === "light") return "light";
    return systemTheme();
  }

  function setTheme(theme) {
    if (destroyed) return false;
    if (theme !== "light" && theme !== "dark") return false;
    runtime?.setTheme(theme);
    const themeButton = root.querySelector("#theme-btn");
    if (themeButton) {
      const label = `Switch to ${theme === "light" ? "dark" : "light"} theme`;
      themeButton.setAttribute("aria-label", label);
      themeButton.setAttribute("title", label);
    }
    if (options.persistTheme !== false) {
      try {
        storage?.setItem(CONFIG.STORAGE.THEME, theme);
      } catch {}
    }
    options.onThemeRequest?.(theme);
    return true;
  }

  function cycleTheme() {
    return setTheme(root.dataset.marketmapTheme === "light" ? "dark" : "light");
  }

  function handleSearchInput(query) {
    currentQuery = query;
    abortSearch();
    const trimmed = String(query || "").trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
      renderInitialSuggestions();
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void search(trimmed);
    }, options.searchDebounceMs ?? SEARCH_DEBOUNCE_MS);
  }

  function handleFilterChange(filters) {
    Object.assign(searchFilters, filters);
    const trimmed = currentQuery.trim();
    if (trimmed.length >= MIN_SEARCH_QUERY_LENGTH) void search(trimmed);
  }

  addModalApi = options.reactIslands?.mountAddInstrument?.(
    root.querySelector("#react-add-instrument"),
    {
      assetClassOptions: addAssetClassOptions,
      onQueryChange: handleSearchInput,
      onFilterChange: handleFilterChange,
      onAdd: handleAddFromResults,
      onClose: teardownAddModal,
    },
  ) || null;

  runtime = createMarketMap({
    ...options,
    root,
    instruments,
    layout: boardLayout,
    boardState: currentBoardState(),
    storage,
    theme: initialTheme(),
    maxBoardSize,
    allowInitialOversize: instruments.length > maxBoardSize,
    setScrollLocked: () => {},
    onOverlayChange: (active) => setOverlay("details", active),
    actions: {
      ...options.actions,
      openAddTickerModal,
      removeTicker: removeInstrument,
      reorderBoard,
      setNewsOpen,
      clearAllTickers,
      restoreDefaultTickers,
      switchBoard,
      createBoard,
      renameBoard,
      duplicateBoard,
      deleteBoard,
      setBoardDialogOpen: (open) => setOverlay("board-management", open),
      cycleTheme,
    },
  });
  const stopBoardEnrichment = runtime.app.state.on("board:updated", ({ instruments: enriched }) => {
    if (destroyed || !Array.isArray(enriched)) return;
    const byId = new Map(enriched.map((instrument) => [instrument.id, instrument]));
    let changed = false;
    const merged = instruments.map((instrument) => {
      const source = byId.get(instrument.id);
      const patch = ["sector", "category", "group"].filter((key) => (
        typeof source?.[key] === "string" && source[key] && source[key] !== instrument[key]
      ));
      if (!patch.length) return instrument;
      changed = true;
      return { ...instrument, ...Object.fromEntries(patch.map((key) => [key, source[key]])) };
    });
    if (!changed) return;
    instruments = merged;
    persistBoard();
  });
  renderBoardCount();
  setTheme(root.dataset.marketmapTheme);
  if (persisted.migrated) persistBoard();
  const ready = hydrationBoardIds.has(activeBoardId)
    ? Promise.resolve(runtime.ready).then(async (value) => {
        await rehydrateBoardDescriptors(activeBoardId);
        return value;
      })
    : runtime.ready;
  return Object.freeze({
    app: runtime.app,
    root,
    ready,
    newsReady: runtime.newsReady,
    views: runtime.views,
    pause: runtime.pause,
    resume: runtime.resume,
    refresh: runtime.refresh,
    refreshNews: runtime.refreshNews,
    setAutoRefresh: runtime.setAutoRefresh,
    setTheme,
    openAddTickerModal,
    closeAddTickerModal,
    enabledAssetClasses,
    searchInstruments: search,
    addInstrument,
    removeInstrument,
    clearAllTickers,
    restoreDefaultTickers,
    reorderBoard,
    setNewsOpen,
    switchBoard,
    createBoard,
    renameBoard,
    duplicateBoard,
    deleteBoard,
    getState: () => ({
      ...runtime.getState(),
      layout: { ...boardLayout },
      boards: boardSummaries(),
      activeBoardId,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abortSearch();
      closeAddTickerModal();
      addModalApi?.root?.unmount();
      stopBoardEnrichment();
      lifecycle.destroy();
      runtime.destroy();
      activeOverlays.clear();
      syncScrollLock();
      if (originalTheme === undefined) delete root.dataset.marketmapTheme;
      else root.dataset.marketmapTheme = originalTheme;
      if (originalDesignSystemTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", originalDesignSystemTheme);
      if (originalDesignSystemRoot === null) root.removeAttribute("data-ds-root");
      else root.setAttribute("data-ds-root", originalDesignSystemRoot);
      if (!hadMarketMapClass) root.classList.remove("marketmap-app");
    },
  });
}

export { BOARD_SCHEMA_VERSION };
