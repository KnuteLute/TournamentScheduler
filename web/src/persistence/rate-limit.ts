import type { Queryable } from './database';

export interface RateLimitConsumeInput {
  /** 64-character hex encoding of an application HMAC; never raw identity. */
  bucketHash: string;
  now: Date;
  windowMs: number;
  maximum: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitPruneInput {
  /** Maximum rows removed by one bounded cleanup operation. */
  batchSize?: number;
}

function validateInput(input: RateLimitConsumeInput): void {
  if (typeof input.bucketHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.bucketHash)) {
    throw new TypeError('Rate-limit bucket hash must be the hex encoding of a 32-byte keyed hash');
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new TypeError('Rate-limit request time must be a valid Date');
  }
  if (!Number.isSafeInteger(input.maximum) || input.maximum < 1 || input.maximum > 1_000_000_000) {
    throw new RangeError('Rate-limit limit is outside the supported bound');
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000 || input.windowMs > 30 * 24 * 60 * 60 * 1_000) {
    throw new RangeError('Rate-limit window must be between one second and thirty days');
  }
}

/**
 * Atomically consumes one fixed-window request. The single INSERT .. ON
 * CONFLICT statement serializes competing instances on the bucket's primary
 * key; the request count stops increasing once blocked. `now` comes from the
 * trusted API server, never from request data.
 */
export async function consumeRateLimitBucket(
  queryable: Queryable,
  input: RateLimitConsumeInput,
): Promise<RateLimitConsumeResult> {
  validateInput(input);
  const rows = await queryable.query<{ request_count: number; reset_at: Date }>(
    `WITH request_clock AS (SELECT $2::timestamptz AS current_time)
     INSERT INTO rate_limit_buckets AS current_bucket
       (bucket_key_hash, request_count, window_started_at, reset_at)
     SELECT $1, 1, request_clock.current_time,
       request_clock.current_time + make_interval(secs => $3::double precision / 1000.0)
     FROM request_clock
     WHERE true
     ON CONFLICT (bucket_key_hash) DO UPDATE SET
       request_count = CASE
         WHEN current_bucket.reset_at <= EXCLUDED.window_started_at THEN 1
          WHEN current_bucket.request_count < $4 THEN current_bucket.request_count + 1
         ELSE current_bucket.request_count
       END,
       window_started_at = CASE
         WHEN current_bucket.reset_at <= EXCLUDED.window_started_at THEN EXCLUDED.window_started_at
         ELSE current_bucket.window_started_at
       END,
       reset_at = CASE
         WHEN current_bucket.reset_at <= EXCLUDED.window_started_at THEN EXCLUDED.reset_at
         ELSE current_bucket.reset_at
       END
     RETURNING request_count, reset_at`,
    [Buffer.from(input.bucketHash, 'hex'), input.now, input.windowMs, input.maximum],
  );
  const row = rows[0];
  if (!row) throw new Error('Rate-limit bucket operation returned no result');
  const count = Number(row.request_count);
  const resetAt = row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at);
  if (!Number.isSafeInteger(count) || Number.isNaN(resetAt.getTime())) {
    throw new Error('Rate-limit bucket operation returned invalid data');
  }
  const allowed = count <= input.maximum;
  const retryAfterSeconds = allowed ? 0 : Math.max(0, Math.ceil((resetAt.getTime() - input.now.getTime()) / 1_000));
  return { allowed, retryAfterSeconds };
}

/** Delete expired rows in a bounded, concurrency-safe batch. */
export async function pruneExpiredRateLimitBuckets(
  queryable: Queryable,
  input: RateLimitPruneInput = {},
): Promise<number> {
  const batchSize = input.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('Rate-limit prune batch size must be between 1 and 10000');
  }
  return queryable.execute(
    `WITH expired AS (
       SELECT bucket_key_hash FROM rate_limit_buckets
       WHERE reset_at <= statement_timestamp()
       ORDER BY reset_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     DELETE FROM rate_limit_buckets bucket
     USING expired
     WHERE bucket.bucket_key_hash = expired.bucket_key_hash`,
    [batchSize],
  );
}
