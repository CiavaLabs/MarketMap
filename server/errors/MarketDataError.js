import {
  ERROR_CODES,
  isMarketDataErrorCode,
} from "../contracts/core/constants.js";

const DEFAULT_STATUS = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.AUTH_FAILED]: 502,
  [ERROR_CODES.ENTITLEMENT_MISSING]: 502,
  [ERROR_CODES.INSTRUMENT_NOT_FOUND]: 404,
  [ERROR_CODES.MAPPING_AMBIGUOUS]: 409,
  [ERROR_CODES.RATE_LIMITED]: 503,
  [ERROR_CODES.QUOTA_EXCEEDED]: 429,
  [ERROR_CODES.SCHEMA_INVALID]: 502,
  [ERROR_CODES.TIMEOUT]: 504,
  [ERROR_CODES.UNSUPPORTED_ASSET]: 422,
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: 503,
  [ERROR_CODES.PERSISTENCE_UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
  [ERROR_CODES.UNSUPPORTED_SEMANTICS]: 422,
  [ERROR_CODES.NOT_IMPLEMENTED]: 501,
});

const RETRYABLE_CODES = new Set([
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.QUOTA_EXCEEDED,
  ERROR_CODES.UPSTREAM_UNAVAILABLE,
  ERROR_CODES.PERSISTENCE_UNAVAILABLE,
]);

const TITLE_BY_CODE = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: "Invalid request",
  [ERROR_CODES.TIMEOUT]: "Upstream timeout",
  [ERROR_CODES.RATE_LIMITED]: "Upstream rate limit",
  [ERROR_CODES.QUOTA_EXCEEDED]: "Request quota exceeded",
  [ERROR_CODES.AUTH_FAILED]: "Provider authentication failed",
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: "Market data unavailable",
  [ERROR_CODES.SCHEMA_INVALID]: "Invalid market data schema",
  [ERROR_CODES.INSTRUMENT_NOT_FOUND]: "Instrument not found",
  [ERROR_CODES.UNSUPPORTED_ASSET]: "Unsupported asset",
  [ERROR_CODES.ENTITLEMENT_MISSING]: "Provider entitlement missing",
  [ERROR_CODES.MAPPING_AMBIGUOUS]: "Ambiguous instrument mapping",
  [ERROR_CODES.PERSISTENCE_UNAVAILABLE]: "Snapshot persistence unavailable",
  [ERROR_CODES.INTERNAL_ERROR]: "Internal market data error",
  [ERROR_CODES.UNSUPPORTED_SEMANTICS]: "Unsupported data semantics",
  [ERROR_CODES.NOT_IMPLEMENTED]: "Not implemented",
});

function normalizeStatus(value, fallback) {
  return Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : fallback;
}

export class MarketDataError extends Error {
  constructor(code, message, options = {}) {
    if (!isMarketDataErrorCode(code)) {
      throw new TypeError(`Unknown market data error code: ${String(code)}`);
    }

    const resolvedMessage = message || TITLE_BY_CODE[code] || "Market data error";
    super(resolvedMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = "MarketDataError";
    this.code = code;
    this.status = normalizeStatus(options.status, DEFAULT_STATUS[code] || 500);
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.provider = options.provider ?? null;
    this.capability = options.capability ?? null;
    this.instrumentId = options.instrumentId ?? null;
    this.details = options.details ?? null;
  }

  toProblem({ instance, requestId } = {}) {
    const problem = {
      type: `urn:market-map:error:${this.code}`,
      title: TITLE_BY_CODE[this.code] || "Market data error",
      status: this.status,
      detail: this.message,
      code: this.code,
      retryable: this.retryable,
    };

    if (instance) problem.instance = instance;
    if (requestId) problem.requestId = requestId;
    if (this.provider) problem.provider = this.provider;
    if (this.capability) problem.capability = this.capability;
    if (this.instrumentId) problem.instrumentId = this.instrumentId;
    if (this.details !== null) problem.details = this.details;
    return problem;
  }

  static from(error, fallback = {}) {
    if (error instanceof MarketDataError) return error;
    const code = fallback.code || ERROR_CODES.INTERNAL_ERROR;
    return new MarketDataError(
      code,
      fallback.message || TITLE_BY_CODE[code] || "Unexpected market data error",
      { ...fallback, cause: error },
    );
  }
}
