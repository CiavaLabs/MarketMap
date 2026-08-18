CREATE TABLE IF NOT EXISTS market_data_cache (
  cache_key VARCHAR(255) NOT NULL,
  instrument_id VARCHAR(191) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  source_as_of DATETIME(3) NULL,
  fetched_at DATETIME(3) NOT NULL,
  fresh_until DATETIME(3) NOT NULL,
  stale_until DATETIME(3) NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  payload_hash VARCHAR(128) NULL,
  last_success_at DATETIME(3) NOT NULL,
  PRIMARY KEY (cache_key),
  KEY idx_market_data_instrument_resource (instrument_id, resource_type),
  KEY idx_market_data_stale_until (stale_until),
  KEY idx_market_data_last_success (last_success_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
