import { displaySymbolOf } from "./instrumentFormat.js";

const MOVEMENT_THRESHOLDS = Object.freeze({ gain: 0.5, loss: -0.5 });
const QUALITY_VALUES = Object.freeze(["fresh", "delayed", "stale", "unavailable"]);
const QUALITY_RANK = Object.freeze({ fresh: 0, delayed: 1, stale: 2, unavailable: 3 });

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function resolveSector(instrument) {
  return String(
    instrument?.group
    || instrument?.sector
    || instrument?.category
    || "Other",
  );
}

function resolveSymbol(instrument) {
  return String(instrument?.symbol || instrument?.ticker || instrument?.id || "");
}

function effectiveQuality(tile) {
  const availability = tile?.fieldAvailability?.value || tile?.fieldAvailability?.price;
  const availabilityStatus = typeof availability === "string" ? availability : availability?.status;
  if (!tile
    || tile.hasInfo === false
    || tile.dataQuality?.status === "unusable"
    || ["not_applicable", "unsupported", "temporarily_unavailable", "invalid"].includes(availabilityStatus)
    || !isFiniteNumber(tile.price)) return "unavailable";
  return QUALITY_VALUES.includes(tile.quality) ? tile.quality : "fresh";
}

function effectiveChange(tile) {
  if (isFiniteNumber(tile?.changePercent)) return tile.changePercent;
  return isFiniteNumber(tile?.change) ? tile.change : null;
}

export function selectBoardSamples({ instruments = [], getTile } = {}) {
  const resolve = typeof getTile === "function" ? getTile : () => null;
  return instruments.map((instrument) => {
    const identities = [instrument?.id, instrument?.instrumentId, instrument?.symbol, instrument?.ticker]
      .filter(Boolean);
    let tile = null;
    for (const identity of new Set(identities)) {
      const found = resolve(identity);
      if (found != null) { tile = found; break; }
    }
    const quality = effectiveQuality(tile);
    return {
      instrumentId: String(instrument?.id || instrument?.instrumentId || resolveSymbol(instrument)),
      instrument,
      sector: resolveSector(instrument),
      quality,
      change: effectiveChange(tile),
      price: quality !== "unavailable" && isFiniteNumber(tile?.price) ? tile.price : null,
      tile: tile || null,
    };
  });
}

export function selectBoardSnapshot(samples = []) {
  const changes = samples.map((s) => s.change).filter(isFiniteNumber);
  const n = changes.length;

  const advancing = changes.filter((c) => c > 0).length;
  const declining = changes.filter((c) => c < 0).length;
  const unchanged = changes.filter((c) => c === 0).length;

  const average = n ? changes.reduce((sum, c) => sum + c, 0) / n : null;
  const dispersion = average == null
    ? null
    : Math.sqrt(changes.reduce((sum, c) => sum + (c - average) ** 2, 0) / n);
  const breadth = n ? ((advancing - declining) / n) * 100 : null;

  const bySector = new Map();
  let topMover = null;
  for (const sample of samples) {
    if (!isFiniteNumber(sample.change)) continue;
    const entry = bySector.get(sample.sector) || { total: 0, count: 0 };
    entry.total += sample.change;
    entry.count += 1;
    bySector.set(sample.sector, entry);
    if (topMover === null || Math.abs(sample.change) > Math.abs(topMover.change)) {
      topMover = {
        instrumentId: sample.instrumentId,
        symbol: displaySymbolOf(sample.instrument),
        change: sample.change,
      };
    }
  }
  let leadingSector = null;
  for (const [sector, { total, count }] of bySector) {
    const avg = total / count;
    if (
      leadingSector === null
      || avg > leadingSector.average
      || (avg === leadingSector.average && sector.localeCompare(leadingSector.sector) < 0)
    ) {
      leadingSector = { sector, average: avg, count };
    }
  }

  return { advancing, declining, unchanged, sampleCount: n, breadth, average, dispersion, leadingSector, topMover };
}

export function selectAggregateQuality(samples = []) {
  const total = samples.length;
  const usable = samples.filter((s) => s.quality !== "unavailable").length;
  const live = samples.filter((s) => s.quality === "fresh" || s.quality === "delayed").length;
  const confirmed = samples.filter((s) => s.quality === "stale").length;
  const unavailable = total - usable;

  let state;
  if (total === 0) state = "empty";
  else if (usable === 0) state = "unavailable";
  else if (live === 0) state = "confirmed";
  else if (usable < total) state = "partial";
  else state = "current";

  return { state, total, usable, live, confirmed, unavailable };
}

function matchesMovement(movement, quality, change) {
  switch (movement) {
    case "advancing": return isFiniteNumber(change) && change > 0;
    case "declining": return isFiniteNumber(change) && change < 0;
    case "gaining": return isFiniteNumber(change) && change > MOVEMENT_THRESHOLDS.gain;
    case "losing": return isFiniteNumber(change) && change < MOVEMENT_THRESHOLDS.loss;
    case "neutral":
      return isFiniteNumber(change)
        && change >= MOVEMENT_THRESHOLDS.loss && change <= MOVEMENT_THRESHOLDS.gain;
    case "available": return quality !== "unavailable";
    case "delayed":
    case "stale":
    case "unavailable": return quality === movement;
    default: return true;
  }
}

export function selectFilteredInstrumentIds(samples = [], filters = {}) {
  const search = String(filters.search || "").trim().toLowerCase();
  const assetClass = filters.assetClass || "all";
  const category = filters.category || "all";
  const movement = filters.movement || "all";
  const sort = filters.sort || "default";

  const kept = [];
  samples.forEach((sample, index) => {
    const { instrument, sector, quality, change } = sample;
    const providerSymbols = Object.values(instrument?.providerSymbols || {}).flatMap((mapping) => (
      typeof mapping === "string" ? [mapping] : typeof mapping?.symbol === "string" ? [mapping.symbol] : []
    ));
    const haystack = [
      instrument?.displaySymbol, instrument?.symbol, instrument?.ticker, instrument?.name,
      sector, instrument?.venue?.name, instrument?.venue?.mic, instrument?.exchange,
      instrument?.assetClass, ...providerSymbols,
    ].filter(Boolean).join(" ").toLowerCase();

    let show = !search || haystack.includes(search);
    if (show && assetClass !== "all") show = instrument?.assetClass === assetClass;
    if (show && category !== "all") show = sector === category;
    if (show) show = matchesMovement(movement, quality, change);
    if (show) kept.push({ sample, index });
  });

  const cmpNullable = (a, b, dir) => {
    const hasA = isFiniteNumber(a);
    const hasB = isFiniteNumber(b);
    if (hasA !== hasB) return hasA ? -1 : 1;
    if (!hasA) return 0;
    return (a - b) * dir;
  };

  kept.sort((a, b) => {
    let result = 0;
    switch (sort) {
      case "change-desc": result = cmpNullable(a.sample.change, b.sample.change, -1); break;
      case "change-asc": result = cmpNullable(a.sample.change, b.sample.change, 1); break;
      case "price-desc": result = cmpNullable(a.sample.price, b.sample.price, -1); break;
      case "price-asc": result = cmpNullable(a.sample.price, b.sample.price, 1); break;
      case "ticker":
        result = displaySymbolOf(a.sample.instrument).localeCompare(displaySymbolOf(b.sample.instrument));
        break;
      case "quality":
        result = QUALITY_RANK[a.sample.quality] - QUALITY_RANK[b.sample.quality];
        break;
      default: result = 0;
    }
    return result || a.index - b.index;
  });

  return kept.map(({ sample }) => sample.instrumentId);
}
