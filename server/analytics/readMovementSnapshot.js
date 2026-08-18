import { CANONICAL_INSTRUMENT_ID_PATTERN, ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import { validateMovementAssessment } from "./contracts/validators.js";

export const MOVEMENT_SNAPSHOT_MAX_IDS = 40;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason instanceof Error
    ? signal.reason
    : new MarketDataError(ERROR_CODES.TIMEOUT, "Analytics snapshot read was aborted");
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MOVEMENT_SNAPSHOT_MAX_IDS) {
    throw new MarketDataError(
      ERROR_CODES.INVALID_REQUEST,
      `analytics snapshot requires between 1 and ${MOVEMENT_SNAPSHOT_MAX_IDS} unique ids`,
      { retryable: false },
    );
  }
  const seen = new Set();
  for (const instrumentId of ids) {
    if (typeof instrumentId !== "string"
      || !CANONICAL_INSTRUMENT_ID_PATTERN.test(instrumentId)
      || seen.has(instrumentId)) {
      throw new MarketDataError(
        ERROR_CODES.INVALID_REQUEST,
        "analytics snapshot ids must be unique canonical instrument IDs",
        { retryable: false, instrumentId: typeof instrumentId === "string" ? instrumentId : null },
      );
    }
    seen.add(instrumentId);
  }
  return [...seen];
}

export async function readMovementSnapshot(analyticsStore, ids, { signal } = {}) {
  if (typeof analyticsStore?.getLatestAssessment !== "function") {
    throw new TypeError("analyticsStore.getLatestAssessment is required");
  }
  const normalizedIds = normalizeIds(ids);
  throwIfAborted(signal);
  const settled = await Promise.all(normalizedIds.map(async (instrumentId) => {
    try {
      const record = await analyticsStore.getLatestAssessment(instrumentId);
      if (!record) return null;
      validateMovementAssessment(record.assessment);
      if (record.assessment.instrumentId !== instrumentId) {
        throw new MarketDataError(
          ERROR_CODES.SCHEMA_INVALID,
          "Persisted assessment does not match the requested instrument",
          { retryable: false, instrumentId },
        );
      }
      return {
        instrumentId,
        runId: record.runId,
        computedAt: record.computedAt,
        assessment: record.assessment,
      };
    } catch (error) {
      const itemError = MarketDataError.from(error, {
        code: ERROR_CODES.PERSISTENCE_UNAVAILABLE,
        message: "Analytics snapshot read failed",
      });
      if (!itemError.instrumentId) itemError.instrumentId = instrumentId;
      return itemError;
    }
  }));
  throwIfAborted(signal);
  const data = settled.filter((entry) => entry && !(entry instanceof MarketDataError));
  const errors = settled.filter((entry) => entry instanceof MarketDataError);
  return { data, ...(errors.length ? { errors } : {}) };
}
