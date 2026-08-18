CREATE TABLE IF NOT EXISTS market_daily_bar_observation (
  observation_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  instrument_id           VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_date            DATE NOT NULL,
  revision                INT UNSIGNED NOT NULL,
  observed_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider                VARCHAR(64) NOT NULL,
  input_hash              CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_close          DOUBLE NOT NULL,
  provider_adjusted_close DOUBLE NULL,
  provider_volume         DOUBLE NULL,
  PRIMARY KEY (observation_id),
  UNIQUE KEY uq_market_bar_event (
    instrument_id,
    session_date,
    observed_at,
    input_hash
  ),
  UNIQUE KEY uq_market_bar_revision (instrument_id, session_date, revision),
  KEY idx_market_bar_as_of (instrument_id, observed_at, session_date, revision),
  CONSTRAINT chk_market_bar_revision CHECK (revision >= 1),
  CONSTRAINT chk_market_bar_provider CHECK (CHAR_LENGTH(TRIM(provider)) > 0),
  CONSTRAINT chk_market_bar_input_hash CHECK (
    input_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_bar_volume CHECK (provider_volume IS NULL OR provider_volume >= 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_volatility_forecast (
  forecast_id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id                  CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instrument_id           VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_session_date     DATE NOT NULL,
  information_set_end     DATE NOT NULL,
  recorded_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin                  VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_hash              CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_hash             CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  forecast_json           JSON NOT NULL,
  PRIMARY KEY (forecast_id),
  UNIQUE KEY uq_market_forecast_identity (
    run_id,
    instrument_id,
    target_session_date,
    information_set_end,
    origin,
    input_hash,
    config_hash
  ),
  KEY idx_market_forecast_target (target_session_date, instrument_id),
  KEY idx_market_forecast_run (run_id, instrument_id),
  CONSTRAINT chk_market_forecast_run_id CHECK (
    run_id REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_forecast_origin CHECK (origin IN ('live', 'backfill')),
  CONSTRAINT chk_market_forecast_input_hash CHECK (
    input_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_forecast_config_hash CHECK (
    config_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_forecast_information CHECK (
    information_set_end < target_session_date
  )
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_movement_assessment (
  assessment_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id                  CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instrument_id           VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_date            DATE NULL,
  computed_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_hash              CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_hash             CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assessment_json         JSON NOT NULL,
  PRIMARY KEY (assessment_id),
  UNIQUE KEY uq_market_assessment_run_instrument (run_id, instrument_id),
  KEY idx_market_assessment_session (session_date, instrument_id),
  KEY idx_market_assessment_latest (instrument_id, session_date, computed_at, run_id),
  KEY idx_market_assessment_computed_at (computed_at),
  CONSTRAINT chk_market_assessment_run_id CHECK (
    run_id REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_assessment_input_hash CHECK (
    input_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_assessment_config_hash CHECK (
    config_hash REGEXP '^sha256:[0-9a-f]{64}$'
  )
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_history_series_manifest (
  series_hash             CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instrument_id           VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_class             VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  history_range           VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  history_interval        VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider                VARCHAR(64) NOT NULL,
  provider_symbol         VARCHAR(191) NOT NULL,
  fallback                BOOLEAN NOT NULL,
  original_source         VARCHAR(64) NULL,
  price_basis             VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_price_basis   VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  adjustment_json         JSON NOT NULL,
  continuity_json         JSON NOT NULL,
  session_json            JSON NOT NULL,
  quality                 VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_quality_json       JSON NOT NULL,
  source_as_of            CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_session_date      DATE NOT NULL,
  last_session_date       DATE NOT NULL,
  bar_count               INT UNSIGNED NOT NULL,
  session_dates_json      JSON NOT NULL,
  bar_timestamps_json     JSON NOT NULL,
  bar_input_hashes_json    JSON NOT NULL,
  session_grid_hash       CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_grid_json       JSON NOT NULL,
  fetch_cutoff_json       JSON NOT NULL,
  PRIMARY KEY (series_hash),
  KEY idx_market_manifest_instrument_observed (instrument_id, observed_at),
  KEY idx_market_manifest_grid (session_grid_hash),
  CONSTRAINT chk_market_manifest_series_hash CHECK (
    series_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_manifest_grid_hash CHECK (
    session_grid_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_manifest_sessions CHECK (
    first_session_date <= last_session_date AND bar_count >= 1
  )
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_analytics_run_attempt (
  attempt_id                       CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id                           CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_completed_session_date DATE NOT NULL,
  expected_next_session_date      DATE NOT NULL,
  started_at                       CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  completed_at                     CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_hash                      CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_snapshot_json             JSON NOT NULL,
  status                           VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_count                  INT UNSIGNED NOT NULL,
  available_count                  INT UNSIGNED NOT NULL,
  unavailable_count                INT UNSIGNED NOT NULL,
  failed_count                     INT UNSIGNED NOT NULL,
  session_grid_hash                CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_manifest_json              JSON NOT NULL,
  failure_summary_json             JSON NOT NULL,
  PRIMARY KEY (attempt_id),
  KEY idx_market_attempt_run (run_id, started_at, attempt_id),
  KEY idx_market_attempt_grid (session_grid_hash),
  CONSTRAINT chk_market_attempt_id CHECK (
    attempt_id REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_attempt_run_id CHECK (
    run_id REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_attempt_config_hash CHECK (
    config_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_attempt_grid_hash CHECK (
    session_grid_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_market_attempt_sessions CHECK (
    expected_completed_session_date < expected_next_session_date
  ),
  CONSTRAINT chk_market_attempt_times CHECK (started_at <= completed_at),
  CONSTRAINT chk_market_attempt_counts CHECK (
    requested_count = available_count + unavailable_count + failed_count
  )
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
