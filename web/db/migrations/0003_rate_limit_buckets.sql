CREATE TABLE rate_limit_buckets (
  bucket_key_hash BYTEA PRIMARY KEY CHECK (octet_length(bucket_key_hash) = 32),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  window_started_at TIMESTAMPTZ NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL,
  CHECK (reset_at > window_started_at)
);
CREATE INDEX rate_limit_buckets_reset_at_idx ON rate_limit_buckets (reset_at);
