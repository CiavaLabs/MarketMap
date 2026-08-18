import { nyseCalendar } from "../../../server/analytics/data/nyseCalendar.js";

export function deterministicReturns(count, scale = 0.0008) {
  return Array.from({ length: count }, (_, index) => {
    const cycle = (index % 11) - 5;
    const offset = index % 2 === 0 ? -0.0002 : 0.0003;
    return cycle * scale + offset;
  });
}

export function historyFromReturns({
  instrumentId,
  assetClass,
  returns,
  start = "2023-01-02T21:00:00.000Z",
  initialPrice = 100,
  quality = "fresh",
  issues = [],
  droppedRows = 0,
  timeZone = "America/New_York",
  fetchedAt = null,
} = {}) {
  const bars = [];
  let price = initialPrice;
  let cursor = Date.parse(start);
  for (let index = 0; index <= returns.length; index += 1) {
    if (index > 0) price *= Math.exp(returns[index - 1]);
    while (!nyseCalendar.isSession(new Date(cursor).toISOString().slice(0, 10))) {
      cursor += 86_400_000;
    }
    const timestamp = new Date(cursor).toISOString();
    cursor += 86_400_000;
    bars.push({
      timestamp,
      open: price,
      high: price,
      low: price,
      close: price,
      adjustedClose: price,
      displayClose: price,
      volume: 1_000_000 + index,
    });
  }
  return {
    instrumentId,
    assetClass,
    range: "5y",
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
    session: { model: "exchange_hours", timezone: timeZone },
    bars,
    events: [],
    quality,
    dataQuality: {
      status: issues.length ? "usable_with_warnings" : "usable",
      rowCount: bars.length,
      droppedRows,
      missingAdjustedCloseRows: 0,
      issues,
    },
    provenance: {
      source: "yahoo",
      providerSymbol: instrumentId.split(":").at(-1),
      fallback: false,
    },
    asOf: bars.at(-1).timestamp,
    fetchedAt: fetchedAt || bars.at(-1).timestamp,
  };
}

export function sessionGridFromSeries(series, {
  source = "deterministic-test-calendar",
  revision = "fixture@1",
} = {}) {
  return {
    calendarId: "US_EQUITIES_CORE",
    source,
    revision,
    timeZone: series.session.timezone,
    sessionDates: series.bars.map(({ timestamp }) => timestamp.slice(0, 10)),
  };
}

export function movementFixture(returnCount = 817) {
  const returns = deterministicReturns(returnCount);
  const assetSeries = historyFromReturns({
    instrumentId: "XNAS:AAPL",
    assetClass: "equity",
    returns,
  });
  const benchmarkSeries = historyFromReturns({
    instrumentId: "ARCX:SPY",
    assetClass: "etf",
    returns: deterministicReturns(returnCount, 0.0002),
    initialPrice: 400,
  });
  return {
    assetSeries,
    benchmarkSeries,
    sessionGrid: sessionGridFromSeries(benchmarkSeries),
  };
}
