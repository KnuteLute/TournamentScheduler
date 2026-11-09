import * as assert from 'assert';
import { randomBytes } from 'crypto';
import { PostgresDatabase, postgresPoolConfig } from '../src/persistence/database';
import { pruneExpiredRateLimitBuckets } from '../src/persistence/rate-limit';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || !process.env.RATE_LIMIT_TEST_DATABASE_URL) {
    throw new Error('Set NODE_ENV=test and RATE_LIMIT_TEST_DATABASE_URL to an isolated migrated test database');
  }
  const parsedUrl = new URL(process.env.RATE_LIMIT_TEST_DATABASE_URL);
  if (!decodeURIComponent(parsedUrl.pathname).toLowerCase().includes('test')) {
    throw new Error('Rate-limit integration database name must contain "test"');
  }
  const config = postgresPoolConfig({
    POSTGRES_URL: process.env.RATE_LIMIT_TEST_DATABASE_URL,
    NODE_ENV: 'test',
    DB_POOL_MAX: '2',
  });
  const first = new PostgresDatabase(config);
  const second = new PostgresDatabase(config);
  const rollbackKey = randomBytes(32).toString('hex');
  const concurrentKey = randomBytes(32).toString('hex');
  const rollbackKeyBytes = Buffer.from(rollbackKey, 'hex');
  const concurrentKeyBytes = Buffer.from(concurrentKey, 'hex');
  const request = (bucketHash: string, maximum: number) => ({
    bucketHash,
    now: new Date(),
    windowMs: 60_000,
    maximum,
  });
  try {
    await first.transaction(async tx => {
      await tx.consumeRateLimit(request(rollbackKey, 3));
      throw new Error('intentional_test_rollback');
    }).then(() => { throw new Error('transaction unexpectedly committed'); }, error => {
      assert.strictEqual((error as Error).message, 'intentional_test_rollback');
    });
    const rolledBack = await first.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM rate_limit_buckets WHERE bucket_key_hash = $1', [rollbackKeyBytes],
    );
    assert.strictEqual(Number(rolledBack[0]?.count), 0, 'bucket insert must roll back with its transaction');

    await first.transaction(tx => tx.consumeRateLimit(request(rollbackKey, 3)));
    const committed = await first.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM rate_limit_buckets WHERE bucket_key_hash = $1', [rollbackKeyBytes],
    );
    assert.strictEqual(Number(committed[0]?.count), 1, 'bucket insert must commit with its transaction');

    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const store = index % 2 === 0 ? first : second;
      return store.consumeRateLimit(request(concurrentKey, 5));
    }));
    assert.strictEqual(attempts.filter(result => result.allowed).length, 5, 'competing instances must not over-admit');
    assert.ok(attempts.every(result => result.retryAfterSeconds >= 0));
    const bucket = await first.query<{ request_count: number }>(
      'SELECT request_count FROM rate_limit_buckets WHERE bucket_key_hash = $1', [concurrentKeyBytes],
    );
    assert.strictEqual(Number(bucket[0]?.request_count), 6, 'the count saturates at the maximum plus one blocked-attempt marker');

    const aged = await first.execute(
      `UPDATE rate_limit_buckets SET window_started_at = statement_timestamp() - interval '100 years',
       reset_at = statement_timestamp() - interval '99 years' WHERE bucket_key_hash = $1`, [concurrentKeyBytes],
    );
    assert.strictEqual(aged,1,'test bucket is marked expired');
    const pruned = await pruneExpiredRateLimitBuckets(first, { batchSize: 10_000 });
    assert.ok(pruned>=1,'bounded expiry cleanup removes expired buckets');
    const remaining = await first.query<{count:string}>(
      'SELECT count(*)::text count FROM rate_limit_buckets WHERE bucket_key_hash=$1',[concurrentKeyBytes],
    );
    assert.strictEqual(Number(remaining[0]?.count),0,'expired test bucket is removed');
  } finally {
    await first.execute('DELETE FROM rate_limit_buckets WHERE bucket_key_hash = $1 OR bucket_key_hash = $2', [rollbackKeyBytes, concurrentKeyBytes]);
    await Promise.all([first.close(), second.close()]);
  }
}

main().then(() => process.stdout.write('Rate-limit PostgreSQL transaction/concurrency checks passed\n')).catch((error: unknown) => {
  const failure=error&&typeof error==='object'?error as {name?:unknown;code?:unknown;stack?:unknown}:{};
  const name=typeof failure.name==='string'&&/^[A-Za-z][A-Za-z0-9]*$/.test(failure.name)?failure.name:'Error';
  const code=typeof failure.code==='string'&&/^[A-Z0-9_]{1,32}$/.test(failure.code)?` ${failure.code}`:'';
  const stack=typeof failure.stack==='string'?failure.stack:'';
  const line=stack.match(/test-rate-limit-postgres\.ts:(\d+):\d+/)?.[1];
  console.error(`Rate-limit PostgreSQL checks failed${line?` at test-rate-limit-postgres.ts:${line}`:''} (${name}${code}); no connection details or credential material were emitted.`);
  process.exitCode = 1;
});
