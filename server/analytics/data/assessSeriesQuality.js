import {
  MOVEMENT_BENCHMARK_INSTRUMENT_ID,
  MOVEMENT_MAX_MISSING_RATE,
  MOVEMENT_QUALITY_VERSION,
  MOVEMENT_QUALITY_WARNINGS,
  MOVEMENT_SESSION_CALENDAR_ID,
  MOVEMENT_UNAVAILABLE_REASONS,
} from "../contracts/constants.js";
import { alignDailySeries } from "./alignDailySeries.js";
import { isValidTimeZone, sessionDateFromTimestamp } from "./sessionDate.js";
import { sessionGridSummary, validateSessionGrid } from "./sessionGrid.js";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveAdjustedClose(bar) {
  return typeof bar?.adjustedClose === "number"
    && Number.isFinite(bar.adjustedClose)
    && bar.adjustedClose > 0;
}

function add(set, value) {
  set.add(value);
}

function ordered(values, order) {
  return order.filter((value) => values.has(value));
}

function issueCodes(series) {
  return new Set((series?.dataQuality?.issues || []).map(({ code }) => code));
}

function isLastKnownGood(series) {
  return series?.quality !== "fresh"
    || issueCodes(series).has("stale_last_known_good")
    || Object.hasOwn(series?.provenance || {}, "originalSource");
}

function timestampsStrictlyIncrease(series) {
  let previous = -Infinity;
  for (const bar of series?.bars || []) {
    const timestamp = Date.parse(bar?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= previous) return false;
    previous = timestamp;
  }
  return true;
}

function asOfMatchesLastBar(series) {
  const bars = series?.bars;
  return Array.isArray(bars)
    && bars.length > 0
    && series.asOf === bars.at(-1)?.timestamp;
}

function collectSeriesWarnings(series, warnings) {
  if (series?.adjustment?.includesDistributions === "unknown") {
    warnings.add("provider_distributions_unknown");
  }
  if ((series?.dataQuality?.droppedRows || 0) > 0) {
    warnings.add("dropped_rows_observed");
  }
  if ((series?.dataQuality?.missingAdjustedCloseRows || 0) > 0
    || issueCodes(series).has("partial_adjusted_series")) {
    warnings.add("partial_adjusted_history");
  }
}

function collectCommonSeriesReasons(series, reasons, timestampsOk) {
  if (series?.interval !== "1d") add(reasons, "unsupported_interval");
  if (series?.session?.model !== "exchange_hours") {
    add(reasons, "unsupported_session_model");
  }
  if (series?.priceBasis !== "provider_adjusted"
    || series?.requestedPriceBasis !== "provider_adjusted") {
    add(reasons, "unsupported_price_basis");
  }
  if (series?.adjustment?.status !== "provider_defined"
    || series?.adjustment?.includesSplits !== true) {
    add(reasons, "unsupported_adjustment_semantics");
  }
  if (series?.provenance?.source !== "yahoo") {
    add(reasons, "unsupported_history_provider");
  }
  if (series?.provenance?.fallback !== false) add(reasons, "fallback_input");
  if (isLastKnownGood(series)) add(reasons, "stale_input");
  if (series?.dataQuality?.status === "unusable") add(reasons, "unusable_history");
  if (!isValidTimeZone(series?.session?.timezone)) add(reasons, "invalid_timezone");
  if (!Array.isArray(series?.bars) || series.bars.length === 0) add(reasons, "empty_history");
  if (!timestampsOk) add(reasons, "non_monotonic_timestamps");
  if (Array.isArray(series?.bars) && series.bars.length && !asOfMatchesLastBar(series)) {
    add(reasons, "as_of_mismatch");
  }
}

function latestValidSessionDate(series) {
  if (!isValidTimeZone(series?.session?.timezone)) return null;
  for (let index = (series?.bars?.length || 0) - 1; index >= 0; index -= 1) {
    if (positiveAdjustedClose(series.bars[index])) {
      return sessionDateFromTimestamp(series.bars[index].timestamp, series.session.timezone);
    }
  }
  return null;
}

function emptyDiagnostics() {
  return {
    expectedSessionCount: 0,
    missingSessionCount: 0,
    missingRate: 0,
    latestAssetSession: null,
    latestBenchmarkSession: null,
    sessionGrid: null,
  };
}

export function assessSeriesQuality({
  assetSeries,
  benchmarkSeries,
  sessionGrid,
  maxMissingRate = MOVEMENT_MAX_MISSING_RATE,
} = {}) {
  if (!isObject(assetSeries) || !isObject(benchmarkSeries)) {
    throw new TypeError("assetSeries and benchmarkSeries must be history series");
  }
  if (!Number.isFinite(maxMissingRate) || maxMissingRate < 0 || maxMissingRate > 1) {
    throw new TypeError("maxMissingRate must be between zero and one");
  }

  const reasons = new Set();
  const warnings = new Set();
  let normalizedSessionGrid = null;
  if (sessionGrid === undefined || sessionGrid === null) {
    add(reasons, "uncertified_session_grid");
  } else {
    try {
      normalizedSessionGrid = validateSessionGrid(sessionGrid);
      if (normalizedSessionGrid.calendarId !== MOVEMENT_SESSION_CALENDAR_ID) {
        add(reasons, "unsupported_session_grid");
      }
      if (assetSeries?.session?.timezone !== normalizedSessionGrid.timeZone
        || benchmarkSeries?.session?.timezone !== normalizedSessionGrid.timeZone) {
        add(reasons, "session_grid_timezone_mismatch");
      }
    } catch {
      add(reasons, "invalid_session_grid");
    }
  }
  if (assetSeries.assetClass !== "equity") add(reasons, "unsupported_asset_class");
  if (benchmarkSeries.instrumentId !== MOVEMENT_BENCHMARK_INSTRUMENT_ID
    || benchmarkSeries.assetClass !== "etf") {
    add(reasons, "unsupported_benchmark");
  }
  const assetTimestampsOk = timestampsStrictlyIncrease(assetSeries);
  const benchmarkTimestampsOk = timestampsStrictlyIncrease(benchmarkSeries);
  collectCommonSeriesReasons(assetSeries, reasons, assetTimestampsOk);
  collectCommonSeriesReasons(benchmarkSeries, reasons, benchmarkTimestampsOk);
  collectSeriesWarnings(assetSeries, warnings);
  collectSeriesWarnings(benchmarkSeries, warnings);

  let alignment = null;
  let diagnostics = emptyDiagnostics();
  const timezonesValid = isValidTimeZone(assetSeries?.session?.timezone)
    && isValidTimeZone(benchmarkSeries?.session?.timezone);
  const barsPresent = Array.isArray(assetSeries.bars)
    && assetSeries.bars.length > 0
    && Array.isArray(benchmarkSeries.bars)
    && benchmarkSeries.bars.length > 0;
  const timestampsUsable = assetTimestampsOk && benchmarkTimestampsOk;

  if (timezonesValid && barsPresent && timestampsUsable && normalizedSessionGrid) {
    alignment = alignDailySeries({
      assetSeries,
      benchmarkSeries,
      sessionGrid: normalizedSessionGrid,
    });
    if (alignment.duplicateAssetSessionDates.length
      || alignment.duplicateBenchmarkSessionDates.length) {
      add(reasons, "duplicate_session_date");
    }
    if (alignment.unexpectedAssetSessionDates.length) {
      add(reasons, "unexpected_asset_session");
    }
    if (alignment.unexpectedBenchmarkSessionDates.length) {
      add(reasons, "unexpected_benchmark_session");
    }
    if (alignment.assetSessionDatesAfterGrid.length) {
      add(reasons, "asset_session_after_grid");
    }
    if (alignment.benchmarkSessionDatesAfterGrid.length) {
      add(reasons, "benchmark_session_after_grid");
    }
    if (alignment.rows.length < 2) add(reasons, "insufficient_benchmark_sessions");

    const unusableAssetRows = alignment.rows.filter(({ assetBar }) => (
      !positiveAdjustedClose(assetBar)
    ));
    const missingSessionCount = unusableAssetRows.length;
    const missingRate = alignment.rows.length
      ? missingSessionCount / alignment.rows.length
      : 0;
    if (missingRate > maxMissingRate) add(reasons, "missing_session_rate_exceeded");

    const current = alignment.rows.at(-1) || null;
    const previous = alignment.rows.at(-2) || null;
    if (current && !positiveAdjustedClose(current.benchmarkBar)) {
      add(reasons, "invalid_benchmark_session");
    }
    if (previous && !positiveAdjustedClose(previous.benchmarkBar)) {
      add(reasons, "invalid_benchmark_session");
    }
    if (current?.assetBar === null) add(reasons, "missing_current_session");
    else if (current && !positiveAdjustedClose(current.assetBar)) {
      add(reasons, "invalid_current_adjusted_close");
    }
    if (previous?.assetBar === null) add(reasons, "missing_previous_session");
    else if (previous && !positiveAdjustedClose(previous.assetBar)) {
      add(reasons, "invalid_previous_adjusted_close");
    }

    diagnostics = {
      expectedSessionCount: alignment.rows.length,
      missingSessionCount,
      missingRate,
      latestAssetSession: latestValidSessionDate(assetSeries),
      latestBenchmarkSession: latestValidSessionDate(benchmarkSeries),
      sessionGrid: sessionGridSummary(normalizedSessionGrid),
    };
  }

  return {
    version: MOVEMENT_QUALITY_VERSION,
    eligible: reasons.size === 0,
    reasonCodes: ordered(reasons, MOVEMENT_UNAVAILABLE_REASONS),
    warnings: ordered(warnings, MOVEMENT_QUALITY_WARNINGS),
    diagnostics,
    alignment,
  };
}
