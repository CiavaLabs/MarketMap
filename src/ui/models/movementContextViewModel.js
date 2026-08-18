import { dateTimeFormat } from "../../utils/intlFormats.js";

const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WARNING_LABELS = Object.freeze({
  provider_distributions_unknown: "Provider does not certify dividend treatment",
  dropped_rows_observed: "Provider dropped invalid rows upstream",
  partial_adjusted_history: "Adjusted history is partially populated",
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function isSessionDate(value) {
  return typeof value === "string" && SESSION_DATE.test(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fixed(value, decimals) {
  const text = value.toFixed(decimals);
  return /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text;
}

function signedFixed(value, decimals) {
  const text = fixed(value, decimals);
  return value > 0 && rendersNonZero(value, decimals) ? `+${text}` : text;
}

function rendersNonZero(value, decimals) {
  return Math.abs(Number(value.toFixed(decimals))) > 0;
}

function exceedanceCount(rate, scoreCount) {
  const rank = rate * (scoreCount + 1);
  const rounded = Math.round(rank);
  if (Math.abs(rank - rounded) > 1e-9 || rounded < 1 || rounded > scoreCount + 1) return null;
  return rounded - 1;
}

const FIXTURE_CALENDAR_SUFFIX = "_dev_fixture";

function isFixtureCalendar(sessionGrid) {
  return sessionGrid.source.endsWith(FIXTURE_CALENDAR_SUFFIX);
}

function sessionCalendarLabel(sessionGrid) {
  return isFixtureCalendar(sessionGrid)
    ? "Development fixture · derived from the benchmark's own history"
    : `${sessionGrid.source} · rev ${sessionGrid.revision}`;
}

export function sessionDateForQuote(timestamp, timeZone) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || !nonEmptyString(timeZone)) return null;
  try {
    const parts = dateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(parsed));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const sessionDate = `${values.year}-${values.month}-${values.day}`;
    return isSessionDate(sessionDate) ? sessionDate : null;
  } catch {
    return null;
  }
}

function movementRows({ evidence, forecast }) {
  return [
    {
      id: "return",
      label: "Adjusted close-to-close return",
      value: `${signedFixed(evidence.observed.simpleReturn * 100, 2)}%`,
    },
    {
      id: "volatility",
      label: "EWMA daily volatility forecast",
      value: `${fixed(forecast.dailyVolatility * 100, 2)}% daily (estimated)`,
    },
    {
      id: "standardized",
      label: "Move / forecast volatility",
      value: `${signedFixed(evidence.standardizedReturn, 2)}×`,
    },
  ];
}

function rarityBand({ evidence }) {
  const { scoreCount } = evidence.reference;
  const exceedances = exceedanceCount(evidence.empiricalExceedanceRate, scoreCount);
  return {
    label: "Empirical percentile",
    value: `${fixed(evidence.historicalRarityPercentile, 1)}th`,
    fraction: evidence.historicalRarityPercentile / 100,
    exceedance: `${exceedances} of ${scoreCount} prior moves were at least as large`,
  };
}

function windowRows({ forecast, evidence }) {
  const { reference } = evidence;
  return [
    { id: "information-set", label: "Forecast information set", value: `Through ${forecast.informationSetEnd}` },
    {
      id: "reference",
      label: "Reference window",
      value: `${reference.scoreCount} prior scores · ${reference.startSessionDate} → ${reference.endSessionDate}`,
    },
  ];
}

function methodologyRows({ assessment, forecast, evidence }) {
  const { quality } = assessment;
  const { scoreCount } = evidence.reference;
  const exceedances = exceedanceCount(evidence.empiricalExceedanceRate, scoreCount);
  const distributionsUnknown = (quality.warnings || [])
    .includes("provider_distributions_unknown");
  const sourceLabel = quality.historySource === "yahoo"
    ? "Yahoo Finance"
    : quality.historySource;
  const rows = [
    {
      id: "standardization",
      label: "Standardization",
      value: "Log return ÷ EWMA volatility; the percentage above is the simple return",
    },
    {
      id: "empirical-rate",
      label: "Empirical rate",
      value: `${exceedances + 1}/${scoreCount + 1} · plus-one correction`,
    },
    {
      id: "history-source",
      label: "History source",
      value: `${sourceLabel} · provider-adjusted close${distributionsUnknown ? " · distributions unknown" : ""}`,
    },
    {
      id: "session-calendar",
      label: "Session calendar",
      value: sessionCalendarLabel(quality.sessionGrid),
    },
    {
      id: "model",
      label: "Model",
      value: `EWMA (λ = ${forecast.model.lambda}, zero mean) · ${assessment.methodVersion}`,
    },
  ];
  const warnings = (quality.warnings || [])
    .map((code) => WARNING_LABELS[code] || code);
  if (warnings.length) rows.push({ id: "warnings", label: "Warnings", value: warnings.join("; ") });
  return rows;
}

function displayable(assessment) {
  if (assessment?.schemaVersion !== 1 || assessment.status !== "available") return false;
  const { forecast, evidence, quality } = assessment;
  return isSessionDate(assessment.sessionDate)
    && nonEmptyString(assessment.methodVersion)
    && finite(evidence?.observed?.simpleReturn)
    && evidence.observed.simpleReturn > -1
    && evidence.observed.priceBasis === "provider_adjusted"
    && finite(forecast?.dailyVolatility)
    && forecast.dailyVolatility > 0
    && rendersNonZero(forecast.dailyVolatility * 100, 2)
    && finite(evidence.standardizedReturn)
    && finite(evidence.historicalRarityPercentile)
    && evidence.historicalRarityPercentile >= 0
    && evidence.historicalRarityPercentile <= 100
    && Number.isInteger(evidence.reference?.scoreCount)
    && evidence.reference.scoreCount > 0
    && finite(evidence.empiricalExceedanceRate)
    && exceedanceCount(evidence.empiricalExceedanceRate, evidence.reference.scoreCount) !== null
    && Math.abs(100 * (1 - evidence.empiricalExceedanceRate)
      - evidence.historicalRarityPercentile) < 1e-9
    && isSessionDate(evidence.reference.startSessionDate)
    && isSessionDate(evidence.reference.endSessionDate)
    && evidence.reference.startSessionDate < evidence.reference.endSessionDate
    && evidence.reference.endSessionDate < assessment.sessionDate
    && isSessionDate(forecast.informationSetEnd)
    && forecast.informationSetEnd < assessment.sessionDate
    && finite(forecast.model?.lambda)
    && forecast.model.lambda > 0
    && forecast.model.lambda < 1
    && quality?.historySource === "yahoo"
    && quality.adjustmentMode === "provider_adjusted"
    && nonEmptyString(quality.sessionGrid?.source)
    && nonEmptyString(quality.sessionGrid?.revision);
}

export function buildMovementContext(record, { quoteSessionDate = null } = {}) {
  try {
    const assessment = record?.assessment;
    if (!displayable(assessment)) return null;
    const { forecast, evidence } = assessment;
    return {
      title: "Statistical context",
      badge: "End of day",
      sessionDate: assessment.sessionDate,
      subtitle: `Movement for the completed ${assessment.sessionDate} session, measured against volatility estimated from data available through ${forecast.informationSetEnd}.`,
      note: isSessionDate(quoteSessionDate) && quoteSessionDate !== assessment.sessionDate
        ? `Refers to the completed ${assessment.sessionDate} session, not the ${quoteSessionDate} session shown by the live quote.`
        : null,
      advisory: isFixtureCalendar(assessment.quality.sessionGrid)
        ? "The session calendar behind these figures is a development fixture, not an exchange calendar: the assessed session may still be open and the numbers are provisional."
        : null,
      movement: movementRows({ evidence, forecast }),
      rarity: rarityBand({ evidence }),
      windows: windowRows({ forecast, evidence }),
      methodology: methodologyRows({ assessment, forecast, evidence }),
    };
  } catch {
    return null;
  }
}
