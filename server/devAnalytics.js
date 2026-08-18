import { DAILY_ANALYTICS_CUTOFF_UTC } from "./analytics/DailyAnalyticsRunner.js";
import { MOVEMENT_BENCHMARK_INSTRUMENT_ID } from "./analytics/contracts/constants.js";
import { reconcileSessionGrid } from "./analytics/data/exchangeCalendar.js";
import { nyseCalendar } from "./analytics/data/nyseCalendar.js";
import { sessionDateFromTimestamp } from "./analytics/data/sessionDate.js";

const BENCHMARK_HISTORY_REQUEST = Object.freeze({
  range: "5y",
  interval: "1d",
  priceBasis: "provider_adjusted",
});

const [CUTOFF_HOURS, CUTOFF_MINUTES] = DAILY_ANALYTICS_CUTOFF_UTC
  .split(":")
  .map(Number);

function utcDate(sessionDate) {
  return new Date(`${sessionDate}T00:00:00.000Z`);
}

function addDays(sessionDate, days) {
  const date = utcDate(sessionDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextSessionAfter(sessionDate) {
  let candidate = addDays(sessionDate, 1);
  while (!nyseCalendar.isSession(candidate)) candidate = addDays(candidate, 1);
  return candidate;
}

function latestClosedSession(now) {
  let candidate = now.toISOString().slice(0, 10);
  while (!nyseCalendar.isSession(candidate) || now < sessionCutoff(candidate)) {
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

function sessionCutoff(sessionDate) {
  return new Date(`${sessionDate}T${DAILY_ANALYTICS_CUTOFF_UTC}:00.000Z`);
}

export function devMovementCohort(instruments = []) {
  return instruments
    .filter(({ assetClass, id }) => (
      assetClass === "equity" && id !== MOVEMENT_BENCHMARK_INSTRUMENT_ID
    ))
    .map(({ id }) => id);
}

export function devRunInstant(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCHours(CUTOFF_HOURS, CUTOFF_MINUTES, 0, 0);
  return now >= cutoff ? new Date(now) : cutoff;
}

export function deriveDevSessionAuthority(benchmarkSeries, now = new Date()) {
  const bars = Array.isArray(benchmarkSeries?.bars) ? benchmarkSeries.bars : [];
  if (bars.length < 2) {
    throw new TypeError("Benchmark history is too short to reconcile against the calendar");
  }
  const observedSessionDates = [...new Set(bars.map(({ timestamp }) => (
    sessionDateFromTimestamp(timestamp, nyseCalendar.timeZone)
  )))].sort();

  const recordedDate = devRunInstant(now).toISOString().slice(0, 10);
  const completedSessionDate = latestClosedSession(now);
  const sessionGrid = nyseCalendar.sessionGridFor({
    from: observedSessionDates[0],
    to: completedSessionDate,
  });
  const reconciliation = reconcileSessionGrid({ sessionGrid, observedSessionDates });
  if (!reconciliation.reconciled) {
    throw new Error(
      `Session calendar ${nyseCalendar.calendarId} disagrees with the market it describes: `
      + `${reconciliation.missingFromCalendar.length} traded session(s) it does not list `
      + `(${reconciliation.missingFromCalendar.slice(0, 5).join(", ") || "none"}) and `
      + `${reconciliation.absentFromMarket.length} listed session(s) that did not trade `
      + `(${reconciliation.absentFromMarket.slice(0, 5).join(", ") || "none"}).`,
    );
  }

  return {
    completedSessionDate,
    nextSessionDate: nextSessionAfter(
      recordedDate > completedSessionDate ? recordedDate : completedSessionDate,
    ),
    sessionGrid,
    reconciliation,
  };
}

export async function runDevAnalytics(market, { now = new Date() } = {}) {
  const batch = await market.getHistoryBatch(
    [MOVEMENT_BENCHMARK_INSTRUMENT_ID],
    { ...BENCHMARK_HISTORY_REQUEST },
  );
  const benchmark = (batch?.data || []).find(({ instrumentId }) => (
    instrumentId === MOVEMENT_BENCHMARK_INSTRUMENT_ID
  ));
  if (!benchmark) {
    throw new Error(
      `Benchmark history for ${MOVEMENT_BENCHMARK_INSTRUMENT_ID} is unavailable`,
      { cause: batch?.errors?.[0] },
    );
  }
  return market.runDailyAnalytics(deriveDevSessionAuthority(benchmark, now));
}

const BOOTSTRAP_DELAY_MS = 5_000;

export async function startDevAnalyticsBootstrap({
  market,
  log = console,
  delayMs = BOOTSTRAP_DELAY_MS,
} = {}) {
  if (delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, delayMs).unref?.(); });
  const now = new Date();
  const runInstant = devRunInstant(now);
  if (runInstant.getTime() !== now.getTime()) {
    log.warn(
      `Analytics: before the ${DAILY_ANALYTICS_CUTOFF_UTC} UTC cutoff, so the run is recorded at ${runInstant.toISOString()}. `
      + "It assesses the last session the clock says is closed.",
    );
  }
  log.log("Analytics: computing the local ledger from the board's equities");
  return runDevAnalytics(market, { now }).then(
    (summary) => {
      log.log(
        `Analytics: ${summary.status} for session ${summary.completedSessionDate} — `
        + `${summary.counts.available}/${summary.counts.requested} assessments available`,
      );
      return summary;
    },
    (error) => {
      log.error("Analytics: the local run failed, the ledger stays empty", error);
      return null;
    },
  );
}
