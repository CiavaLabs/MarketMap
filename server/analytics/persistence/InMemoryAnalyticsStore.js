import {
  assessmentsEquivalent,
  cloneAssessmentRecord,
  cloneDailyObservationRecord,
  cloneForecastRecord,
  cloneHistoryManifestRecord,
  cloneRunAttemptRecord,
  createDailyObservationRecord,
  dailyObservationsEquivalent,
  forecastsEquivalent,
  historyManifestsEquivalent,
  normalizeAssessmentRecord,
  normalizeDailyObservationInput,
  normalizeDigest,
  normalizeForecastRecord,
  normalizeForecastOrigin,
  normalizeHistoryInputRecord,
  normalizeHistoryManifestRecord,
  normalizeInstrumentId,
  normalizeRunAttemptRecord,
  normalizeSessionDate,
  runAttemptsEquivalent,
  toAnalyticsIsoTimestamp,
} from "./records.js";

function observationScopeKey(instrumentId, sessionDate) {
  return JSON.stringify([instrumentId, sessionDate]);
}

function forecastIdentityKey(record) {
  return JSON.stringify([
    record.runId,
    record.forecast.instrumentId,
    record.targetSessionDate,
    record.informationSetEnd,
    record.origin,
    record.inputHash,
    record.configHash,
  ]);
}

function assessmentIdentityKey(record) {
  return JSON.stringify([
    record.runId,
    record.assessment.instrumentId,
    record.assessment.sessionDate,
  ]);
}

function assertMatchingRecord(existing, candidate, equivalent, label) {
  if (!equivalent(existing, candidate)) {
    throw new TypeError(`${label} identity collides with different persisted content`);
  }
}

function parseIdentityKey(key, expectedLength, label) {
  let value;
  try {
    value = JSON.parse(key);
  } catch (cause) {
    throw new TypeError(`${label} has a corrupt persistence key`, { cause });
  }
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new TypeError(`${label} has a corrupt persistence key`);
  }
  return value;
}

function observationRecency(left, right) {
  const observedOrder = left.observedAt.localeCompare(right.observedAt);
  return observedOrder || (left.revision - right.revision);
}

function byteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assessmentRecency(left, right) {
  return byteOrder(left.assessment.sessionDate || "", right.assessment.sessionDate || "")
    || byteOrder(left.computedAt, right.computedAt)
    || byteOrder(left.runId, right.runId);
}

function appendObservationRevision(revisions, candidate) {
  const sameEvent = revisions.find((entry) => (
    entry.observedAt === candidate.observedAt
    && entry.inputHash === candidate.inputHash
  ));
  if (sameEvent) {
    assertMatchingRecord(
      sameEvent,
      candidate,
      dailyObservationsEquivalent,
      "Daily observation",
    );
    return sameEvent;
  }

  const priorState = revisions
    .filter((entry) => entry.observedAt <= candidate.observedAt)
    .sort(observationRecency)
    .at(-1);
  if (priorState?.inputHash === candidate.inputHash) {
    assertMatchingRecord(
      priorState,
      candidate,
      dailyObservationsEquivalent,
      "Daily observation",
    );
    return priorState;
  }

  const stored = createDailyObservationRecord(
    candidate,
    Math.max(0, ...revisions.map(({ revision }) => revision)) + 1,
  );
  revisions.push(stored);
  return stored;
}

function validatedObservationScope(key, persisted) {
  const [instrumentId, sessionDate] = parseIdentityKey(key, 2, "Daily observation");
  const normalizedInstrumentId = normalizeInstrumentId(instrumentId);
  const normalizedSessionDate = normalizeSessionDate(sessionDate);
  if (!Array.isArray(persisted)) {
    throw new TypeError("Daily observation scope must contain an array");
  }
  const revisions = persisted.map(cloneDailyObservationRecord);
  const seenRevisions = new Set();
  for (const record of revisions) {
    if (record.instrumentId !== normalizedInstrumentId
      || record.sessionDate !== normalizedSessionDate) {
      throw new TypeError("Daily observation persistence key does not match its record");
    }
    if (seenRevisions.has(record.revision)) {
      throw new TypeError("Daily observation revisions must be unique within a session");
    }
    seenRevisions.add(record.revision);
  }
  return revisions.sort((left, right) => left.revision - right.revision);
}

function validatedForecastEntry(key, persisted) {
  const identity = parseIdentityKey(key, 7, "Forecast");
  const record = cloneForecastRecord(persisted);
  const actual = [
    record.runId,
    record.forecast.instrumentId,
    record.targetSessionDate,
    record.informationSetEnd,
    record.origin,
    record.inputHash,
    record.configHash,
  ];
  if (!actual.every((value, index) => value === identity[index])) {
    throw new TypeError("Forecast persistence key does not match its record");
  }
  return record;
}

function validatedAssessmentEntry(key, persisted) {
  const [runId, instrumentId, sessionDate] = parseIdentityKey(key, 3, "Assessment");
  const record = cloneAssessmentRecord(persisted);
  if (record.runId !== runId
    || record.assessment.instrumentId !== instrumentId
    || record.assessment.sessionDate !== sessionDate) {
    throw new TypeError("Assessment persistence key does not match its record");
  }
  return record;
}

function assessmentKeyMatches(key, { runId = null, instrumentId = null }) {
  const [keyRunId, keyInstrumentId] = parseIdentityKey(key, 3, "Assessment");
  return (runId === null || keyRunId === runId)
    && (instrumentId === null || keyInstrumentId === instrumentId);
}

function validatedManifestEntry(key, persisted) {
  const seriesHash = normalizeDigest(key, "seriesHash");
  const record = cloneHistoryManifestRecord(persisted);
  if (record.seriesHash !== seriesHash) {
    throw new TypeError("History manifest persistence key does not match its record");
  }
  return record;
}

function validatedAttemptEntry(key, persisted) {
  const attemptId = normalizeDigest(key, "attemptId");
  const record = cloneRunAttemptRecord(persisted);
  if (record.attemptId !== attemptId) {
    throw new TypeError("Run attempt persistence key does not match its record");
  }
  return record;
}

export const IN_MEMORY_ANALYTICS_DEFAULT_MAX_SCOPES = 250_000;

export class InMemoryAnalyticsStore {
  constructor({ maxScopes = IN_MEMORY_ANALYTICS_DEFAULT_MAX_SCOPES } = {}) {
    if (!Number.isInteger(maxScopes) || maxScopes < 1) {
      throw new TypeError("maxScopes must be a positive integer");
    }
    this.maxScopes = maxScopes;
    this.observations = new Map();
    this.forecasts = new Map();
    this.assessments = new Map();
    this.historyManifests = new Map();
    this.runAttempts = new Map();
    this.closePromise = null;
  }

  get scopeCount() {
    return this.observations.size
      + this.forecasts.size
      + this.assessments.size
      + this.historyManifests.size
      + this.runAttempts.size;
  }

  #assertRoomForNewScopes(count) {
    if (count < 1 || this.scopeCount + count <= this.maxScopes) return;
    throw new RangeError(
      `InMemoryAnalyticsStore holds ${this.scopeCount} scopes, is capped at ${this.maxScopes}, `
      + `and this write opens ${count} more. The ledger is append-only, so nothing here may be `
      + "evicted to make room: configure a durable analytics store, or raise maxScopes deliberately.",
    );
  }

  async appendDailyObservation(record) {
    const candidate = normalizeDailyObservationInput(record);
    const scopeKey = observationScopeKey(candidate.instrumentId, candidate.sessionDate);
    this.#assertRoomForNewScopes(this.observations.has(scopeKey) ? 0 : 1);
    const persisted = this.observations.get(scopeKey);
    const revisions = persisted ? validatedObservationScope(scopeKey, persisted) : [];
    const stored = appendObservationRevision(revisions, candidate);
    this.observations.set(scopeKey, revisions.map(cloneDailyObservationRecord));
    return cloneDailyObservationRecord(stored);
  }

  async appendHistoryInput(value) {
    const { observations, manifest } = normalizeHistoryInputRecord(value);
    const openedScopes = new Set(observations
      .map((candidate) => observationScopeKey(candidate.instrumentId, candidate.sessionDate))
      .filter((key) => !this.observations.has(key)));
    this.#assertRoomForNewScopes(
      openedScopes.size + (this.historyManifests.has(manifest.seriesHash) ? 0 : 1),
    );
    const persistedManifest = this.historyManifests.get(manifest.seriesHash);
    const existingManifest = persistedManifest
      ? validatedManifestEntry(manifest.seriesHash, persistedManifest)
      : null;
    if (existingManifest) {
      assertMatchingRecord(
        existingManifest,
        manifest,
        historyManifestsEquivalent,
        "History manifest",
      );
    }

    const nextObservations = new Map(this.observations);
    const storedObservations = observations.map((candidate) => {
      const key = observationScopeKey(candidate.instrumentId, candidate.sessionDate);
      const persisted = nextObservations.get(key);
      const revisions = persisted ? validatedObservationScope(key, persisted) : [];
      const stored = appendObservationRevision(revisions, candidate);
      nextObservations.set(key, revisions.map(cloneDailyObservationRecord));
      return cloneDailyObservationRecord(stored);
    });
    const storedManifest = existingManifest || cloneHistoryManifestRecord(manifest);
    const nextManifests = new Map(this.historyManifests);
    nextManifests.set(storedManifest.seriesHash, cloneHistoryManifestRecord(storedManifest));

    this.observations = nextObservations;
    this.historyManifests = nextManifests;
    return {
      observations: storedObservations,
      manifest: cloneHistoryManifestRecord(storedManifest),
    };
  }

  async getDailyObservation({ instrumentId, sessionDate, inputHash }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(sessionDate);
    const hash = normalizeDigest(inputHash, "inputHash");
    const key = observationScopeKey(id, date);
    const persisted = this.observations.get(key);
    if (!persisted) return null;
    const revisions = validatedObservationScope(key, persisted);
    const record = revisions
      .filter((entry) => entry.inputHash === hash)
      .sort(observationRecency)
      .at(-1);
    return record ? cloneDailyObservationRecord(record) : null;
  }

  async listDailyObservations({ instrumentId, sessionDate }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(sessionDate);
    const key = observationScopeKey(id, date);
    const persisted = this.observations.get(key);
    return persisted ? validatedObservationScope(key, persisted) : [];
  }

  async listDailyObservationsAsOf({ instrumentId, throughObservedAt }) {
    const id = normalizeInstrumentId(instrumentId);
    const cutoff = toAnalyticsIsoTimestamp(throughObservedAt, "throughObservedAt");
    const selected = [];
    for (const [key, persisted] of this.observations) {
      const [scopeInstrumentId] = parseIdentityKey(key, 2, "Daily observation");
      if (scopeInstrumentId !== id) continue;
      const record = validatedObservationScope(key, persisted)
        .filter((entry) => entry.observedAt <= cutoff)
        .sort(observationRecency)
        .at(-1);
      if (record) selected.push(record);
    }
    return selected
      .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
      .map(cloneDailyObservationRecord);
  }

  async appendForecast(record) {
    const candidate = normalizeForecastRecord(record);
    const key = forecastIdentityKey(candidate);
    this.#assertRoomForNewScopes(this.forecasts.has(key) ? 0 : 1);
    const persisted = this.forecasts.get(key);
    const existing = persisted ? validatedForecastEntry(key, persisted) : null;
    if (existing) {
      assertMatchingRecord(existing, candidate, forecastsEquivalent, "Forecast");
      return cloneForecastRecord(existing);
    }
    const stored = cloneForecastRecord(candidate);
    this.forecasts.set(key, stored);
    return cloneForecastRecord(stored);
  }

  async getForecast({
    runId,
    instrumentId,
    targetSessionDate,
    informationSetEnd,
    origin,
    inputHash,
    configHash,
  }) {
    const key = JSON.stringify([
      normalizeDigest(runId, "runId"),
      normalizeInstrumentId(instrumentId),
      normalizeSessionDate(targetSessionDate, "targetSessionDate"),
      normalizeSessionDate(informationSetEnd, "informationSetEnd"),
      normalizeForecastOrigin(origin),
      normalizeDigest(inputHash, "inputHash"),
      normalizeDigest(configHash, "configHash"),
    ]);
    const persisted = this.forecasts.get(key);
    return persisted ? validatedForecastEntry(key, persisted) : null;
  }

  async listForecasts({ instrumentId, targetSessionDate }) {
    const id = normalizeInstrumentId(instrumentId);
    const date = normalizeSessionDate(targetSessionDate, "targetSessionDate");
    return [...this.forecasts.entries()]
      .map(([key, record]) => validatedForecastEntry(key, record))
      .filter((record) => (
        record.forecast.instrumentId === id
        && record.targetSessionDate === date
      ))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .map(cloneForecastRecord);
  }

  async appendAssessment(record) {
    const candidate = normalizeAssessmentRecord(record);
    this.#assertRoomForNewScopes(this.assessments.has(assessmentIdentityKey(candidate)) ? 0 : 1);
    const matches = [...this.assessments.entries()]
      .filter(([key]) => assessmentKeyMatches(key, {
        runId: candidate.runId,
        instrumentId: candidate.assessment.instrumentId,
      }))
      .map(([key, persisted]) => ({ key, record: validatedAssessmentEntry(key, persisted) }));
    if (matches.length > 1) {
      throw new TypeError("Assessment persistence contains duplicate run identities");
    }
    const existing = matches[0]?.record || null;
    if (existing) {
      assertMatchingRecord(existing, candidate, assessmentsEquivalent, "Assessment");
      return cloneAssessmentRecord(existing);
    }
    const key = assessmentIdentityKey(candidate);
    const stored = cloneAssessmentRecord(candidate);
    this.assessments.set(key, stored);
    return cloneAssessmentRecord(stored);
  }

  async getAssessment({ runId, instrumentId }) {
    const normalizedRunId = normalizeDigest(runId, "runId");
    const id = normalizeInstrumentId(instrumentId);
    const matches = [...this.assessments.entries()]
      .filter(([key]) => assessmentKeyMatches(key, { runId: normalizedRunId, instrumentId: id }))
      .map(([key, record]) => validatedAssessmentEntry(key, record));
    if (matches.length > 1) {
      throw new TypeError("Assessment persistence contains duplicate run identities");
    }
    return matches[0] || null;
  }

  async getLatestAssessment(instrumentId) {
    const id = normalizeInstrumentId(instrumentId);
    let latest = null;
    for (const [key, persisted] of this.assessments) {
      if (!assessmentKeyMatches(key, { instrumentId: id })) continue;
      const record = validatedAssessmentEntry(key, persisted);
      if (!latest || assessmentRecency(latest, record) < 0) latest = record;
    }
    return latest ? cloneAssessmentRecord(latest) : null;
  }

  async listAssessments(runId) {
    const normalizedRunId = normalizeDigest(runId, "runId");
    return [...this.assessments.entries()]
      .map(([key, record]) => validatedAssessmentEntry(key, record))
      .filter((record) => record.runId === normalizedRunId)
      .sort((left, right) => (
        left.assessment.instrumentId.localeCompare(right.assessment.instrumentId)
      ))
      .map(cloneAssessmentRecord);
  }

  async appendHistoryManifest(record) {
    const candidate = normalizeHistoryManifestRecord(record);
    this.#assertRoomForNewScopes(this.historyManifests.has(candidate.seriesHash) ? 0 : 1);
    const persisted = this.historyManifests.get(candidate.seriesHash);
    const existing = persisted
      ? validatedManifestEntry(candidate.seriesHash, persisted)
      : null;
    if (existing) {
      assertMatchingRecord(
        existing,
        candidate,
        historyManifestsEquivalent,
        "History manifest",
      );
      return cloneHistoryManifestRecord(existing);
    }
    const stored = cloneHistoryManifestRecord(candidate);
    this.historyManifests.set(stored.seriesHash, stored);
    return cloneHistoryManifestRecord(stored);
  }

  async getHistoryManifest(seriesHash) {
    const hash = normalizeDigest(seriesHash, "seriesHash");
    const persisted = this.historyManifests.get(hash);
    return persisted ? validatedManifestEntry(hash, persisted) : null;
  }

  async getHistoryInput(seriesHash) {
    const manifest = await this.getHistoryManifest(seriesHash);
    if (!manifest) return null;
    const observations = manifest.sessionDates.map((sessionDate, index) => {
      const key = observationScopeKey(manifest.instrumentId, sessionDate);
      const persisted = this.observations.get(key);
      if (!persisted) {
        throw new TypeError(`History input observation ${index} is missing`);
      }
      const record = validatedObservationScope(key, persisted)
        .filter((entry) => (
          entry.inputHash === manifest.barInputHashes[index]
          && entry.observedAt <= manifest.fetchCutoff.throughObservedAt
        ))
        .sort(observationRecency)
        .at(-1);
      if (!record) throw new TypeError(`History input observation ${index} is missing`);
      return record;
    });
    return normalizeHistoryInputRecord({ manifest, observations });
  }

  async appendRunAttempt(record) {
    const candidate = normalizeRunAttemptRecord(record);
    this.#assertRoomForNewScopes(this.runAttempts.has(candidate.attemptId) ? 0 : 1);
    const persisted = this.runAttempts.get(candidate.attemptId);
    const existing = persisted
      ? validatedAttemptEntry(candidate.attemptId, persisted)
      : null;
    if (existing) {
      assertMatchingRecord(existing, candidate, runAttemptsEquivalent, "Run attempt");
      return cloneRunAttemptRecord(existing);
    }
    const stored = cloneRunAttemptRecord(candidate);
    this.runAttempts.set(stored.attemptId, stored);
    return cloneRunAttemptRecord(stored);
  }

  async getRunAttempt(attemptId) {
    const id = normalizeDigest(attemptId, "attemptId");
    const persisted = this.runAttempts.get(id);
    return persisted ? validatedAttemptEntry(id, persisted) : null;
  }

  async listRunAttempts(runId) {
    const id = normalizeDigest(runId, "runId");
    return [...this.runAttempts.entries()]
      .map(([key, record]) => validatedAttemptEntry(key, record))
      .filter((record) => record.runId === id)
      .sort((left, right) => (
        left.startedAt.localeCompare(right.startedAt)
        || left.attemptId.localeCompare(right.attemptId)
      ))
      .map(cloneRunAttemptRecord);
  }

  close() {
    if (!this.closePromise) this.closePromise = Promise.resolve();
    return this.closePromise;
  }
}
