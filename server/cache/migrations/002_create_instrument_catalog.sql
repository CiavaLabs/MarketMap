CREATE TABLE IF NOT EXISTS market_instrument_catalog (
  instrument_id    VARCHAR(191)    NOT NULL,
  descriptor_json  JSON            NOT NULL,
  mapping_revision INT UNSIGNED    NOT NULL DEFAULT 1,
  verified_at      TIMESTAMP(3)    NULL,
  last_seen_at     TIMESTAMP(3)    NOT NULL,
  status           VARCHAR(16)     NOT NULL,
  PRIMARY KEY (instrument_id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
