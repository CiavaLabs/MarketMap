export const BOARD_NEWS_ID = "__marketmap_news__";
export const DEFAULT_NEWS_POSITION = 0;
export const MAX_BOARD_NAME_LENGTH = 60;

const TILE_SPANS = Object.freeze({
  hero: Object.freeze({ columns: 2, rows: 2 }),
  wide: Object.freeze({ columns: 2, rows: 1 }),
  compact: Object.freeze({ columns: 1, rows: 1 }),
});

function boundedInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function valueFrom(source, key) {
  if (source instanceof Map) return source.get(key);
  if (typeof source === "function") return source(key);
  return source?.[key];
}

function normalizeSpan(candidate, columns) {
  const columnSpan = boundedInteger(candidate?.columns ?? candidate?.columnSpan, 1);
  const rowSpan = boundedInteger(candidate?.rows ?? candidate?.rowSpan, 1);
  return Object.freeze({
    columns: Math.min(columnSpan, columns),
    rows: rowSpan,
  });
}

function spanFor(itemId, tiers, spans, columns) {
  const explicit = valueFrom(spans, itemId);
  if (explicit) return normalizeSpan(explicit, columns);
  const tier = valueFrom(tiers, itemId) || "compact";
  return normalizeSpan(TILE_SPANS[tier] || TILE_SPANS.compact, columns);
}

function cellKey(column, row) {
  return `${column}:${row}`;
}

function mark(occupied, column, row, span) {
  for (let y = row; y < row + span.rows; y += 1) {
    for (let x = column; x < column + span.columns; x += 1) {
      occupied.add(cellKey(x, y));
    }
  }
}

function fits(occupied, columns, column, row, span) {
  if (column < 1 || row < 1 || column + span.columns - 1 > columns) return false;
  for (let y = row; y < row + span.rows; y += 1) {
    for (let x = column; x < column + span.columns; x += 1) {
      if (occupied.has(cellKey(x, y))) return false;
    }
  }
  return true;
}

function nextCell(column, row, columns) {
  return column >= columns
    ? { column: 1, row: row + 1 }
    : { column: column + 1, row };
}

function firstFreeCell(occupied, columns, start = { column: 1, row: 1 }) {
  let cursor = { ...start };
  while (occupied.has(cellKey(cursor.column, cursor.row))) {
    cursor = nextCell(cursor.column, cursor.row, columns);
  }
  return cursor;
}

function firstFit(occupied, columns, span) {
  let cursor = firstFreeCell(occupied, columns);
  while (!fits(occupied, columns, cursor.column, cursor.row, span)) {
    cursor = firstFreeCell(occupied, columns, nextCell(cursor.column, cursor.row, columns));
  }
  return cursor;
}

export function packBoardLayout({
  sequence = [],
  tiers = new Map(),
  columns = 6,
  spans = new Map(),
  obstacles = [],
} = {}) {
  const columnCount = boundedInteger(columns, 6);
  const items = [...sequence];
  if (new Set(items).size !== items.length) {
    throw new Error("Board layout sequence contains duplicate ids");
  }

  const occupied = new Set();
  for (const obstacle of obstacles || []) {
    const column = boundedInteger(obstacle?.column, 1);
    const row = boundedInteger(obstacle?.row, 1);
    mark(occupied, column, row, normalizeSpan(obstacle?.span || obstacle, columnCount));
  }

  const placed = new Map();
  for (const itemId of items) {
    const span = spanFor(itemId, tiers, spans, columnCount);
    const position = firstFit(occupied, columnCount, span);
    mark(occupied, position.column, position.row, span);
    placed.set(itemId, {
      instrumentId: itemId,
      column: position.column,
      row: position.row,
      span,
    });
  }

  return items.map((itemId) => placed.get(itemId));
}

export function boardSequence(instrumentIds, newsPosition = 0) {
  const ids = [...new Set((instrumentIds || []).filter((id) => id && id !== BOARD_NEWS_ID))];
  const position = Math.min(Math.max(0, boundedInteger(newsPosition, 0, 0)), ids.length);
  ids.splice(position, 0, BOARD_NEWS_ID);
  return ids;
}

export function columnsForBoardWidth(width, singleTile = false) {
  if (singleTile) return 1;
  if (!Number.isFinite(width) || width <= 0) return 6;
  if (width <= 420) return 2;
  if (width <= 630) return 3;
  if (width <= 790) return 4;
  if (width <= 950) return 5;
  return 6;
}

export function visibleBoardSequence({
  visibleInstrumentIds = [],
  indexById = new Map(),
  newsPosition = 0,
  includeNews = true,
} = {}) {
  const visible = [...new Set(visibleInstrumentIds)];
  if (!includeNews) return visible;
  const position = Math.max(0, boundedInteger(newsPosition, 0, 0));
  let insertion = visible.findIndex((instrumentId) => {
    const fullIndex = valueFrom(indexById, instrumentId);
    return Number.isInteger(fullIndex) && fullIndex >= position;
  });
  if (insertion < 0) insertion = Math.min(position, visible.length);
  visible.splice(insertion, 0, BOARD_NEWS_ID);
  return visible;
}

export function moveBoardSequenceItem({
  instrumentIds = [],
  newsPosition = 0,
  itemId,
  beforeId = null,
} = {}) {
  const current = boardSequence(instrumentIds, newsPosition);
  const sourceIndex = current.indexOf(itemId);
  if (sourceIndex < 0) {
    return { instrumentIds: [...instrumentIds], newsPosition, changed: false };
  }

  const next = [...current];
  next.splice(sourceIndex, 1);
  const targetIndex = beforeId == null ? next.length : next.indexOf(beforeId);
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, itemId);

  const nextNewsPosition = next.indexOf(BOARD_NEWS_ID);
  const nextInstrumentIds = next.filter((id) => id !== BOARD_NEWS_ID);
  return {
    instrumentIds: nextInstrumentIds,
    newsPosition: nextNewsPosition,
    changed: next.some((id, index) => id !== current[index]),
  };
}
