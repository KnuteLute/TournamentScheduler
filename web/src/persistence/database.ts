import { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import process from 'process';
import {
  consumeRateLimitBucket,
  pruneExpiredRateLimitBuckets,
  RateLimitConsumeInput,
  RateLimitConsumeResult,
  RateLimitPruneInput,
} from './rate-limit';

export interface DatabaseEnvironment {
  POSTGRES_URL?: string;
  NODE_ENV?: string;
  VERCEL?: string;
  DB_POOL_MAX?: string;
}

export class PersistenceConflictError extends Error {
  readonly code = 'PERSISTENCE_CONFLICT';

  constructor(readonly constraint?: string) {
    super('A persistence constraint was violated');
    this.name = 'PersistenceConflictError';
  }
}

export class PersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE';

  constructor() {
    super('Persistence is unavailable');
    this.name = 'PersistenceUnavailableError';
  }
}

function parsePoolSize(value: string | undefined, vercel: boolean): number {
  const defaultValue = vercel ? 2 : 4;
  if (value === undefined || value.trim() === '') return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error('DB_POOL_MAX must be an integer between 1 and 10');
  const parsed = Number(value);
  const maximum = vercel ? 5 : 10;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`DB_POOL_MAX must be between 1 and ${maximum} for this runtime`);
  }
  return parsed;
}

/** Build a bounded and fail-closed PostgreSQL pool configuration. */
export function postgresPoolConfig(env: DatabaseEnvironment = process.env): PoolConfig {
  const connectionString = env.POSTGRES_URL?.trim();
  if (!connectionString) throw new Error('POSTGRES_URL is required');

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('POSTGRES_URL must be a valid PostgreSQL connection URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('POSTGRES_URL must use the PostgreSQL protocol');
  }

  const production = env.NODE_ENV === 'production';
  const vercel = env.VERCEL === '1' || env.VERCEL === 'true';
  const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
  if (production && (!sslMode || !['require', 'verify-ca', 'verify-full'].includes(sslMode))) {
    throw new Error('Production PostgreSQL connections must configure sslmode=require or stricter');
  }

  return {
    connectionString,
    ...(production ? { ssl: { rejectUnauthorized: true } } : {}),
    max: parsePoolSize(env.DB_POOL_MAX, vercel),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    application_name: 'tournament-scheduler',
    options: '-c search_path=public,pg_catalog',
    allowExitOnIdle: true,
  };
}

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
  execute(sql: string, values?: readonly unknown[]): Promise<number>;
}

export interface TransactionQueryable extends Queryable {
  consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult>;
  pruneExpiredRateLimitBuckets(input?: RateLimitPruneInput): Promise<number>;
}

function assertBoundQuery(sql: string, values: readonly unknown[] = []): void {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 1_000_000) {
    throw new TypeError('SQL statement must be a non-empty bounded string');
  }
  if (values.length > 1_000) throw new TypeError('SQL parameter count exceeds the supported bound');
  if (values.some(value => value === undefined)) {
    throw new TypeError('SQL parameters must not contain undefined values');
  }
}

function mapDatabaseError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError && ['23505', '23503', '23514', '23P01'].includes(pgError.code || '')) {
    throw new PersistenceConflictError(pgError.constraint);
  }
  if (pgError && ['08000', '08003', '08006', '57P01', '53300'].includes(pgError.code || '')) {
    throw new PersistenceUnavailableError();
  }
  throw error;
}

class ClientQueryable implements TransactionQueryable {
  constructor(protected readonly client: Pool | PoolClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    assertBoundQuery(sql, values);
    try {
      const result = await this.client.query<Row>(sql, [...values]);
      return result.rows;
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async execute(sql: string, values: readonly unknown[] = []): Promise<number> {
    assertBoundQuery(sql, values);
    try {
      const result = await this.client.query(sql, [...values]);
      return result.rowCount ?? 0;
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    return consumeRateLimitBucket(this, input);
  }

  async pruneExpiredRateLimitBuckets(input?: RateLimitPruneInput): Promise<number> {
    return pruneExpiredRateLimitBuckets(this, input);
  }
}

/** A small PostgreSQL unit-of-work wrapper with bounded pool behavior. */
export class PostgresDatabase extends ClientQueryable {
  private readonly pool: Pool;

  constructor(config: PoolConfig = postgresPoolConfig()) {
    const pool = new Pool(config);
    super(pool);
    this.pool = pool;
    this.pool.on('error', () => {
      // Pool errors can contain connection details. Callers receive only the
      // safe unavailable error from an active query; do not log raw events.
    });
  }

  async transaction<T>(work: (tx: TransactionQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new ClientQueryable(client);
    try {
      await client.query('BEGIN');
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction failure without logging SQL/data.
      }
      return mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Shared persistent rate-limit operation. The caller supplies only a
   * lowercase-hex 32-byte HMAC, never an unhashed identity.
   */
  async consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    return consumeRateLimitBucket(this, input);
  }

  async pruneExpiredRateLimitBuckets(input?: RateLimitPruneInput): Promise<number> {
    return pruneExpiredRateLimitBuckets(this, input);
  }
}
