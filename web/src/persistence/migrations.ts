import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Client, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import process from 'process';
import { postgresPoolConfig, Queryable } from './database';

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationResult {
  applied: number[];
  alreadyApplied: number[];
  baselinedLegacySchema: boolean;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = (await fs.readdir(directory)).filter(name => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    const version = Number(name.slice(0, 4));
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration filename: ${name}`);
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    if (!sql.trim()) throw new Error(`Migration ${name} is empty`);
    migrations.push({ version, name, sql, checksum: checksum(sql) });
  }
  for (let index = 1; index < migrations.length; index += 1) {
    const current = migrations[index]!;
    const previous = migrations[index - 1]!;
    if (current.version === previous.version) {
      throw new Error(`Duplicate migration version ${current.version}`);
    }
  }
  return migrations;
}

async function relationExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean } & QueryResultRow>('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${tableName}`]);
  return result.rows[0]?.exists === true;
}

async function baselineLegacySchema(client: Client, migration: MigrationFile): Promise<boolean> {
  const names = ['users', 'players', 'tournaments', 'matches'];
  const presence = await Promise.all(names.map(name => relationExists(client, name)));
  if (!presence.some(Boolean)) return false;
  if (!presence.every(Boolean)) {
    throw new Error('Database contains a partial legacy schema; refusing to guess or mutate it');
  }

  const result = await client.query<{ valid: boolean } & QueryResultRow>(
    `WITH required(table_name, column_name) AS (VALUES
       ('users', 'id'), ('users', 'username'), ('users', 'password_hash'), ('users', 'created_at'),
       ('players', 'id'), ('players', 'user_id'), ('players', 'guest_session_id'), ('players', 'name'),
       ('players', 'games_played'), ('players', 'wins'), ('players', 'losses'), ('players', 'draws'),
       ('players', 'points_for'), ('players', 'points_against'), ('players', 'diff'), ('players', 'created_at'),
       ('tournaments', 'id'), ('tournaments', 'user_id'), ('tournaments', 'guest_session_id'),
       ('tournaments', 'mode'), ('tournaments', 'date'), ('tournaments', 'standings'),
       ('matches', 'id'), ('matches', 'tournament_id'), ('matches', 'user_id'), ('matches', 'guest_session_id'),
       ('matches', 'teams'), ('matches', 'status'), ('matches', 'start_time'), ('matches', 'end_time'),
       ('matches', 'mode'), ('matches', 'round'), ('matches', 'court')
     )
     SELECT NOT EXISTS (
       SELECT 1 FROM required r LEFT JOIN information_schema.columns c
         ON c.table_schema = 'public' AND c.table_name = r.table_name AND c.column_name = r.column_name
       WHERE c.column_name IS NULL
     ) AS valid`,
  );
  if (!result.rows[0]?.valid) throw new Error('Legacy schema is not recognized; refusing to mark it as baselined');

  await client.query(
    'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
    [migration.version, migration.name, migration.checksum],
  );
  return true;
}

async function appliedMigrations(db: Queryable): Promise<AppliedMigration[]> {
  const rows = await db.query<{ version: number; name: string; checksum: string; applied_at: Date } & QueryResultRow>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return rows.map(row => ({ version: Number(row.version), name: row.name, checksum: row.checksum, appliedAt: row.applied_at }));
}

/** Apply ordered migrations under a PostgreSQL advisory lock. Never runs at app startup. */
export async function applyMigrations(directory: string, connectionConfig: PoolConfig = postgresPoolConfig(process.env)): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);
  if (migrations.length === 0) throw new Error('No database migrations were found');
  const client = new Client(connectionConfig);
  await client.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [], baselinedLegacySchema: false };
  try {
    await client.query('SET search_path TO public, pg_catalog');
    await client.query('SELECT pg_advisory_lock($1)', [7281946301]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    let applied = await appliedMigrations(new ClientQueryableForMigrations(client));
    const appliedByVersion = new Map(applied.map(item => [item.version, item]));
    const knownVersions = new Set(migrations.map(item => item.version));
    if (applied.some(item => !knownVersions.has(item.version))) {
      throw new Error('Database contains a migration version absent from this release; refusing to continue');
    }

    const baselineMigration = migrations[0]!;
    if (!appliedByVersion.has(baselineMigration.version)) {
      await client.query('BEGIN');
      try {
        result.baselinedLegacySchema = await baselineLegacySchema(client, baselineMigration);
        if (!result.baselinedLegacySchema) {
          await client.query(baselineMigration.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            baselineMigration.version, baselineMigration.name, baselineMigration.checksum,
          ]);
          result.applied.push(baselineMigration.version);
        } else {
          result.alreadyApplied.push(baselineMigration.version);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied = await appliedMigrations(new ClientQueryableForMigrations(client));
    }

    const nowApplied = new Map(applied.map(item => [item.version, item]));
    for (const migration of migrations) {
      const prior = nowApplied.get(migration.version);
      if (prior) {
        if (prior.name !== migration.name || prior.checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.version} checksum does not match the repository`);
        }
        if (!result.applied.includes(migration.version) && !result.alreadyApplied.includes(migration.version)) {
          result.alreadyApplied.push(migration.version);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version, migration.name, migration.checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [7281946301]);
    } finally {
      await client.end();
    }
  }
}

// A narrow adapter is used because migration bookkeeping needs raw pg client
// semantics and must not go through app-level conflict translation.
class ClientQueryableForMigrations implements Queryable {
  constructor(private readonly client: Client | PoolClient) {}
  async query<Row extends import('pg').QueryResultRow = import('pg').QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    return (await this.client.query<Row>(sql, [...values])).rows;
  }
  async execute(sql: string, values: readonly unknown[] = []): Promise<number> {
    return (await this.client.query(sql, [...values])).rowCount ?? 0;
  }
}
