import { describe, expect, it } from "vitest";
import {
  alignDailySeries,
  assessSeriesQuality,
  isValidTimeZone,
  sessionDateFromTimestamp,
} from "../../../server/analytics/index.js";
import {
  deterministicReturns,
  movementFixture,
} from "./fixtures.js";

describe("session-date mapping", () => {
  it("maps US close instants across the daylight-saving boundary", () => {
    expect(sessionDateFromTimestamp(
      "2026-03-06T21:00:00.000Z",
      "America/New_York",
    )).toBe("2026-03-06");
    expect(sessionDateFromTimestamp(
      "2026-03-09T20:00:00.000Z",
      "America/New_York",
    )).toBe("2026-03-09");
    expect(sessionDateFromTimestamp(
      "2026-07-14T00:30:00.000Z",
      "America/New_York",
    )).toBe("2026-07-13");
  });

  it("validates the actual IANA timezone rather than only its string shape", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("America/Definitely_Not_A_Zone")).toBe(false);
    expect(() => sessionDateFromTimestamp(
      "2026-07-14T20:00:00.000Z",
      "America/Definitely_Not_A_Zone",
    )).toThrow(TypeError);
  });
});

describe("daily alignment and structural quality", () => {
  it("retains a missing asset session as an explicit null row", () => {
    const fixture = movementFixture(10);
    fixture.assetSeries.bars.splice(4, 1);
    fixture.assetSeries.asOf = fixture.assetSeries.bars.at(-1).timestamp;
    const alignment = alignDailySeries(fixture);

    expect(alignment.rows).toHaveLength(11);
    expect(alignment.missingAssetSessionDates).toHaveLength(1);
    expect(alignment.rows.find(({ assetBar }) => assetBar === null)?.sessionDate)
      .toBe(alignment.missingAssetSessionDates[0]);
  });

  it("detects two distinct timestamps that collapse onto one session date", () => {
    const fixture = movementFixture(10);
    fixture.assetSeries.bars[4].timestamp = new Date(
      Date.parse(fixture.assetSeries.bars[3].timestamp) + 60 * 60_000,
    ).toISOString();
    const assessment = assessSeriesQuality(fixture);

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasonCodes).toContain("duplicate_session_date");
  });

  it("rejects a malformed timezone without attempting alignment", () => {
    const fixture = movementFixture(10);
    fixture.assetSeries.session.timezone = "America/Definitely_Not_A_Zone";
    const assessment = assessSeriesQuality(fixture);

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasonCodes).toContain("invalid_timezone");
    expect(assessment.alignment).toBeNull();
  });

  it("does not silently accept an observed date absent from the certified grid", () => {
    const fixture = movementFixture(10);
    fixture.sessionGrid.sessionDates.splice(4, 1);
    const assessment = assessSeriesQuality(fixture);

    expect(assessment.reasonCodes).toContain("unexpected_asset_session");
    expect(assessment.reasonCodes).toContain("unexpected_benchmark_session");
  });

  it("keeps a one-session historical gap below the explicit one-percent gate", () => {
    const fixture = movementFixture(821);
    fixture.assetSeries.bars.splice(100, 1);
    fixture.assetSeries.dataQuality.droppedRows = 1;
    fixture.assetSeries.dataQuality.rowCount -= 1;
    fixture.assetSeries.dataQuality.status = "usable_with_warnings";
    fixture.assetSeries.dataQuality.issues = [{
      code: "row_dropped_invalid_ohlc",
      severity: "warning",
      field: null,
    }];
    const assessment = assessSeriesQuality(fixture);

    expect(assessment.eligible).toBe(true);
    expect(assessment.diagnostics.missingSessionCount).toBe(1);
    expect(assessment.diagnostics.missingRate).toBeCloseTo(1 / 822);
    expect(assessment.warnings).toContain("dropped_rows_observed");
  });

  it("does not depend on the numerical benchmark returns to define the grid", () => {
    const fixture = movementFixture(10);
    fixture.benchmarkSeries = {
      ...fixture.benchmarkSeries,
      bars: fixture.benchmarkSeries.bars.map((bar, index) => ({
        ...bar,
        adjustedClose: 400 * Math.exp(deterministicReturns(10, 0.5)[index - 1] || 0),
      })),
    };

    expect(alignDailySeries(fixture).sessionGridDates).toHaveLength(11);
  });

  it("keeps a provider-wide missing date visible on the certified grid", () => {
    const fixture = movementFixture(10);
    fixture.assetSeries.bars.splice(4, 1);
    fixture.benchmarkSeries.bars.splice(4, 1);

    const alignment = alignDailySeries(fixture);
    const missingRow = alignment.rows[4];

    expect(missingRow).toMatchObject({
      sessionDate: fixture.sessionGrid.sessionDates[4],
      assetBar: null,
      benchmarkBar: null,
    });
    expect(alignment.missingAssetSessionDates).toContain(missingRow.sessionDate);
    expect(alignment.missingBenchmarkSessionDates).toContain(missingRow.sessionDate);
  });

  it("withholds eligibility when no certified session grid is supplied", () => {
    const fixture = movementFixture(10);
    delete fixture.sessionGrid;

    const assessment = assessSeriesQuality(fixture);

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasonCodes).toContain("uncertified_session_grid");
    expect(assessment.alignment).toBeNull();
  });

  it.each([
    ["asset", "assetSeries", "asset_session_after_grid"],
    ["benchmark", "benchmarkSeries", "benchmark_session_after_grid"],
  ])("returns unavailable when a %s observation follows the certified grid", (
    _,
    seriesKey,
    reason,
  ) => {
    const fixture = movementFixture(10);
    const extra = structuredClone(fixture[seriesKey].bars.at(-1));
    extra.timestamp = new Date(
      Date.parse(extra.timestamp) + 86_400_000,
    ).toISOString();
    fixture[seriesKey].bars.push(extra);
    fixture[seriesKey].asOf = extra.timestamp;
    fixture[seriesKey].dataQuality.rowCount += 1;

    const assessment = assessSeriesQuality(fixture);

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasonCodes).toContain(reason);
  });
});
