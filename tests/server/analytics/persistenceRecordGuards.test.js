import { describe, expect, it } from "vitest";

import {
  normalizeDailyObservationInput,
  normalizeDailyObservationRecord,
  normalizeDigest,
  normalizeForecastOrigin,
  normalizeForecastRecord,
  normalizeHistoryInputRecord,
  normalizeHistoryManifestRecord,
  normalizeInstrumentId,
  normalizeNonEmptyString,
  normalizeRunAttemptRecord,
  normalizeSessionDate,
  toAnalyticsIsoTimestamp,
} from "../../../server/analytics/persistence/records.js";
import {
  HASH,
  OBSERVATION,
  analyticsRecords,
  digest,
  historyInput,
  historyManifest,
  runAttempt,
} from "./persistenceFixtures.js";

const observation = (patch = {}) => ({ ...OBSERVATION, bar: { ...OBSERVATION.bar }, ...patch });

function mutated(build, mutate) {
  const value = structuredClone(build());
  mutate(value);
  return value;
}

describe("scalar normalizers", () => {
  it.each([
    ["a plain UTC instant", "2026-07-28T00:05:00.000Z", "2026-07-28T00:05:00.000Z"],
    ["a second-precision instant", "2026-07-28T00:05:00Z", "2026-07-28T00:05:00.000Z"],
    ["an offset instant", "2026-07-28T02:05:00+02:00", "2026-07-28T00:05:00.000Z"],
    ["a MySQL DATETIME", "2026-07-28 00:05:00", "2026-07-28T00:05:00.000Z"],
    ["a Date", new Date("2026-07-28T00:05:00.000Z"), "2026-07-28T00:05:00.000Z"],
  ])("accepts %s", (_label, value, expected) => {
    expect(toAnalyticsIsoTimestamp(value, "observedAt")).toBe(expected);
  });

  it.each([
    ["a date without a time", "2026-07-28"],
    ["a number", 1_784_061_540_000],
    ["null", null],
    ["an impossible calendar date", "2026-02-30T00:00:00.000Z"],
    ["an out-of-range UTC offset", "2026-07-28T00:05:00+14:30"],
  ])("rejects %s as a timestamp", (_label, value) => {
    expect(() => toAnalyticsIsoTimestamp(value, "observedAt")).toThrowError(TypeError);
  });

  it("rejects an unparseable Date", () => {
    expect(() => toAnalyticsIsoTimestamp(new Date("nope"), "observedAt"))
      .toThrowError(TypeError);
  });

  it.each([
    ["a Date", new Date("2026-07-28T00:00:00.000Z"), "2026-07-28"],
    ["a plain string", "2026-07-28", "2026-07-28"],
  ])("accepts %s as a session date", (_label, value, expected) => {
    expect(normalizeSessionDate(value)).toBe(expected);
  });

  it.each([
    ["an invalid Date", new Date("nope")],
    ["a malformed string", "28-07-2026"],
    ["an impossible day", "2026-02-30"],
    ["an impossible month", "2026-13-01"],
    ["a number", 20_260_728],
  ])("rejects %s as a session date", (_label, value) => {
    expect(() => normalizeSessionDate(value)).toThrowError(TypeError);
  });

  it.each([
    ["a lowercase id", "xnas:aapl"],
    ["a bare symbol", "AAPL"],
    ["an over-long id", `XNAS:${"A".repeat(200)}`],
    ["a non-string", 42],
  ])("rejects %s as an instrument ID", (_label, value) => {
    expect(() => normalizeInstrumentId(value)).toThrowError(TypeError);
  });

  it("trims a string and enforces its maximum length", () => {
    expect(normalizeNonEmptyString("  yahoo  ", "provider")).toBe("yahoo");
    expect(() => normalizeNonEmptyString("   ", "provider")).toThrowError(TypeError);
    expect(() => normalizeNonEmptyString(7, "provider")).toThrowError(TypeError);
    expect(() => normalizeNonEmptyString("yahoo", "provider", { maximumLength: 2 }))
      .toThrowError(/must not exceed 2 characters/u);
  });

  it.each([
    ["a truncated digest", "sha256:abc"],
    ["an unprefixed digest", "a".repeat(64)],
    ["a non-string", null],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeDigest(value, "inputHash")).toThrowError(TypeError);
  });

  it("accepts only the two forecast origins", () => {
    expect(normalizeForecastOrigin("live")).toBe("live");
    expect(normalizeForecastOrigin("backfill")).toBe("backfill");
    expect(() => normalizeForecastOrigin("replay")).toThrowError(/live or backfill/u);
  });
});

describe("daily observation guards", () => {
  it("normalizes a valid observation", () => {
    expect(normalizeDailyObservationInput(observation())).toEqual(OBSERVATION);
  });

  it.each([
    ["a non-object", null],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeDailyObservationInput(value)).toThrowError(/must be an object/u);
  });

  it("rejects an unsupported key on the record or its bar", () => {
    expect(() => normalizeDailyObservationInput(observation({ extra: 1 })))
      .toThrowError(/Daily observation.extra is not supported/u);
    expect(() => normalizeDailyObservationInput(observation({
      bar: { ...OBSERVATION.bar, rawClose: 1 },
    }))).toThrowError(/rawClose is not supported/u);
  });

  it.each([
    ["a non-object bar", { bar: null }],
    ["a non-numeric close", { bar: { providerClose: "214", providerAdjustedClose: 1, providerVolume: 1 } }],
    ["a non-finite close", { bar: { providerClose: Number.NaN, providerAdjustedClose: 1, providerVolume: 1 } }],
    ["a non-finite adjusted close", { bar: { providerClose: 1, providerAdjustedClose: "1", providerVolume: 1 } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => normalizeDailyObservationInput(observation(patch))).toThrowError(TypeError);
  });

  it("rejects a negative volume", () => {
    expect(() => normalizeDailyObservationInput(observation({
      bar: { ...OBSERVATION.bar, providerVolume: -1 },
    }))).toThrowError(RangeError);
  });

  it("accepts null for the optional bar fields", () => {
    const sparse = observation({
      bar: { providerClose: 1, providerAdjustedClose: null, providerVolume: null },
    });
    expect(normalizeDailyObservationInput(sparse).bar).toEqual({
      providerClose: 1,
      providerAdjustedClose: null,
      providerVolume: null,
    });
  });

  it.each([
    ["a missing revision", undefined],
    ["a zero revision", 0],
    ["a fractional revision", 1.5],
  ])("rejects %s on a stored record", (_label, revision) => {
    expect(() => normalizeDailyObservationRecord({ ...observation(), revision }))
      .toThrowError(/revision must be a positive integer/u);
  });
});

describe("forecast record guards", () => {
  const forecast = () => analyticsRecords().forecast;

  it.each([
    ["an unsupported key", (f) => { f.extra = 1; }, /Forecast record.extra is not supported/u],
    ["an information set on the target session", (f) => {
      f.informationSetEnd = f.targetSessionDate;
      f.forecast.informationSetEnd = f.targetSessionDate;
    }, /must precede targetSessionDate/u],
    ["an unsupported forecast key", (f) => { f.forecast.extra = 1; }, /forecast.extra is not supported/u],
    ["a forecast information set that contradicts the wrapper", (f) => {
      f.forecast.informationSetEnd = f.forecast.originSessionDate;
      f.informationSetEnd = "2025-03-27";
    }, /must match its wrapper/u],
    ["a live forecast recorded on or after its target", (f) => {
      f.origin = "live";
      f.recordedAt = `${f.targetSessionDate}T12:00:00.000Z`;
    }, /inconsistent with recordedAt/u],
    ["a backfill forecast recorded before its target", (f) => {
      f.recordedAt = "2025-03-01T12:00:00.000Z";
    }, /inconsistent with recordedAt/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expect(() => normalizeForecastRecord(mutated(forecast, mutate))).toThrowError(pattern);
  });

  it("accepts a live forecast recorded before its target session", () => {
    const live = mutated(forecast, (f) => {
      f.origin = "live";
      f.recordedAt = "2025-03-28T21:00:00.000Z";
    });
    expect(normalizeForecastRecord(live).origin).toBe("live");
  });

  it.each([
    ["a NaN", Number.NaN],
    ["a function", () => {}],
    ["a class instance", new Map()],
  ])("rejects %s inside the forecast payload", (_label, value) => {
    expect(() => normalizeForecastRecord(mutated(forecast, (f) => {
      f.forecast.model.lambda = value;
    }))).toThrowError(TypeError);
  });

  it("rejects a circular forecast payload", () => {
    const record = forecast();
    record.forecast.model.self = record.forecast.model;
    expect(() => normalizeForecastRecord(record))
      .toThrowError(/must not contain circular references/u);
  });

  it("rejects a sparse array inside the payload", () => {
    const record = analyticsRecords().assessment;
    const sparse = [1];
    sparse[3] = 2;
    record.assessment.quality.warnings = sparse;
    expect(() => normalizeForecastRecord({ ...forecast(), forecast: { holes: sparse } }))
      .toThrowError(/must not contain sparse arrays/u);
  });
});

describe("history manifest guards", () => {
  it.each([
    ["an unsupported price basis", (m) => { m.priceBasis = "gross"; }, /price bases are unsupported/u],
    ["a price basis that ignores the request", (m) => { m.requestedPriceBasis = "raw"; }, /must satisfy requestedPriceBasis/u],
    ["an adjustment status that contradicts the basis", (m) => {
      m.adjustment.status = "none";
    }, /adjustment status does not match priceBasis/u],
    ["an unsupported adjustment status", (m) => { m.adjustment.status = "guessed"; }, /adjustment.status is unsupported/u],
    ["a non-boolean split flag", (m) => { m.adjustment.includesSplits = "yes"; }, /must be boolean or unknown/u],
    ["a blank formula version", (m) => { m.adjustment.formulaVersion = "  "; }, /formulaVersion must be a non-empty string/u],
    ["an unsupported quality", (m) => { m.quality = "guessed"; }, /quality is unsupported/u],
    ["a zero bar count", (m) => { m.barCount = 0; }, /barCount must be an integer/u],
    ["a first session after the last", (m) => {
      m.firstSessionDate = "2026-07-17";
    }, /must not follow lastSessionDate/u],
    ["an unsupported asset class", (m) => { m.assetClass = "warrant"; }, /assetClass is unsupported/u],
    ["a non-boolean fallback", (m) => { m.fallback = "no"; }, /fallback must be boolean/u],
    ["an unsupported session model", (m) => { m.session.model = "always_on"; }, /session.model is unsupported/u],
    ["an unknown session timezone", (m) => { m.session.timezone = "Mars/Olympus"; }, /valid IANA timezone/u],
    ["an unsupported continuity kind", (m) => { m.continuity.kind = "stitched"; }, /continuity.kind is unsupported/u],
    ["a rollover on a single instrument", (m) => {
      m.continuity.rollover = "provider_managed";
    }, /rollover must be null/u],
    ["session dates that are not an array", (m) => { m.sessionDates = "2026-07-14"; }, /sessionDates must be an array/u],
    ["session dates of the wrong length", (m) => { m.sessionDates = ["2026-07-14"]; }, /length must equal barCount/u],
    ["session dates that go backwards", (m) => {
      m.sessionDates = ["2026-07-16", "2026-07-15", "2026-07-14"];
    }, /must be non-decreasing/u],
    ["session dates that disagree with first and last", (m) => {
      m.sessionDates = ["2026-07-13", "2026-07-15", "2026-07-16"];
    }, /first\/last session must match sessionDates/u],
    ["a row count that disagrees with barCount", (m) => { m.dataQuality.rowCount = 2; }, /rowCount must equal barCount/u],
    ["bar hashes of the wrong length", (m) => { m.barInputHashes = [digest("a")]; }, /barInputHashes length must equal barCount/u],
    ["bar timestamps of the wrong length", (m) => { m.barTimestamps = []; }, /barTimestamps length must equal barCount/u],
    ["bar timestamps that go backwards", (m) => {
      m.barTimestamps = [...m.barTimestamps].reverse();
    }, /must be strictly ascending|must map to the declared sessionDates/u],
    ["a bar timestamp on the wrong session", (m) => {
      m.barTimestamps[2] = "2026-07-20T20:00:00.000Z";
    }, /must map to the declared sessionDates/u],
    ["a grid hash that does not match its content", (m) => {
      m.sessionGrid.gridHash = digest("0");
    }, /gridHash does not match its content/u],
    ["an unknown grid timezone", (m) => { m.sessionGrid.timeZone = "Mars/Olympus"; }, /valid IANA timezone/u],
    ["grid dates that are not ascending", (m) => {
      m.sessionGrid.sessionDates = ["2026-07-14", "2026-07-14", "2026-07-16"];
    }, /unique and strictly ascending/u],
    ["an empty grid", (m) => { m.sessionGrid.sessionDates = []; }, /must be a non-empty array/u],
    ["a cutoff away from observedAt", (m) => {
      m.fetchCutoff.throughObservedAt = "2026-07-29T00:05:00.000Z";
    }, /must equal observedAt/u],
    ["unsupported cutoff semantics", (m) => {
      m.fetchCutoff.predicate = "observed_at_lt";
    }, /fetchCutoff semantics are unsupported/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expect(() => normalizeHistoryManifestRecord(mutated(historyManifest, mutate)))
      .toThrowError(pattern);
  });

  it("accepts a manifest whose original source is named", () => {
    const withSource = mutated(historyManifest, (m) => { m.originalSource = "finnhub"; });
    expect(normalizeHistoryManifestRecord(withSource).originalSource).toBe("finnhub");
  });

  it("rejects a blank original source", () => {
    expect(() => normalizeHistoryManifestRecord(mutated(historyManifest, (m) => {
      m.originalSource = "  ";
    }))).toThrowError(/originalSource must be a non-empty string/u);
  });

  it("rejects an unsupported manifest key", () => {
    expect(() => normalizeHistoryManifestRecord(mutated(historyManifest, (m) => {
      m.extra = 1;
    }))).toThrowError(/History manifest.extra is not supported/u);
  });

  it("rejects bar timestamps that repeat within one session", () => {
    expect(() => normalizeHistoryManifestRecord(mutated(historyManifest, (m) => {
      m.sessionDates = ["2026-07-14", "2026-07-14", "2026-07-16"];
      m.barTimestamps = [
        "2026-07-14T20:00:00.000Z",
        "2026-07-14T20:00:00.000Z",
        "2026-07-16T20:00:00.000Z",
      ];
    }))).toThrowError(/barTimestamps must be strictly ascending/u);
  });
});

describe("continuous future manifest guards", () => {
  const continuous = (patch = {}) => mutated(historyManifest, (m) => {
    m.assetClass = "commodity_future";
    m.continuity = {
      kind: "provider_continuous_front",
      activeContract: "CLZ26",
      expirationDate: "2026-12-21T00:00:00.000Z",
      rollover: "provider_managed",
      backAdjustment: "none",
      comparableAcrossRollover: false,
      ...patch,
    };
  });

  it("accepts a provider-managed continuous front month", () => {
    const record = normalizeHistoryManifestRecord(continuous());
    expect(record.continuity).toEqual({
      kind: "provider_continuous_front",
      activeContract: "CLZ26",
      expirationDate: "2026-12-21T00:00:00.000Z",
      rollover: "provider_managed",
      backAdjustment: "none",
      comparableAcrossRollover: false,
    });
  });

  it("accepts a contract with no known expiration", () => {
    expect(normalizeHistoryManifestRecord(continuous({ expirationDate: null }))
      .continuity.expirationDate).toBeNull();
  });

  it.each([
    ["an unsupported key", { extra: 1 }, /continuity.extra is not supported/u],
    ["a self-managed rollover", { rollover: "self_managed" }, /continuity semantics are invalid/u],
    ["a back-adjusted series", { backAdjustment: "ratio" }, /continuity semantics are invalid/u],
    ["a series claiming comparability", { comparableAcrossRollover: true }, /continuity semantics are invalid/u],
    ["a blank active contract", { activeContract: "  " }, /activeContract must be a non-empty string/u],
    ["an unreadable expiration", { expirationDate: "2026-12-21" }, /expirationDate/u],
  ])("rejects %s", (_label, patch, pattern) => {
    expect(() => normalizeHistoryManifestRecord(continuous(patch))).toThrowError(pattern);
  });
});

describe("history input guards", () => {
  it("accepts a coherent manifest and its observations", () => {
    const input = historyInput();
    expect(normalizeHistoryInputRecord(input).observations).toHaveLength(3);
  });

  it.each([
    ["observations that are not an array", (i) => { i.observations = null; }, /observations must be an array/u],
    ["an observation for another instrument", (i) => {
      i.observations[0].instrumentId = "XNAS:MSFT";
    }, /does not match the manifest/u],
    ["an observation on the wrong session", (i) => {
      i.observations[1].sessionDate = "2026-07-20";
    }, /does not match the manifest/u],
    ["an observation from another provider", (i) => {
      i.observations[2].provider = "finnhub";
    }, /does not match the manifest/u],
    ["an observation past the fetch cutoff", (i) => {
      i.observations[0].observedAt = "2026-07-29T00:05:00.000Z";
    }, /does not match the manifest/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expect(() => normalizeHistoryInputRecord(mutated(historyInput, mutate)))
      .toThrowError(pattern);
  });

  it("rejects an observation count that disagrees with barCount", () => {
    const input = historyInput();
    input.manifest.barCount = 4;
    input.manifest.sessionDates.push("2026-07-17");
    input.manifest.lastSessionDate = "2026-07-17";
    input.manifest.barTimestamps.push("2026-07-17T20:00:00.000Z");
    input.manifest.barInputHashes.push(digest("a"));
    input.manifest.dataQuality.rowCount = 4;
    expect(() => normalizeHistoryInputRecord(input))
      .toThrowError(/observations length must equal manifest.barCount/u);
  });

  it("rejects an observation whose hash does not match its content", () => {
    const input = historyInput();
    input.observations[0].bar.providerClose = 999;
    expect(() => normalizeHistoryInputRecord(input))
      .toThrowError(/inputHash does not match its content/u);
  });

  it("rejects a series hash that does not match the manifest content", () => {
    const input = historyInput();
    input.manifest.seriesHash = digest("0");
    expect(() => normalizeHistoryInputRecord(input))
      .toThrowError(/seriesHash does not match its content and grid/u);
  });

  it("rejects an unsupported key", () => {
    expect(() => normalizeHistoryInputRecord({ ...historyInput(), extra: 1 }))
      .toThrowError(/History input.extra is not supported/u);
  });
});

describe("run attempt guards", () => {
  it.each([
    ["an unsupported key", (a) => { a.extra = 1; }, /Run attempt.extra is not supported/u],
    ["a next session on the completed one", (a) => {
      a.expectedNextSessionDate = a.expectedCompletedSessionDate;
    }, /must follow expectedCompletedSessionDate/u],
    ["a completion before the start", (a) => {
      a.completedAt = "2026-07-28T22:00:00.000Z";
    }, /must not precede startedAt/u],
    ["an unsupported status", (a) => { a.status = "cancelled"; }, /status is unsupported/u],
    ["counts that do not add up", (a) => { a.counts.available = 5; }, /must add up to requested/u],
    ["a fractional count", (a) => { a.counts.failed = 0.5; }, /counts.failed must be an integer/u],
    ["a completed attempt with failures", (a) => {
      a.counts = { requested: 1, available: 0, unavailable: 0, failed: 1 };
    }, /cannot contain failed results/u],
    ["a failure status with no failures", (a) => {
      a.status = "completed_with_failures";
    }, /must contain a failure/u],
    ["assets that are not an array", (a) => { a.inputManifest.assets = null; }, /assets must be an array/u],
    ["unsorted assets", (a) => {
      a.inputManifest.assets = [
        { ...a.inputManifest.assets[0], instrumentId: "XNAS:MSFT" },
        { ...a.inputManifest.assets[0], instrumentId: "XNAS:AAPL" },
      ];
    }, /unique and sorted by instrumentId/u],
    ["assets with no session sentinel", (a) => {
      a.inputManifest.sessionSentinel = null;
    }, /require a session sentinel input/u],
    ["unsupported history selection semantics", (a) => {
      a.inputManifest.historySelection.predicate = "observed_at_lt";
    }, /history selection semantics are unsupported/u],
    ["an unsupported history price basis", (a) => {
      a.inputManifest.historySelection.priceBasis = "gross";
    }, /history selection semantics are unsupported/u],
    ["a config hash that does not match its snapshot", (a) => {
      a.configHash = digest("0");
    }, /configHash/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, mutate))).toThrowError(pattern);
  });

  it("accepts an attempt with no assets and no sentinel", () => {
    const empty = mutated(runAttempt, (a) => {
      a.inputManifest.sessionSentinel = null;
      a.inputManifest.assets = [];
      a.counts = { requested: 0, available: 0, unavailable: 0, failed: 0 };
    });
    expect(normalizeRunAttemptRecord(empty).inputManifest.sessionSentinel).toBeNull();
  });

  it("accepts a completed_with_failures attempt that reports one", () => {
    const failed = mutated(runAttempt, (a) => {
      a.status = "completed_with_failures";
      a.counts = { requested: 2, available: 1, unavailable: 0, failed: 1 };
    });
    expect(normalizeRunAttemptRecord(failed).status).toBe("completed_with_failures");
  });

  it("rejects a malformed sentinel", () => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.sessionSentinel.instrumentId = "SPY";
    }))).toThrowError(/canonical instrument ID/u);
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.sessionSentinel.extra = 1;
    }))).toThrowError(/sessionSentinel.extra is not supported/u);
  });

  it("rejects a malformed asset entry", () => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.assets[0] = null;
    }))).toThrowError(/assets\[0\] must be an object/u);
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.assets[0].extra = 1;
    }))).toThrowError(/assets\[0\].extra is not supported/u);
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.assets[0].assetSeriesHash = "sha256:short";
    }))).toThrowError(/assetSeriesHash/u);
  });

  it("rejects a non-object failure summary or config snapshot", () => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.failureSummary = [];
    }))).toThrowError(/failureSummary must be an object/u);
    expect(() => normalizeRunAttemptRecord({ ...runAttempt(), configSnapshot: null }))
      .toThrowError(/configSnapshot must be an object/u);
  });

  it("rejects an attempt whose digests are malformed", () => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.attemptId = "not-a-digest";
    }))).toThrowError(/attemptId/u);
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.sessionGridHash = "not-a-digest";
    }))).toThrowError(/sessionGridHash/u);
  });

  it("rejects a blank missing-return policy", () => {
    expect(() => normalizeRunAttemptRecord(mutated(runAttempt, (a) => {
      a.inputManifest.missingReturnPolicy = "  ";
    }))).toThrowError(/missingReturnPolicy/u);
  });

  it("keeps the fixture attempt valid", () => {
    expect(normalizeRunAttemptRecord(runAttempt())).toEqual(runAttempt());
    expect(HASH.attempt).toMatch(/^sha256:/u);
  });
});
