import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { postgresPoolConfig } from './database';
import { AtomicLocalJsonFile, assertLocalJsonModeAllowed, LocalJsonCorruptError } from './local-json';
import { canonicalizeName, NAME_CANONICALIZATION_VERSION } from '../domain/names';
import { readMigrations } from './migrations';
import { Queryable } from './database';
import { consumeRateLimitBucket, pruneExpiredRateLimitBuckets } from './rate-limit';
import { createPostgresApiStore } from './api-store';
import { DEFAULT_POSTGRES_IMPORT_BATCH_SIZE, MAX_POSTGRES_IMPORT_BATCH_SIZE } from './legacy-import';

export async function runPersistenceUnitTests(): Promise<void> {
  assert.strictEqual(canonicalizeName('  Straße\tTEAM  '), 'strasse team');
  assert.strictEqual(canonicalizeName('Σ ς'), 'σ σ');
  assert.notStrictEqual(canonicalizeName('I'), canonicalizeName('ı'));
  assert.strictEqual(DEFAULT_POSTGRES_IMPORT_BATCH_SIZE,250);
  assert.strictEqual(MAX_POSTGRES_IMPORT_BATCH_SIZE,1_000);
  assert.strictEqual(NAME_CANONICALIZATION_VERSION, 'nfkc-casefold-whitespace-v1');

  assert.throws(() => postgresPoolConfig({ NODE_ENV: 'production', POSTGRES_URL: 'postgres://a:b@host/db' }), /sslmode/);
  assert.throws(() => postgresPoolConfig({ POSTGRES_URL: 'postgres://a:b@host/db', VERCEL: '1', DB_POOL_MAX: '6' }), /between 1 and 5/);
  assert.strictEqual(postgresPoolConfig({ POSTGRES_URL: 'postgres://a:b@host/db', VERCEL: '1' }).max, 2);
  const apiStore=createPostgresApiStore({POSTGRES_URL:'postgres://user:pass@localhost/tournament_test',NODE_ENV:'test'} as NodeJS.ProcessEnv);
  assert.strictEqual(typeof apiStore.execute,'function');
  assert.strictEqual(typeof apiStore.lookupSessionByTokenHash,'function');
  assert.strictEqual(typeof apiStore.consumeRateLimit,'function');
  await (apiStore as typeof apiStore & {close():Promise<void>}).close();
  assert.throws(() => assertLocalJsonModeAllowed({ DB_MODE: 'local', NODE_ENV: 'production', LOCAL_JSON_MODE: 'single-process' }), /disabled in production/);
  assert.throws(() => assertLocalJsonModeAllowed({ DB_MODE: 'local', VERCEL: '1', LOCAL_JSON_MODE: 'single-process' }), /serverless/);
  assert.throws(() => assertLocalJsonModeAllowed({ DB_MODE: 'local', NODE_ENV: 'development' }), /explicitly enable/);

  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const queryable: Queryable = {
    query: async <Row extends import('pg').QueryResultRow = import('pg').QueryResultRow>(sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      return [{ request_count: 1, reset_at: new Date('2030-01-01T00:00:00.000Z') } as unknown as Row];
    },
    execute: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      return 2;
    },
  };
  const bucketHash = Buffer.alloc(32, 7).toString('hex');
  const requestTime = new Date('2029-01-01T00:00:00.000Z');
  const consumed = await consumeRateLimitBucket(queryable, { bucketHash, now: requestTime, maximum: 3, windowMs: 60_000 });
  assert.deepStrictEqual(consumed, {
    allowed: true, retryAfterSeconds: 0,
  });
  assert.match(statements[0]!.sql, /ON CONFLICT \(bucket_key_hash\) DO UPDATE/);
  assert.deepStrictEqual(statements[0]!.values, [Buffer.from(bucketHash, 'hex'), requestTime, 60_000, 3]);
  assert.strictEqual(await pruneExpiredRateLimitBuckets(queryable, { batchSize: 2 }), 2);
  assert.match(statements[1]!.sql, /FOR UPDATE SKIP LOCKED/);
  await assert.rejects(() => consumeRateLimitBucket(queryable, {
    bucketHash: 'raw-key', now: requestTime, maximum: 3, windowMs: 60_000,
  }), /32-byte keyed hash/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tournament-persistence-'));
  try {
    const file = new AtomicLocalJsonFile<{ value: number }>(directory, 'data.json');
    assert.strictEqual(await file.read(), null);
    await file.write({ value: 1 });
    await file.write({ value: 2 });
    assert.deepStrictEqual(await file.read(), { value: 2 });
    assert.deepStrictEqual(JSON.parse(await fs.readFile(`${file.filePath}.bak`, 'utf8')), { value: 1 });
    assert.strictEqual((await fs.stat(file.filePath)).mode & 0o777, 0o600);
    assert.strictEqual((await fs.stat(directory)).mode & 0o777, 0o700);
    await fs.writeFile(file.filePath, '{broken');
    await assert.rejects(() => file.read(), LocalJsonCorruptError);
    await fs.writeFile(`${file.filePath}.lock`, 'operator-review');
    await assert.rejects(() => file.write({ value: 3 }), /Another local JSON writer/);
    await fs.unlink(`${file.filePath}.lock`);

    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    const migrations = await readMigrations(migrationsDir);
    assert.deepStrictEqual(migrations.map(migration => migration.version), [1, 2, 3, 4]);
    assert.ok(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum)));
    assert.ok(migrations[2]!.sql.includes('CREATE TABLE rate_limit_buckets'));
    assert.ok(migrations.every(migration => !/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(migration.sql)));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runPersistenceUnitTests().then(() => process.stdout.write('Persistence unit tests passed\n'));
}
