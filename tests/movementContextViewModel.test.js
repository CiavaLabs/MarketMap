import { describe, expect, it } from "vitest";

import {
  buildMovementContext,
  sessionDateForQuote,
} from "../src/ui/models/movementContextViewModel.js";
import { movementAnalyticsRecord as record } from "./fixtures/movementAnalyticsRecord.js";

describe("movement context view model", () => {
  it("renders the measured quantities with plan-mandated precision and wording", () => {
    const context = buildMovementContext(record());
    expect(context.title).toBe("Statistical context");
    expect(context.badge).toBe("End of day");
    expect(context.sessionDate).toBe("2026-07-27");
    expect(context.movement).toEqual([
      { id: "return", label: "Adjusted close-to-close return", value: "+2.34%" },
      { id: "volatility", label: "EWMA daily volatility forecast", value: "1.12% daily (estimated)" },
      { id: "standardized", label: "Move / forecast volatility", value: "+2.07×" },
    ]);
    const text = JSON.stringify(context);
    for (const banned of ["cause", "confidence", "significant", "p-value", "probability"]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("gives the percentile its own band, never separated from the exceedance count", () => {
    const context = buildMovementContext(record());
    expect(context.rarity).toEqual({
      label: "Empirical percentile",
      value: "97.4th",
      fraction: 100 * (1 - (20 / 757)) / 100,
      exceedance: "19 of 756 prior moves were at least as large",
    });
    expect(context.rarity.fraction).toBeGreaterThanOrEqual(0);
    expect(context.rarity.fraction).toBeLessThanOrEqual(1);
  });

  it("always names windows, sources, calendar revision, and model version", () => {
    const context = buildMovementContext(record());
    expect(context.windows).toEqual([
      { id: "information-set", label: "Forecast information set", value: "Through 2026-07-24" },
      { id: "reference", label: "Reference window", value: "756 prior scores · 2023-07-25 → 2026-07-24" },
    ]);
    expect(context.methodology).toEqual([
      {
        id: "standardization",
        label: "Standardization",
        value: "Log return ÷ EWMA volatility; the percentage above is the simple return",
      },
      { id: "empirical-rate", label: "Empirical rate", value: "20/757 · plus-one correction" },
      {
        id: "history-source",
        label: "History source",
        value: "Yahoo Finance · provider-adjusted close · distributions unknown",
      },
      { id: "session-calendar", label: "Session calendar", value: "host-calendar · rev 2026-07-28" },
      { id: "model", label: "Model", value: "EWMA (λ = 0.94, zero mean) · movement-ewma-empirical@1" },
      { id: "warnings", label: "Warnings", value: "Provider does not certify dividend treatment" },
    ]);
  });

  it("notes a session mismatch instead of restyling live data", () => {
    const matched = buildMovementContext(record(), { quoteSessionDate: "2026-07-27" });
    expect(matched.note).toBeNull();
    const mismatched = buildMovementContext(record(), { quoteSessionDate: "2026-07-28" });
    expect(mismatched.note).toBe(
      "Refers to the completed 2026-07-27 session, not the 2026-07-28 session shown by the live quote.",
    );
  });

  it("omits everything rather than rendering a partial or fabricated section", () => {
    expect(buildMovementContext(null)).toBeNull();
    expect(buildMovementContext({})).toBeNull();
    const cases = [
      (value) => { value.assessment.status = "unavailable"; },
      (value) => { value.assessment.sessionDate = null; },
      (value) => { value.assessment.evidence.observed.simpleReturn = Number.NaN; },
      (value) => { value.assessment.evidence.observed.priceBasis = "raw"; },
      (value) => { value.assessment.forecast.dailyVolatility = 0; },
      (value) => { value.assessment.evidence.standardizedReturn = Infinity; },
      (value) => { value.assessment.evidence.historicalRarityPercentile = 101; },
      (value) => { value.assessment.evidence.reference.scoreCount = 0; },
      (value) => { value.assessment.evidence.reference.endSessionDate = "2026-07-27"; },
      (value) => { value.assessment.forecast.model.lambda = 1; },
      (value) => { value.assessment.quality.historySource = "finnhub"; },
      (value) => { value.assessment.quality.sessionGrid = null; },
      (value) => { value.assessment.forecast = null; },
      (value) => { value.assessment.forecast.dailyVolatility = 4e-5; },
      (value) => { value.assessment.evidence.empiricalExceedanceRate = 0.0271; },
      (value) => { value.assessment.evidence.historicalRarityPercentile = 99.1; },
    ];
    for (const mutate of cases) {
      expect(buildMovementContext(record(mutate))).toBeNull();
    }
  });

  it("states the exceedance count so the percentile grid is not read as continuous", () => {
    const rarest = buildMovementContext(record((value) => {
      value.assessment.evidence.empiricalExceedanceRate = 1 / 757;
      value.assessment.evidence.historicalRarityPercentile = 100 * (1 - (1 / 757));
    }));
    expect(rarest.rarity.value).toBe("99.9th");
    expect(rarest.rarity.exceedance).toBe("0 of 756 prior moves were at least as large");
    expect(rarest.methodology).toContainEqual({
      id: "empirical-rate",
      label: "Empirical rate",
      value: "1/757 · plus-one correction",
    });
  });

  it("warns in plain words when the calendar is a development fixture", () => {
    expect(buildMovementContext(record()).advisory).toBeNull();
    const fixture = buildMovementContext(record((value) => {
      value.assessment.quality.sessionGrid.source = "derived_from_benchmark_history_dev_fixture";
    }));
    expect(fixture.advisory).toContain("provisional");
    expect(fixture.methodology).toContainEqual({
      id: "session-calendar",
      label: "Session calendar",
      value: "Development fixture · derived from the benchmark's own history",
    });
    expect(JSON.stringify(fixture)).not.toContain("_dev_fixture");
  });

  it("never emits a signed zero and keeps the sign on losses", () => {
    const flat = buildMovementContext(record((value) => {
      value.assessment.evidence.observed.simpleReturn = -0.0000004;
      value.assessment.evidence.standardizedReturn = -0.00004;
    }));
    expect(flat.movement[0].value).toBe("0.00%");
    expect(flat.movement[2].value).toBe("0.00×");

    const flatGain = buildMovementContext(record((value) => {
      value.assessment.evidence.observed.simpleReturn = 0.0000004;
      value.assessment.evidence.standardizedReturn = 0.00004;
    }));
    expect(flatGain.movement[0].value).toBe("0.00%");
    expect(flatGain.movement[2].value).toBe("0.00×");

    const loss = buildMovementContext(record((value) => {
      value.assessment.evidence.observed.simpleReturn = -0.0312;
      value.assessment.evidence.standardizedReturn = -2.71;
    }));
    expect(loss.movement[0].value).toBe("-3.12%");
    expect(loss.movement[2].value).toBe("-2.71×");
  });

  it("keeps extreme but finite values in plain decimal notation", () => {
    const crash = buildMovementContext(record((value) => {
      value.assessment.evidence.observed.simpleReturn = -0.4218;
      value.assessment.evidence.observed.logReturn = Math.log(1 - 0.4218);
      value.assessment.forecast.dailyVolatility = 0.00915;
      value.assessment.evidence.standardizedReturn = -59.8374;
      value.assessment.evidence.absoluteStandardizedReturn = 59.8374;
    }));
    expect(crash.movement.map(({ value }) => value)).toEqual([
      "-42.18%",
      "0.92% daily (estimated)",
      "-59.84×",
    ]);
    expect(crash.rarity.value).toBe("97.4th");
    expect(JSON.stringify(crash)).not.toMatch(/e[+-]\d/u);
  });

  it("derives the quote session date in the exchange timezone", () => {
    expect(sessionDateForQuote("2026-07-14T01:30:00.000Z", "America/New_York")).toBe("2026-07-13");
    expect(sessionDateForQuote("2026-07-14T01:30:00.000Z", "not-a-zone")).toBeNull();
    expect(sessionDateForQuote("garbage", "America/New_York")).toBeNull();
    expect(sessionDateForQuote("2026-07-14T01:30:00.000Z", null)).toBeNull();
  });
});
