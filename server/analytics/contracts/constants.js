export const ANALYTICS_SCHEMA_VERSION = 1;

export const MOVEMENT_METHOD_VERSION = "movement-ewma-empirical@1";
export const EWMA_MODEL_VERSION = "ewma-zero-mean@1";
export const MOVEMENT_QUALITY_VERSION = "movement-quality@1";

export const EWMA_LAMBDA = 0.94;
export const EWMA_WARMUP_RETURNS = 60;
export const EWMA_MISSING_RETURN_POLICY =
  "conditional_variance_carry_forward_no_return_imputation";
export const EMPIRICAL_REFERENCE_SCORES = 756;
export const MOVEMENT_REQUIRED_VALID_RETURNS =
  EWMA_WARMUP_RETURNS + EMPIRICAL_REFERENCE_SCORES + 1;
export const MOVEMENT_MAX_MISSING_RATE = 0.01;
export const MOVEMENT_BENCHMARK_INSTRUMENT_ID = "ARCX:SPY";
export const MOVEMENT_SESSION_CALENDAR_ID = "US_EQUITIES_CORE";

export const MOVEMENT_ASSESSMENT_STATUSES = Object.freeze([
  "available",
  "unavailable",
]);

export const MOVEMENT_UNAVAILABLE_REASONS = Object.freeze([
  "unsupported_asset_class",
  "unsupported_benchmark",
  "unsupported_interval",
  "unsupported_session_model",
  "unsupported_price_basis",
  "unsupported_adjustment_semantics",
  "unsupported_history_provider",
  "fallback_input",
  "stale_input",
  "unusable_history",
  "uncertified_session_grid",
  "invalid_session_grid",
  "unsupported_session_grid",
  "session_grid_timezone_mismatch",
  "invalid_timezone",
  "empty_history",
  "non_monotonic_timestamps",
  "as_of_mismatch",
  "duplicate_session_date",
  "unexpected_asset_session",
  "unexpected_benchmark_session",
  "asset_session_after_grid",
  "benchmark_session_after_grid",
  "insufficient_benchmark_sessions",
  "invalid_benchmark_session",
  "missing_current_session",
  "missing_previous_session",
  "invalid_current_adjusted_close",
  "invalid_previous_adjusted_close",
  "missing_session_rate_exceeded",
  "insufficient_valid_returns",
  "insufficient_reference_scores",
  "degenerate_variance",
  "non_finite_result",
]);

export const MOVEMENT_QUALITY_WARNINGS = Object.freeze([
  "provider_distributions_unknown",
  "dropped_rows_observed",
  "partial_adjusted_history",
]);

export const EMPIRICAL_TAIL = "absolute_two_sided";
export const EMPIRICAL_TIE_POLICY = "greater_than_or_equal";
export const EMPIRICAL_CORRECTION = "plus_one";

export const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
