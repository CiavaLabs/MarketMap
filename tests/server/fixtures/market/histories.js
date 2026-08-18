const AS_OF = "2026-07-16T20:00:00.000Z";
const FETCHED_AT = "2026-07-16T20:00:05.000Z";

const usable = (rowCount, extra = {}) => ({
  status: "usable",
  rowCount,
  droppedRows: 0,
  issues: [],
  ...extra,
});

export const ETF_ADJUSTED_HISTORY = Object.freeze({
  instrumentId: "ARCX:SPY",
  assetClass: "etf",
  range: "1y",
  interval: "1d",
  priceBasis: "provider_adjusted",
  requestedPriceBasis: "provider_adjusted",
  adjustment: {
    status: "provider_defined",
    includesSplits: true,
    includesDistributions: "unknown",
    formulaVersion: null,
  },
  continuity: { kind: "single_instrument", rollover: null },
  session: { model: "exchange_hours", timezone: "America/New_York" },
  bars: [
    {
      timestamp: "2026-07-14T20:00:00.000Z",
      open: 620.1,
      high: 623.4,
      low: 619.2,
      close: 622.8,
      adjustedClose: 621.9,
      displayClose: 621.9,
      volume: 68_204_100,
    },
    {
      timestamp: "2026-07-15T20:00:00.000Z",
      open: 622.9,
      high: 626.7,
      low: 622.0,
      close: 625.3,
      adjustedClose: 624.4,
      displayClose: 624.4,
      volume: 64_118_800,
    },
    {
      timestamp: "2026-07-16T20:00:00.000Z",
      open: 626.0,
      high: 629.9,
      low: 624.8,
      close: 628.4,
      adjustedClose: 628.4,
      displayClose: 628.4,
      volume: 55_120_030,
    },
  ],
  events: [
    {
      type: "dividend",
      timestamp: "2026-06-20T13:30:00.000Z",
      amount: 1.75,
      currency: "USD",
      source: "yahoo",
    },
  ],
  quality: "fresh",
  dataQuality: usable(3, { missingAdjustedCloseRows: 0 }),
  provenance: { source: "yahoo", providerSymbol: "SPY", fallback: false },
  asOf: AS_OF,
  fetchedAt: FETCHED_AT,
});

export const ETF_PARTIAL_ADJUSTED_HISTORY = Object.freeze({
  ...ETF_ADJUSTED_HISTORY,
  bars: [
    ETF_ADJUSTED_HISTORY.bars[0],
    {
      ...ETF_ADJUSTED_HISTORY.bars[1],
      adjustedClose: null,
      displayClose: null,
      fieldAvailability: {
        adjustedClose: { status: "temporarily_unavailable" },
        displayClose: { status: "temporarily_unavailable" },
      },
    },
    ETF_ADJUSTED_HISTORY.bars[2],
  ],
  quality: "fresh",
  dataQuality: {
    status: "usable_with_warnings",
    rowCount: 3,
    droppedRows: 0,
    missingAdjustedCloseRows: 1,
    issues: [{ code: "partial_adjusted_series", severity: "warning", field: "adjustedClose" }],
  },
});

export const FX_RAW_HISTORY = Object.freeze({
  instrumentId: "FX:EURUSD",
  assetClass: "fx",
  range: "1m",
  interval: "1d",
  priceBasis: "raw",
  requestedPriceBasis: "raw",
  adjustment: {
    status: "none",
    includesSplits: false,
    includesDistributions: false,
    formulaVersion: null,
  },
  continuity: { kind: "single_instrument", rollover: null },
  session: { model: "24x5", timezone: "UTC" },
  fieldAvailability: {
    volume: { status: "not_applicable", reason: "fx_otc_volume" },
  },
  bars: [
    {
      timestamp: "2026-07-14T00:00:00.000Z",
      open: 1.0899,
      high: 1.0912,
      low: 1.0868,
      close: 1.0875,
      displayClose: 1.0875,
      volume: null,
    },
    {
      timestamp: "2026-07-15T00:00:00.000Z",
      open: 1.0875,
      high: 1.0890,
      low: 1.0851,
      close: 1.0873,
      displayClose: 1.0873,
      volume: null,
    },
    {
      timestamp: "2026-07-16T00:00:00.000Z",
      open: 1.0871,
      high: 1.0885,
      low: 1.0834,
      close: 1.0842,
      displayClose: 1.0842,
      volume: null,
    },
  ],
  events: [],
  quality: "fresh",
  dataQuality: usable(3),
  provenance: { source: "yahoo", providerSymbol: "EURUSD=X", fallback: false },
  asOf: AS_OF,
  fetchedAt: FETCHED_AT,
});

export const FUTURE_CONTINUOUS_HISTORY = Object.freeze({
  instrumentId: "FUTURE:CMX.GC.CONTINUOUS.1",
  assetClass: "commodity_future",
  range: "6m",
  interval: "1d",
  priceBasis: "raw",
  requestedPriceBasis: "raw",
  adjustment: {
    status: "none",
    includesSplits: false,
    includesDistributions: false,
    formulaVersion: null,
  },
  continuity: {
    kind: "provider_continuous_front",
    activeContract: "GCQ26.CMX",
    expirationDate: "2026-08-27T00:00:00.000Z",
    rollover: "provider_managed",
    backAdjustment: "unknown",
    comparableAcrossRollover: false,
  },
  session: { model: "provider_schedule", timezone: "America/New_York" },
  bars: [
    {
      timestamp: "2026-07-14T20:00:00.000Z",
      open: 3_340.0,
      high: 3_361.5,
      low: 3_332.8,
      close: 3_358.2,
      displayClose: 3_358.2,
      volume: 161_002,
    },
    {
      timestamp: "2026-07-15T20:00:00.000Z",
      open: 3_358.9,
      high: 3_372.4,
      low: 3_351.0,
      close: 3_365.0,
      displayClose: 3_365.0,
      volume: 149_884,
    },
    {
      timestamp: "2026-07-16T20:00:00.000Z",
      open: 3_366.2,
      high: 3_371.8,
      low: 3_344.1,
      close: 3_352.4,
      displayClose: 3_352.4,
      volume: 178_204,
    },
  ],
  events: [],
  quality: "fresh",
  dataQuality: usable(3),
  provenance: { source: "yahoo", providerSymbol: "GC=F", fallback: false },
  asOf: AS_OF,
  fetchedAt: FETCHED_AT,
});

export const NEGATIVE_FUTURE_HISTORY = Object.freeze({
  ...FUTURE_CONTINUOUS_HISTORY,
  bars: [
    {
      timestamp: "2026-07-15T20:00:00.000Z",
      open: 15.2,
      high: 15.9,
      low: -2.1,
      close: -1.43,
      displayClose: -1.43,
      volume: 88_120,
    },
    {
      timestamp: "2026-07-16T20:00:00.000Z",
      open: -1.4,
      high: 2.2,
      low: -3.8,
      close: 1.9,
      displayClose: 1.9,
      volume: 92_400,
    },
  ],
  dataQuality: usable(2),
});

export const ALL_HISTORIES = Object.freeze([
  ETF_ADJUSTED_HISTORY,
  ETF_PARTIAL_ADJUSTED_HISTORY,
  FX_RAW_HISTORY,
  FUTURE_CONTINUOUS_HISTORY,
  NEGATIVE_FUTURE_HISTORY,
]);
