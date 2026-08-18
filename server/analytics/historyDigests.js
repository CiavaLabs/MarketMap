import { analyticsSha256 } from "./canonicalDigest.js";

export function historySeriesProjection(series) {
  return {
    instrumentId: series.instrumentId,
    assetClass: series.assetClass,
    range: series.range,
    interval: series.interval,
    priceBasis: series.priceBasis,
    requestedPriceBasis: series.requestedPriceBasis,
    adjustment: series.adjustment,
    continuity: series.continuity,
    session: series.session,
    bars: series.bars.map((bar) => ({
      timestamp: bar.timestamp,
      close: bar.close,
      adjustedClose: bar.adjustedClose ?? null,
      volume: bar.volume ?? null,
    })),
    quality: series.quality,
    dataQuality: series.dataQuality,
    provenance: {
      source: series.provenance?.source ?? null,
      providerSymbol: series.provenance?.providerSymbol ?? null,
      fallback: series.provenance?.fallback ?? null,
      originalSource: series.provenance?.originalSource ?? null,
    },
    asOf: series.asOf,
  };
}

export function historySeriesProjectionFromInput({ manifest, observations }) {
  return {
    instrumentId: manifest.instrumentId,
    assetClass: manifest.assetClass,
    range: manifest.range,
    interval: manifest.interval,
    priceBasis: manifest.priceBasis,
    requestedPriceBasis: manifest.requestedPriceBasis,
    adjustment: manifest.adjustment,
    continuity: manifest.continuity,
    session: manifest.session,
    bars: observations.map((observation, index) => ({
      timestamp: manifest.barTimestamps[index],
      close: observation.bar.providerClose,
      adjustedClose: observation.bar.providerAdjustedClose,
      volume: observation.bar.providerVolume,
    })),
    quality: manifest.quality,
    dataQuality: manifest.dataQuality,
    provenance: {
      source: manifest.provider,
      providerSymbol: manifest.providerSymbol,
      fallback: manifest.fallback,
      originalSource: manifest.originalSource,
    },
    asOf: manifest.sourceAsOf,
  };
}

function dailyObservationDigestPayload({
  manifest,
  observation,
  barTimestamp,
}) {
  return {
    instrumentId: observation.instrumentId,
    sessionDate: observation.sessionDate,
    timestamp: barTimestamp,
    provider: observation.provider,
    providerSymbol: manifest.providerSymbol,
    provenance: {
      source: manifest.provider,
      fallback: manifest.fallback,
    },
    priceBasis: manifest.priceBasis,
    requestedPriceBasis: manifest.requestedPriceBasis,
    adjustment: manifest.adjustment,
    session: manifest.session,
    bar: observation.bar,
  };
}

export function dailyObservationInputHash(value) {
  return analyticsSha256(dailyObservationDigestPayload(value));
}

export function historyObservationFromSeries({
  series,
  bar,
  sessionDate,
  observedAt,
}) {
  const observation = {
    instrumentId: series.instrumentId,
    sessionDate,
    observedAt,
    provider: series.provenance.source,
    bar: {
      providerClose: bar.close,
      providerAdjustedClose: bar.adjustedClose ?? null,
      providerVolume: bar.volume ?? null,
    },
  };
  const manifestMetadata = {
    provider: series.provenance.source,
    providerSymbol: series.provenance.providerSymbol,
    fallback: series.provenance.fallback,
    priceBasis: series.priceBasis,
    requestedPriceBasis: series.requestedPriceBasis,
    adjustment: series.adjustment,
    session: series.session,
  };
  return {
    ...observation,
    inputHash: dailyObservationInputHash({
      manifest: manifestMetadata,
      observation,
      barTimestamp: bar.timestamp,
    }),
  };
}

export function historySeriesHash(normalizedSeries, sessionGridHash) {
  return analyticsSha256({ normalizedSeries, sessionGridHash });
}
