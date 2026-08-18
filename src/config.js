export const CONFIG = Object.freeze({
  API: Object.freeze({
    BASE_URL: "/api/market/v1",
    MAX_BATCH_IDS: 40,
    BATCH_CONCURRENCY: 2,
    REQUEST_TIMEOUT_MS: 6_000,
    HISTORY_BATCH_TIMEOUT_MS: 30_000,
    NEWS_BATCH_TIMEOUT_MS: 30_000,
  }),
  ENABLED_ASSET_CLASSES: Object.freeze([
    "equity",
    "etf",
    "index",
    "fx",
    "crypto",
    "commodity_future",
    "rate_index",
  ]),
  BOARD: Object.freeze({
    DEFAULT_MAX_SIZE: 60,
    HARD_MAX_SIZE: 100,
  }),
  REFRESH: Object.freeze({
    POLICY: "automatic",
    MINIMUM_MS: 5_000,
    HISTORY_MS: 5 * 60_000,
  }),
  NEWS: Object.freeze({
    BOARD_LIMIT: 12,
    MODAL_LIMIT: 4,
  }),
  UI: Object.freeze({
    THRESHOLDS: Object.freeze({
      STRONG_GAIN: 3,
      MILD_GAIN: 0.5,
      STRONG_LOSS: -3,
      MILD_LOSS: -0.5,
    }),
    QUOTE_HISTORY_LENGTH: 60,
  }),
  STORAGE: Object.freeze({
    THEME: "marketmap-theme",
    BOARD: "marketmap-board-v1",
    BOARD_V2: "marketmap-board-v2",
    BOARDS_V3: "marketmap-boards-v3",
  }),
  LOG_LEVEL: "warn",
});

export const MAX_TOTAL_TICKERS = CONFIG.BOARD.DEFAULT_MAX_SIZE;

export function normalizeMaxBoardSize(value = CONFIG.BOARD.DEFAULT_MAX_SIZE) {
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > CONFIG.BOARD.HARD_MAX_SIZE) {
    throw new RangeError(`maxBoardSize must be an integer between 1 and ${CONFIG.BOARD.HARD_MAX_SIZE}`);
  }
  return size;
}

export function getApiBaseUrl(override) {
  const value = String(override || CONFIG.API.BASE_URL).trim();
  return value.replace(/\/+$/, "");
}
