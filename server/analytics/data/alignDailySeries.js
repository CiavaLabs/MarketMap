import { sessionDateFromTimestamp } from "./sessionDate.js";
import { validateSessionGrid } from "./sessionGrid.js";

function requireSeries(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a history series`);
  }
  if (!Array.isArray(value.bars)) throw new TypeError(`${label}.bars must be an array`);
  return value;
}

const SERIES_INDEX_CACHE = new WeakMap();

function indexBars(series) {
  const timeZone = series.session?.timezone;
  const cached = SERIES_INDEX_CACHE.get(series);
  if (cached && cached.bars === series.bars && cached.timeZone === timeZone) {
    return cached.index;
  }
  const bySessionDate = new Map();
  const duplicateSessionDates = new Set();

  for (const bar of series.bars) {
    const sessionDate = sessionDateFromTimestamp(bar?.timestamp, timeZone);
    if (bySessionDate.has(sessionDate)) {
      duplicateSessionDates.add(sessionDate);
      continue;
    }
    bySessionDate.set(sessionDate, bar);
  }
  const index = {
    bySessionDate,
    sessionDates: [...bySessionDate.keys()].sort(),
    duplicateSessionDates: [...duplicateSessionDates].sort(),
  };
  SERIES_INDEX_CACHE.set(series, { bars: series.bars, timeZone, index });
  return index;
}

export function alignDailySeries({
  assetSeries,
  benchmarkSeries,
  sessionGrid,
} = {}) {
  requireSeries(assetSeries, "assetSeries");
  requireSeries(benchmarkSeries, "benchmarkSeries");
  const grid = validateSessionGrid(sessionGrid);

  const asset = indexBars(assetSeries);
  const benchmark = indexBars(benchmarkSeries);
  const gridDates = new Set(grid.sessionDates);
  const firstGridDate = grid.sessionDates[0];
  const lastGridDate = grid.sessionDates.at(-1);
  const withinGridBounds = (sessionDate) => (
    sessionDate >= firstGridDate && sessionDate <= lastGridDate
  );
  const unexpectedAssetSessionDates = asset.sessionDates
    .filter((sessionDate) => (
      withinGridBounds(sessionDate) && !gridDates.has(sessionDate)
    ));
  const unexpectedBenchmarkSessionDates = benchmark.sessionDates
    .filter((sessionDate) => (
      withinGridBounds(sessionDate) && !gridDates.has(sessionDate)
    ));
  const rows = grid.sessionDates.map((sessionDate) => ({
    sessionDate,
    assetBar: asset.bySessionDate.get(sessionDate) || null,
    benchmarkBar: benchmark.bySessionDate.get(sessionDate) || null,
  }));
  const missingAssetSessionDates = rows
    .filter(({ assetBar }) => assetBar === null)
    .map(({ sessionDate }) => sessionDate);

  return {
    rows,
    assetSessionDates: asset.sessionDates,
    benchmarkObservedSessionDates: benchmark.sessionDates,
    sessionGridDates: grid.sessionDates,
    duplicateAssetSessionDates: asset.duplicateSessionDates,
    duplicateBenchmarkSessionDates: benchmark.duplicateSessionDates,
    unexpectedAssetSessionDates,
    unexpectedBenchmarkSessionDates,
    assetSessionDatesAfterGrid: asset.sessionDates
      .filter((sessionDate) => sessionDate > lastGridDate),
    benchmarkSessionDatesAfterGrid: benchmark.sessionDates
      .filter((sessionDate) => sessionDate > lastGridDate),
    missingAssetSessionDates,
    missingBenchmarkSessionDates: rows
      .filter(({ benchmarkBar }) => benchmarkBar === null)
      .map(({ sessionDate }) => sessionDate),
  };
}
