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
import { createPostgresApiStore, serializePlayerResponse, serializeStandingRows, serializeTeamResponse } from './api-store';
import {
  DEFAULT_POSTGRES_IMPORT_BATCH_SIZE,
  isIdenticalCompletedPostgresBatch,
  MAX_POSTGRES_IMPORT_BATCH_SIZE,
  normalizeLegacyMatchResult,
  parseLegacySides,
  postgresSourceSignature,
  validatePostgresImportCheckpoint,
} from './legacy-import';
import { computeTournamentStandings } from '../domain/standings';
import { loadPersistenceEnvironment } from './environment';

export async function runPersistenceUnitTests(): Promise<void> {
  assert.strictEqual(canonicalizeName('  Straße\tTEAM  '), 'strasse team');
  assert.strictEqual(canonicalizeName('Σ ς'), 'σ σ');
  assert.notStrictEqual(canonicalizeName('I'), canonicalizeName('ı'));
  assert.strictEqual(DEFAULT_POSTGRES_IMPORT_BATCH_SIZE,250);
  assert.strictEqual(MAX_POSTGRES_IMPORT_BATCH_SIZE,1_000);
  const importCounts={users:2,players:4,tournaments:1,matches:1};
  const importHighWater={users:2,players:4,tournaments:1,matches:1};
  const importSignature=postgresSourceSignature(importCounts,importHighWater);
  assert.strictEqual(isIdenticalCompletedPostgresBatch('completed',importSignature,importSignature),true);
  assert.strictEqual(isIdenticalCompletedPostgresBatch('needs_review',importSignature,importSignature),true);
  assert.strictEqual(isIdenticalCompletedPostgresBatch('completed',importSignature,importSignature,true),false);
  assert.strictEqual(isIdenticalCompletedPostgresBatch('completed',importSignature,postgresSourceSignature(importCounts,{...importHighWater,matches:2})),false);
  assert.doesNotThrow(()=>validatePostgresImportCheckpoint(importSignature,importSignature,importSignature));
  assert.throws(()=>validatePostgresImportCheckpoint(importSignature,postgresSourceSignature(importCounts,{...importHighWater,players:5}),importSignature),/inventory changed/);
  assert.throws(()=>validatePostgresImportCheckpoint(importSignature,importSignature,Buffer.alloc(32)),/checkpoint checksum/);
  const initializedScores=parseLegacySides([
    {participants:[{id:'1',name:'A'}],score:0},
    {participants:[{id:'2',name:'B'}],score:0},
  ]);
  assert.deepStrictEqual(normalizeLegacyMatchResult('scheduled',null,null,initializedScores),{
    status:'scheduled',startedAt:null,scores:[null,null],winnerSide:null,completedAt:null,needsReview:false,warnings:[],
  });
  assert.deepStrictEqual(normalizeLegacyMatchResult('skipped',null,new Date('2029-01-01T00:00:00.000Z'),initializedScores),{
    status:'skipped',startedAt:null,scores:[null,null],winnerSide:null,completedAt:null,needsReview:false,warnings:[],
  });
  const legacyStart=new Date('2029-01-01T00:00:00.000Z');
  assert.deepStrictEqual(normalizeLegacyMatchResult('scheduled',legacyStart,null,initializedScores),{
    status:'in_progress',startedAt:legacyStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:true,warnings:['scheduled_match_has_start_time'],
  });
  const legacyPaused=normalizeLegacyMatchResult('paused',legacyStart,null,initializedScores);
  assert.strictEqual(legacyPaused.status,'in_progress');
  assert.strictEqual(legacyPaused.startedAt,legacyStart);
  assert.deepStrictEqual(legacyPaused.scores,[null,null]);
  assert.strictEqual(legacyPaused.needsReview,true);
  assert.ok(legacyPaused.warnings.includes('legacy_paused_without_pause_interval'));
  assert.deepStrictEqual(normalizeLegacyMatchResult('paused',null,null,initializedScores),{
    status:'in_progress',startedAt:null,scores:[null,null],winnerSide:null,completedAt:null,needsReview:true,warnings:['legacy_paused_without_pause_interval'],
  });
  const completedScores=parseLegacySides([
    {participants:[{id:'1',name:'A'}],score:4},
    {participants:[{id:'2',name:'B'}],score:2},
  ]);
  assert.deepStrictEqual(normalizeLegacyMatchResult('completed',null,new Date('2029-01-01T00:00:00.000Z'),completedScores),{
    status:'completed',startedAt:null,scores:[4,2],winnerSide:1,completedAt:new Date('2029-01-01T00:00:00.000Z'),needsReview:false,warnings:[],
  });
  const missingCompletion=normalizeLegacyMatchResult('completed',null,null,completedScores);
  assert.deepStrictEqual(missingCompletion.scores,[null,null]);
  assert.strictEqual(missingCompletion.status,'scheduled');
  assert.strictEqual(missingCompletion.needsReview,true);
  const invalidScore=parseLegacySides([
    {participants:[{id:'1',name:'A'}],score:1_000_001},
    {participants:[{id:'2',name:'B'}],score:0},
  ]);
  const invalidCompleted=normalizeLegacyMatchResult('completed',null,new Date('2029-01-01T00:00:00.000Z'),invalidScore);
  assert.deepStrictEqual(invalidCompleted.scores,[null,null]);
  assert.strictEqual(invalidCompleted.winnerSide,null);
  assert.strictEqual(invalidCompleted.needsReview,true);
  const corruptStart=normalizeLegacyMatchResult('completed','not-a-time',new Date('2029-01-01T00:05:00.000Z'),completedScores);
  assert.strictEqual(corruptStart.status,'scheduled');
  assert.strictEqual(corruptStart.startedAt,null);
  assert.deepStrictEqual(corruptStart.scores,[null,null]);
  assert.strictEqual(corruptStart.completedAt,null);
  assert.strictEqual(corruptStart.needsReview,true);
  assert.ok(corruptStart.warnings.includes('invalid_legacy_start_time'));
  assert.strictEqual(NAME_CANONICALIZATION_VERSION, 'nfkc-casefold-whitespace-v1');

  const createdAt=new Date('2029-01-01T00:00:00.000Z');
  const updatedAt=new Date('2029-01-02T00:00:00.000Z');
  const playerResponse=serializePlayerResponse({id:9,name:'A player',created_at:createdAt,updated_at:updatedAt});
  assert.deepStrictEqual(Object.keys(playerResponse).sort(),['createdAt','id','name','updatedAt']);
  const teamResponse=serializeTeamResponse({id:'team-id',name:'A team',created_at:createdAt,updated_at:updatedAt},[
    {id:9,name:'A player'},{id:10,name:'Another player'},
  ]);
  assert.deepStrictEqual(Object.keys(teamResponse).sort(),['createdAt','id','name','players','updatedAt']);
  const rawStandings=computeTournamentStandings('1v1',[{id:'p1',name:'Player 1'},{id:'p2',name:'Player 2'}],[]).players;
  const standingRows=serializeStandingRows(rawStandings);
  assert.deepStrictEqual(Object.keys(standingRows[0]!).sort(),[
    'draws','losses','matchesPlayed','name','playerIds','pointDifferential','pointsAgainst','pointsFor','rank','subjectType','wins',
  ]);

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
      return [{ request_count: 1, reset_at: new Date('2030-01-01T00:00:00.000Z'), allowed: true } as unknown as Row];
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
  assert.match(statements[0]!.sql, /RETURNING request_count, reset_at, request_count <= \$4 AS allowed/);
  assert.match(statements[0]!.sql, /current_bucket\.request_count <= \$4 THEN current_bucket\.request_count \+ 1/);
  assert.deepStrictEqual(statements[0]!.values, [Buffer.from(bucketHash, 'hex'), requestTime, 60_000, 3]);
  const explicitlyBlocked = await consumeRateLimitBucket({
    query: async <Row extends import('pg').QueryResultRow = import('pg').QueryResultRow>() => [
      { request_count: 3, reset_at: new Date(requestTime.getTime() + 60_000), allowed: false } as unknown as Row,
    ],
    execute: async () => 0,
  }, { bucketHash, now: requestTime, maximum: 3, windowMs: 60_000 });
  assert.deepStrictEqual(explicitlyBlocked, { allowed: false, retryAfterSeconds: 60 }, 'use the SQL admission decision independently of the capped count');
  assert.strictEqual(await pruneExpiredRateLimitBuckets(queryable, { batchSize: 2 }), 2);
  assert.match(statements[1]!.sql, /FOR UPDATE SKIP LOCKED/);
  await assert.rejects(() => consumeRateLimitBucket(queryable, {
    bucketHash: 'raw-key', now: requestTime, maximum: 3, windowMs: 60_000,
  }), /32-byte keyed hash/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tournament-persistence-'));
  try {
    await fs.writeFile(path.join(directory,'.env'),[
      'POSTGRES_URL=postgres://localhost/dotenv_test',
      'DB_POOL_MAX=4',
      'PERSISTENCE_ENV_SENTINEL=loaded',
      '',
    ].join('\n'));
    const injectedEnv={POSTGRES_URL:'postgres://localhost/runtime_test',DB_POOL_MAX:'2'} as NodeJS.ProcessEnv;
    loadPersistenceEnvironment(injectedEnv,directory);
    assert.strictEqual(injectedEnv.POSTGRES_URL,'postgres://localhost/runtime_test','runtime env must override .env');
    assert.strictEqual(injectedEnv.DB_POOL_MAX,'2','runtime pool setting must override .env');
    assert.strictEqual(injectedEnv.PERSISTENCE_ENV_SENTINEL,'loaded','missing runtime settings load from repository .env');
    const emptyEnv={} as NodeJS.ProcessEnv;
    const emptyDirectory=path.join(directory,'without-env');
    await fs.mkdir(emptyDirectory);
    loadPersistenceEnvironment(emptyEnv,emptyDirectory);
    assert.throws(()=>postgresPoolConfig(emptyEnv),/POSTGRES_URL is required/);

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
    const ownerTransferSql=`${migrations[1]!.sql}\n${migrations[3]!.sql}`;
    assert.doesNotMatch(ownerTransferSql,/ON UPDATE NO ACTION/i);
    assert.ok((ownerTransferSql.match(/ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED/g)??[]).length>=19);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runPersistenceUnitTests().then(() => process.stdout.write('Persistence unit tests passed\n'));
}
