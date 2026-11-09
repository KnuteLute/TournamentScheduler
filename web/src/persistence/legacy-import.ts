import { createHash, randomUUID } from 'crypto';
import { basename, resolve } from 'path';
import { PostgresDatabase, Queryable } from './database';
import { QueryResultRow } from 'pg';
import { canonicalizeName, NAME_CANONICALIZATION_VERSION } from '../domain/names';
import { isValidInstant } from '../domain/validation';
import { MAX_SCORE } from '../domain/types';

export type LegacyEntity = 'users' | 'players' | 'tournaments' | 'matches';

export interface LegacyImportSummary {
  source: 'legacy_postgres' | 'local_json';
  sourceLabel: string;
  dryRun: boolean;
  batchId?: string;
  counts: Record<string, number>;
  checkpoint?: Record<string, number>;
  highWater?: Record<string, number>;
  quarantined: number;
  needsReview: number;
  noOp: boolean;
  warnings: string[];
}

interface LegacyJsonRow extends Record<string, unknown> {
  id?: number | string;
}

const ENTITIES: LegacyEntity[] = ['users', 'players', 'tournaments', 'matches'];
export const MAX_LOCAL_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_LOCAL_IMPORT_RECORDS = 10_000;
export const DEFAULT_POSTGRES_IMPORT_BATCH_SIZE = 250;
export const MAX_POSTGRES_IMPORT_BATCH_SIZE = 1_000;

function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

function hashRecord(row: unknown): Buffer {
  return digest(JSON.stringify(row));
}

export function postgresSourceSignature(counts:Record<string,number>,highWater:Record<string,number>):Buffer{
  return digest(['users','players','tournaments','matches'].map(entity=>
    `${entity}:${counts[entity]??0}:${highWater[entity]??0}`,
  ).join('\n'));
}

export function validatePostgresImportCheckpoint(stored:Uint8Array,current:Uint8Array,checkpoint:Uint8Array):void{
  if(!Buffer.from(stored).equals(Buffer.from(checkpoint)))throw new Error('Legacy import checkpoint checksum is invalid; refusing to resume.');
  if(!Buffer.from(stored).equals(Buffer.from(current)))throw new Error('Legacy source inventory changed during an import checkpoint; refusing to resume.');
}

export function isIdenticalCompletedPostgresBatch(
  status:'completed'|'needs_review',
  storedHash:Uint8Array,
  currentHash:Uint8Array,
  rescan=false,
):boolean{
  return !rescan&&(status==='completed'||status==='needs_review')&&Buffer.from(storedHash).equals(Buffer.from(currentHash));
}

function asStableId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeInteger(value: unknown): number {
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:0;
}

function safeLocalSourceLabel(filePath: string): string {
  const file = basename(filePath);
  const parent = filePath.split(/[\\/]/).slice(-2, -1)[0];
  if (file === 'offline-db.json' || file === 'players_index.json' || file === 'tournament_history.json' || file === 'match_history.json') return file;
  if (parent === 'players' && /^\d+\.json$/.test(file)) return `players/${file}`;
  return 'local-json-source';
}

function jsonEntities(input: unknown, filePath: string): { rows: Record<LegacyEntity, LegacyJsonRow[]>; malformed: number } {
  const rows = {} as Record<LegacyEntity, LegacyJsonRow[]>;
  let malformed = 0;
  if (Array.isArray(input)) {
    rows.users = [];
    rows.players = [];
    rows.tournaments = [];
    rows.matches = [];
    const file = basename(filePath);
    if (file === 'tournament_history.json') {
      rows.tournaments = input.filter((row): row is LegacyJsonRow => {
        const valid = !!row && typeof row === 'object' && !Array.isArray(row) && asStableId((row as LegacyJsonRow).id) !== null;
        if (!valid) malformed += 1;
        return valid;
      });
      rows.matches = rows.tournaments.flatMap(tournament => {
        const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
        return matches.filter((match): match is LegacyJsonRow => {
          const valid = !!match && typeof match === 'object' && !Array.isArray(match) && asStableId((match as LegacyJsonRow).id) !== null;
          if (!valid) malformed += 1;
          return valid;
        }).map(match => ({ ...match, id: `${asStableId(tournament.id)}:${asStableId(match.id)}`, tournament_id: tournament.id }));
      });
    } else if (file === 'match_history.json') {
      rows.matches = input.filter((row): row is LegacyJsonRow => {
        const valid = !!row && typeof row === 'object' && !Array.isArray(row) && asStableId((row as LegacyJsonRow).id) !== null;
        if (!valid) malformed += 1;
        return valid;
      });
    } else {
      malformed += 1;
    }
    return { rows, malformed };
  }
  if (!input || typeof input !== 'object') throw new Error('Legacy JSON must be an object or a recognized legacy array');
  const root = input as Record<string, unknown>;
  const file = basename(filePath);
  const parent = filePath.split(/[\\/]/).slice(-2, -1)[0];
  if (file === 'players_index.json') {
    rows.users = [];
    rows.tournaments = [];
    rows.matches = [];
    rows.players = Object.entries(root).flatMap(([id, name]) => {
      if (typeof name !== 'string') {
        malformed += 1;
        return [];
      }
      return [{ id, name }];
    });
    return { rows, malformed };
  }
  if (parent === 'players' && /^\d+\.json$/.test(file)) {
    rows.users = [];
    rows.tournaments = [];
    rows.matches = [];
    rows.players = [{ ...root, id: file.slice(0, -5) }];
    return { rows, malformed };
  }
  for (const entity of ENTITIES) {
    const value = root[entity];
    if (value === undefined) {
      rows[entity] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      rows[entity] = [];
      malformed += 1;
      continue;
    }
    rows[entity] = value.filter((row): row is LegacyJsonRow => {
      const valid = !!row && typeof row === 'object' && !Array.isArray(row) && asStableId((row as LegacyJsonRow).id) !== null;
      if (!valid) malformed += 1;
      return valid;
    });
  }
  return { rows, malformed };
}

interface PriorBatch { id: string; status: 'completed' | 'needs_review'; counts: Record<string, unknown>; }

async function findPriorBatch(db: Queryable, sourceType: string, label: string, contentHash: Buffer): Promise<PriorBatch | null> {
  const rows = await db.query<PriorBatch & QueryResultRow>(
    `SELECT id, status, counts FROM import_batches
     WHERE source_type = $1 AND source_identifier = $2 AND content_hash = $3
       AND status IN ('completed', 'needs_review') ORDER BY started_at DESC LIMIT 1`,
    [sourceType, label, contentHash],
  );
  return rows[0] ?? null;
}

async function sourceRecordState(
  tx: Queryable,
  namespace: string,
  entity: string,
  sourceKey: string,
  rowHash: Buffer,
): Promise<{ changed: boolean; unresolved: boolean }> {
  const rows = await tx.query<{ changed: boolean; unresolved: boolean } & QueryResultRow>(
    `SELECT coalesce(bool_or(source_hash <> $4), false) AS changed,
       coalesce(bool_or(status = 'needs_review'), false) AS unresolved
     FROM import_records WHERE source_namespace = $1 AND source_entity = $2 AND source_key = $3`,
    [namespace, entity, sourceKey, rowHash],
  );
  return { changed: rows[0]?.changed ?? false, unresolved: rows[0]?.unresolved ?? false };
}

async function beginBatch(
  tx: Queryable,
  sourceType: 'legacy_postgres' | 'local_json',
  sourceIdentifier: string,
  contentHash: Buffer,
): Promise<string> {
  const id = randomUUID();
  await tx.execute(
    `INSERT INTO import_batches
      (id, source_type, source_identifier, content_hash, importer_version, schema_version, status)
      VALUES ($1, $2, $3, $4, $5, 4, 'started')`,
    [id, sourceType, sourceIdentifier, contentHash, `persistence-import/2;names=${NAME_CANONICALIZATION_VERSION}`],
  );
  return id;
}

async function appendImportRecord(
  tx: Queryable,
  batchId: string,
  sourceNamespace: string,
  entity: string,
  sourceKey: string,
  rowHash: Buffer,
  status: 'imported' | 'quarantined' | 'needs_review' | 'skipped',
  warnings: string[] = [],
  targetEntity: string | null = null,
  targetId: string | null = null,
): Promise<void> {
  await tx.execute(
    `INSERT INTO import_records
      (id, batch_id, source_namespace, source_entity, source_key, source_hash, target_entity, target_id, status, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (batch_id, source_namespace, source_entity, source_key) DO NOTHING`,
    [randomUUID(), batchId, sourceNamespace, entity, sourceKey, rowHash, targetEntity, targetId, status, JSON.stringify(warnings)],
  );
}

export async function inspectLocalJson(
  db: PostgresDatabase | null,
  filePath: string,
  raw: Buffer,
  apply: boolean,
): Promise<LegacyImportSummary> {
  const label = safeLocalSourceLabel(filePath);
  const sourceNamespace = `local-json:${digest(resolve(filePath)).toString('hex')}`;
  if (raw.length > MAX_LOCAL_IMPORT_BYTES) {
    return {
      source: 'local_json', sourceLabel: label, dryRun: !apply,
      counts: {}, quarantined: 0, needsReview: 1, noOp: false,
      warnings: ['source_exceeds_size_limit'],
    };
  }
  const contentHash = digest(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      source: 'local_json', sourceLabel: label, dryRun: !apply,
      counts: {}, quarantined: 0, needsReview: 1, noOp: false,
      warnings: ['invalid_json'],
    };
  }
  const { rows, malformed } = jsonEntities(parsed, filePath);
  const counts = Object.fromEntries(ENTITIES.map(entity => [entity, rows[entity].length]));
  const recordCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!apply) {
    return {
      source: 'local_json', sourceLabel: label, dryRun: true, counts,
      quarantined: recordCount,
      needsReview: malformed, noOp: false,
      warnings: [
        'unclaimed_local_data_is_quarantined',
        ...(recordCount > MAX_LOCAL_IMPORT_RECORDS ? ['source_exceeds_import_batch_bound'] : []),
        ...(malformed ? ['malformed_records_skipped'] : []),
      ],
    };
  }

  if (recordCount > MAX_LOCAL_IMPORT_RECORDS) {
    return {
      source: 'local_json', sourceLabel: label, dryRun: false, counts,
      quarantined: 0, needsReview: malformed, noOp: true,
      warnings: ['source_exceeds_import_batch_bound'],
    };
  }

  if (!db) throw new Error('Database is required to record an applied local import');

  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [7281946302]);
    const previous = await findPriorBatch(tx, 'local_json', sourceNamespace, contentHash);
    if (previous) {
      const previousCounts = previous.counts;
      return {
        source: 'local_json', sourceLabel: label, dryRun: false, batchId: previous.id,
        counts, quarantined: Object.values(counts).reduce((sum, count) => sum + count, 0),
        needsReview: Number(previousCounts.malformed || 0) + Number(previousCounts.changedRecords || 0),
        noOp: true, warnings: ['identical_source_already_recorded', ...(previous.status === 'needs_review' ? ['review_required'] : [])],
      };
    }
    const batchId = await beginBatch(tx, 'local_json', sourceNamespace, contentHash);
    const quarantineOwnerId = await getOrCreateQuarantineOwner(tx, sourceNamespace);

    let changedRecords = 0;
    for (const entity of ENTITIES) {
      for (const row of rows[entity]) {
        const sourceKey = asStableId(row.id);
        if (sourceKey === null) continue;
        const rowHash = hashRecord(row);
        const sourceState = await sourceRecordState(tx, sourceNamespace, entity, sourceKey, rowHash);
        if (sourceState.changed || sourceState.unresolved) changedRecords += 1;
        await appendImportRecord(
          tx, batchId, sourceNamespace, entity, sourceKey,
          rowHash, sourceState.changed || sourceState.unresolved ? 'needs_review' : 'quarantined',
          sourceState.changed || sourceState.unresolved
            ? ['source_record_changed_review_required']
            : ['ownership_proof_required'], 'data_owners', quarantineOwnerId,
        );
      }
    }
    await tx.execute(
      `UPDATE import_batches SET status = $2, completed_at = now(), counts = $3::jsonb,
        error_summary = $4 WHERE id = $1`,
      [batchId, malformed || changedRecords ? 'needs_review' : 'completed', JSON.stringify({ ...counts, malformed, changedRecords }),
        malformed || changedRecords ? 'review_required' : null],
    );
    return {
      source: 'local_json', sourceLabel: label, dryRun: false, batchId, counts,
      quarantined: recordCount, needsReview: malformed + changedRecords, noOp: false,
      warnings: ['source_file_unchanged', 'unclaimed_local_data_is_quarantined',
        ...(malformed ? ['malformed_records_skipped'] : []), ...(changedRecords ? ['source_record_changed_review_required'] : [])],
    };
  });
}

interface LegacyUser extends QueryResultRow { id: number; username: string; }
interface LegacyPlayer extends QueryResultRow {
  id: number;
  user_id: number | null;
  guest_session_id: string | null;
  name: string;
  games_played: number | null;
  wins: number | null;
  losses: number | null;
  draws: number | null;
  points_for: number | null;
  points_against: number | null;
}
interface LegacyTournament extends QueryResultRow { id: number; user_id: number | null; guest_session_id: string | null; }
interface LegacyMatch extends QueryResultRow {
  id: number;
  tournament_id: number | null;
  user_id: number | null;
  guest_session_id: string | null;
  teams: unknown;
  status: string | null;
  start_time: Date | string | null;
  end_time: Date | string | null;
}

export interface LegacySide {
  participants: Array<{ id?: unknown; name?: unknown }>;
  score?: unknown;
}

export interface ParsedLegacySides {
  sides: LegacySide[] | null;
  warnings: string[];
}

export interface NormalizedLegacyMatchResult {
  status: 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'skipped';
  startedAt: Date | null;
  scores: [number | null, number | null];
  winnerSide: 1 | 2 | null;
  completedAt: Date | null;
  needsReview: boolean;
  warnings: string[];
}

export function parseLegacySides(value: unknown): ParsedLegacySides {
  const invalid=(warning:string):ParsedLegacySides=>({sides:null,warnings:[warning]});
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return invalid('invalid_match_json'); }
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return invalid('match_must_have_two_sides');
  const sides: LegacySide[] = [];
  const warnings:string[]=[];
  for (const rawSide of parsed) {
    if (!rawSide || typeof rawSide !== 'object' || !Array.isArray((rawSide as { participants?: unknown }).participants)) {
      return invalid('invalid_side_shape');
    }
    const participants = (rawSide as { participants: unknown[] }).participants;
    if (participants.length < 1 || participants.length > 2) return invalid('invalid_side_participant_count');
    const normalized = [] as LegacySide['participants'];
    for (const participant of participants) {
      if (!participant || typeof participant !== 'object') return invalid('invalid_match_participant');
      const item = participant as { id?: unknown; name?: unknown };
      if (typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.length > 255) {
        return invalid('invalid_match_name_snapshot');
      }
      normalized.push({ id: item.id, name: item.name });
    }
    const score = (rawSide as { score?: unknown }).score;
    if (score !== undefined && score !== null && (!Number.isSafeInteger(score) || Number(score) < 0 || Number(score)>MAX_SCORE)) {
      warnings.push('invalid_match_score');
      sides.push({participants:normalized});
      continue;
    }
    sides.push({ participants: normalized, score });
  }
  return { sides,warnings };
}

function validLegacyInstant(value:Date|string|null):Date|null{
  if(value===null)return null;
  if(value instanceof Date)return Number.isNaN(value.getTime())?null:value;
  if(!isValidInstant(value))return null;
  const date=new Date(value);return Number.isNaN(date.getTime())?null:date;
}

/** Normalize historical scores only when the source provides a completed result. */
export function normalizeLegacyMatchResult(
  legacyStatus:string|null,
  startTime:Date|string|null,
  endTime:Date|string|null,
  parsed:ParsedLegacySides,
):NormalizedLegacyMatchResult{
  const status=(legacyStatus??'').trim().toLowerCase().replace(/[\s-]+/gu,'_');
  const explicitSkipped=['skipped','skip','void','voided'].includes(status);
  const explicitPaused=status==='paused';
  const explicitInProgress=['in_progress','playing'].includes(status);
  const explicitScheduled=['scheduled','pending',''].includes(status);
  const completedStatus=['completed','complete','finished','done'].includes(status);
  const validStart=validLegacyInstant(startTime);
  const validTime=validLegacyInstant(endTime);
  const sides=parsed.sides;
  const bothScores=sides!==null&&sides.length===2&&sides.every(side=>
    typeof side.score==='number'&&Number.isSafeInteger(side.score)&&side.score>=0&&side.score<=MAX_SCORE);
  const scoreValues=bothScores?[Number(sides![0]!.score),Number(sides![1]!.score)] as [number,number]:null;
  const hasCompletionEvidence=completedStatus||(!status&&endTime!==null);
  const warnings=parsed.warnings.slice();
  const invalidStart=startTime!==null&&validStart===null;
  if(invalidStart)warnings.push('invalid_legacy_start_time');
  if(explicitSkipped)return {status:'skipped',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:parsed.sides===null||warnings.length>0,warnings};
  if(explicitPaused){
    warnings.push('legacy_paused_without_pause_interval');
    return {status:'in_progress',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:true,warnings:Array.from(new Set(warnings))};
  }
  if(explicitInProgress)return {status:'in_progress',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:parsed.sides===null||warnings.length>0,warnings};
  if(validStart&&(explicitScheduled||!status)){
    warnings.push(explicitScheduled?'scheduled_match_has_start_time':'legacy_status_missing_with_start_time');
    return {status:'in_progress',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:true,warnings:Array.from(new Set(warnings))};
  }
  const startAfterCompletion=validStart!==null&&validTime!==null&&validStart.getTime()>validTime.getTime();
  if(hasCompletionEvidence&&validTime&&scoreValues&&!invalidStart&&!startAfterCompletion){
    return {status:'completed',startedAt:validStart,scores:scoreValues,winnerSide:scoreValues[0]===scoreValues[1]?null:scoreValues[0]>scoreValues[1]?1:2,
      completedAt:validTime,needsReview:false,warnings:[]};
  }
  if(!completedStatus&&!explicitScheduled)warnings.push('unknown_legacy_match_status');
  if(startAfterCompletion)warnings.push('match_start_after_completion');
  if(validStart){
    warnings.push('started_match_completion_unverifiable');
    return {status:'in_progress',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:true,
      warnings:Array.from(new Set(warnings))};
  }
  if(hasCompletionEvidence||endTime!==null||warnings.length>0)warnings.push('completed_match_result_unverifiable');
  return {status:'scheduled',startedAt:validStart,scores:[null,null],winnerSide:null,completedAt:null,needsReview:hasCompletionEvidence||endTime!==null||warnings.length>0,
    warnings:Array.from(new Set(warnings))};
}

function legacyPlayerId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function findOrCreateEnrollment(
  tx: Queryable,
  tournamentId: number,
  ownerId: string,
  playerId: number,
  nameSnapshot: string,
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO tournament_enrollments
       (id, tournament_id, owner_id, player_id, player_name_snapshot, metadata)
     VALUES ($1, $2, $3, $4, $5, '{"source":"legacy_match"}'::jsonb)
     ON CONFLICT (tournament_id, player_id) WHERE player_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [randomUUID(), tournamentId, ownerId, playerId, nameSnapshot],
  );
  if (inserted[0]) return inserted[0].id;
  const found = await tx.query<{ id: string }>(
    'SELECT id FROM tournament_enrollments WHERE tournament_id = $1 AND player_id = $2',
    [tournamentId, playerId],
  );
  if (!found[0]) throw new Error('Enrollment conflict could not be reconciled');
  return found[0].id;
}

function validLegacyOwner(userId: number | null, guestId: string | null): boolean {
  return userId !== null && guestId === null;
}

function guestNamespace(guestId: string | null): string {
  return guestId ? `legacy-guest:${digest(guestId).toString('hex')}` : 'legacy-unowned';
}

async function getOrCreateQuarantineOwner(tx: Queryable, namespace: string): Promise<string> {
  const ownerId = randomUUID();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO data_owners (id, status, legacy_namespace) VALUES ($1, 'quarantined', $2)
     ON CONFLICT (legacy_namespace) WHERE status = 'quarantined' DO NOTHING RETURNING id`, [ownerId, namespace],
  );
  if (inserted[0]) return inserted[0].id;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM data_owners WHERE status = 'quarantined' AND legacy_namespace = $1`, [namespace],
  );
  if (!existing[0]) throw new Error('Quarantine owner conflict could not be reconciled');
  return existing[0].id;
}

async function getOrCreateUserOwner(tx: Queryable, userId: number): Promise<string | null> {
  const found=await tx.query<{id:string}>(`SELECT id::text FROM data_owners WHERE user_id=$1 AND status='active'`,[userId]);
  if(found[0])return found[0].id;
  const user=await tx.query<{id:number}>('SELECT id FROM users WHERE id=$1',[userId]);
  if(!user[0])return null;
  const inserted=await tx.query<{id:string}>(
    `INSERT INTO data_owners (id,user_id,status) VALUES ($1,$2,'active')
     ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id::text`,
    [randomUUID(),userId],
  );
  return inserted[0]?.id??null;
}

export async function importLegacyPostgres(
  db: PostgresDatabase,
  apply: boolean,
  batchSize = DEFAULT_POSTGRES_IMPORT_BATCH_SIZE,
  rescan=false,
): Promise<LegacyImportSummary> {
  const label = 'legacy-postgres:public';
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>MAX_POSTGRES_IMPORT_BATCH_SIZE)throw new RangeError('PostgreSQL import batch size is outside the supported bound');
  const countRows = await db.query<{ entity: string; count: string }>(`
    SELECT 'users' AS entity, count(*)::text AS count FROM users
    UNION ALL SELECT 'players', count(*)::text FROM players
    UNION ALL SELECT 'tournaments', count(*)::text FROM tournaments
    UNION ALL SELECT 'matches', count(*)::text FROM matches
  `);
  const counts = Object.fromEntries(countRows.map(row => [row.entity, Number(row.count)]));
  const maxRows=await db.query<{users:number;players:number;tournaments:number;matches:number}>(
    `SELECT (SELECT coalesce(max(id),0) FROM users)::integer users,
      (SELECT coalesce(max(id),0) FROM players)::integer players,
      (SELECT coalesce(max(id),0) FROM tournaments)::integer tournaments,
      (SELECT coalesce(max(id),0) FROM matches)::integer matches`,
  );
  let highWater={users:Number(maxRows[0]?.users??0),players:Number(maxRows[0]?.players??0),
    tournaments:Number(maxRows[0]?.tournaments??0),matches:Number(maxRows[0]?.matches??0)};
  let scanCounts:Record<string,number>=counts;
  let sourceSignature=postgresSourceSignature(scanCounts,highWater);
  if (!apply) {
    const quarantineRows=await db.query<{quarantined:number}>(`
      SELECT
        (SELECT count(*) FROM players p WHERE p.user_id IS NULL OR p.guest_session_id IS NOT NULL) +
        (SELECT count(*) FROM tournaments t WHERE t.user_id IS NULL OR t.guest_session_id IS NOT NULL) +
        (SELECT count(*) FROM matches m LEFT JOIN tournaments t ON t.id=m.tournament_id
         WHERE t.id IS NULL OR m.user_id IS DISTINCT FROM t.user_id OR m.guest_session_id IS DISTINCT FROM t.guest_session_id
           OR t.user_id IS NULL OR t.guest_session_id IS NOT NULL) AS quarantined`);
    return {
      source: 'legacy_postgres', sourceLabel: label, dryRun: true, counts,
      highWater,
      quarantined: Number(quarantineRows[0]?.quarantined??0), needsReview: 0, noOp: false,
      warnings: ['dry_run_no_writes', 'legacy_guest_cookie_values_are_not_activated', 'source_rows_are_preserved',
        'postgres_apply_uses_checkpointed_batches'],
    };
  }

  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [7281946302]);
    const active=await tx.query<{id:string;content_hash:Buffer;counts:Record<string,unknown>}>(
      `SELECT id::text,content_hash,counts FROM import_batches
       WHERE source_type='legacy_postgres' AND source_identifier=$1 AND status='started'
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,[label],
    );
    let batchId:string;let checkpoint:{users:number;players:number;tournaments:number;matches:number};
    let cumulativeQuarantined=0;let cumulativeReview=0;let savedCounts:Record<string,unknown>;
    if(active[0]){
      if(rescan)throw new Error('Resume the active checkpoint without --rescan before starting a full source rescan.');
      batchId=active[0].id;savedCounts=active[0].counts;
      const savedCursor=objectValue(savedCounts.cursor);
      const savedHigh=objectValue(savedCounts.highWater);
      const savedSourceCounts=Object.fromEntries(Object.entries(objectValue(savedCounts.sourceCounts)).map(([key,value])=>[key,safeInteger(value)]));
      const savedHighWater={users:safeInteger(savedHigh.users),players:safeInteger(savedHigh.players),tournaments:safeInteger(savedHigh.tournaments),matches:safeInteger(savedHigh.matches)};
      const checkpointSignature=postgresSourceSignature(savedSourceCounts,savedHighWater);
      validatePostgresImportCheckpoint(active[0].content_hash,sourceSignature,checkpointSignature);
      scanCounts=savedSourceCounts;highWater=savedHighWater;sourceSignature=checkpointSignature;
      checkpoint={users:safeInteger(savedCursor.users),players:safeInteger(savedCursor.players),tournaments:safeInteger(savedCursor.tournaments),matches:safeInteger(savedCursor.matches)};
      cumulativeQuarantined=safeInteger(savedCounts.quarantined);cumulativeReview=safeInteger(savedCounts.needsReview);
    }else{
      const prior=await tx.query<{id:string;status:'completed'|'needs_review';content_hash:Buffer;counts:Record<string,unknown>}>(
        `SELECT id::text,status,content_hash,counts FROM import_batches
         WHERE source_type='legacy_postgres' AND source_identifier=$1 AND status IN ('completed','needs_review')
           AND content_hash=$2 ORDER BY started_at DESC LIMIT 1`,[label,sourceSignature],
      );
      if(prior[0]&&isIdenticalCompletedPostgresBatch(prior[0].status,prior[0].content_hash,sourceSignature,rescan)){
        const saved=objectValue(prior[0].counts);
        return {source:'legacy_postgres',sourceLabel:label,dryRun:false,batchId:prior[0].id,counts:scanCounts,
          checkpoint:objectValue(saved.cursor) as Record<string,number>,highWater,
          quarantined:safeInteger(saved.quarantined),needsReview:safeInteger(saved.needsReview),noOp:true,
          warnings:['identical_source_batch_noop',...(prior[0].status==='needs_review'?['review_required']:[])]};
      }
      batchId=await beginBatch(tx,'legacy_postgres',label,sourceSignature);
      checkpoint={users:0,players:0,tournaments:0,matches:0};
      savedCounts={highWater,sourceCounts:counts,cursor:checkpoint,quarantined:0,needsReview:0};
      await tx.execute('UPDATE import_batches SET counts=$2::jsonb WHERE id=$1',[batchId,JSON.stringify(savedCounts)]);
    }
    const selectPage=async <T extends QueryResultRow>(sql:string,cursor:number,maximum:number):Promise<T[]>=>
      tx.query<T>(sql,[cursor,maximum,batchSize]);
    const [users,players,tournaments]=await Promise.all([
      selectPage<LegacyUser>('SELECT id,username FROM users WHERE id>$1 AND id<=$2 ORDER BY id LIMIT $3',checkpoint.users,highWater.users),
      selectPage<LegacyPlayer>(`SELECT id,user_id,guest_session_id,name,games_played,wins,losses,draws,points_for,points_against
        FROM players WHERE id>$1 AND id<=$2 ORDER BY id LIMIT $3`,checkpoint.players,highWater.players),
      selectPage<LegacyTournament>('SELECT id,user_id,guest_session_id FROM tournaments WHERE id>$1 AND id<=$2 ORDER BY id LIMIT $3',checkpoint.tournaments,highWater.tournaments),
    ]);
    const pageCursor=(current:number,rows:Array<{id:number}>,high:number)=>rows.length?rows[rows.length-1]!.id:high;
    const nextCheckpoint={
      users:pageCursor(checkpoint.users,users,highWater.users),
      players:pageCursor(checkpoint.players,players,highWater.players),
      tournaments:pageCursor(checkpoint.tournaments,tournaments,highWater.tournaments),
      matches:checkpoint.matches,
    };
    const dependenciesComplete=nextCheckpoint.users>=highWater.users&&nextCheckpoint.players>=highWater.players&&nextCheckpoint.tournaments>=highWater.tournaments;
    const matches=dependenciesComplete?await selectPage<LegacyMatch>(
      'SELECT id,tournament_id,user_id,guest_session_id,status,teams,start_time,end_time FROM matches WHERE id>$1 AND id<=$2 ORDER BY id LIMIT $3',
      checkpoint.matches,highWater.matches,
    ):[];
    if(dependenciesComplete)nextCheckpoint.matches=pageCursor(checkpoint.matches,matches,highWater.matches);
    const complete=nextCheckpoint.users>=highWater.users&&nextCheckpoint.players>=highWater.players
      &&nextCheckpoint.tournaments>=highWater.tournaments&&nextCheckpoint.matches>=highWater.matches;
    const ownerByUser = new Map<number, string>();
    const keyCounts = new Map<string, number>();
    for (const user of users) {
      const key = canonicalizeName(user.username);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      const ownerId=await getOrCreateUserOwner(tx,user.id);
      if(!ownerId)throw new Error('Could not establish an account owner');
      ownerByUser.set(user.id,ownerId);
    }

    let quarantined = 0;
    let needsReview = 0;
    for (const user of users) {
      const rowHash = hashRecord(user);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'users', String(user.id), rowHash);
      const usernameKey = canonicalizeName(user.username);
      const existingKey=await tx.query<{id:number}>(`SELECT id FROM users WHERE username_key=$1 AND id<>$2 LIMIT 1`,[usernameKey,user.id]);
      const collision = keyCounts.get(usernameKey) !== 1 || existingKey.length>0 || !usernameKey;
      if (!collision && !sourceState.changed && !sourceState.unresolved) {
        await tx.execute(
          'UPDATE users SET username_key = $1, username_key_version = $2 WHERE id = $3 AND username_key IS NULL',
          [usernameKey, NAME_CANONICALIZATION_VERSION, user.id],
        );
      }
      if (collision || sourceState.changed || sourceState.unresolved) {
        needsReview += 1;
      }
      await appendImportRecord(
        tx, batchId, 'legacy-postgres', 'users', String(user.id), rowHash,
        collision || sourceState.changed || sourceState.unresolved ? 'needs_review' : 'imported',
        [
          ...(collision ? ['username_normalization_collision'] : []),
          ...(sourceState.changed ? ['source_record_changed_review_required'] : []),
          ...(!sourceState.changed && sourceState.unresolved ? ['prior_review_unresolved'] : []),
        ],
        'data_owners', ownerByUser.get(user.id) || null,
      );
    }

    const assignedPlayers:Array<{row:LegacyPlayer;ownerId:string|null}> = [];
    for(const row of players){
      const ownerId=validLegacyOwner(row.user_id,row.guest_session_id)
        ? ownerByUser.get(row.user_id as number)??await getOrCreateUserOwner(tx,row.user_id as number)
        : null;
      assignedPlayers.push({row,ownerId});
    }
    for (const item of assignedPlayers) {
      if (!item.ownerId) {
        item.ownerId = await getOrCreateQuarantineOwner(tx, guestNamespace(item.row.guest_session_id));
        quarantined += 1;
      }
    }
    const namesByOwner = new Map<string, Map<string, number>>();
    for (const item of assignedPlayers) {
      const nameKey = canonicalizeName(item.row.name || '');
      if (!item.ownerId) continue;
      const keys = namesByOwner.get(item.ownerId) || new Map<string, number>();
      keys.set(nameKey, (keys.get(nameKey) || 0) + 1);
      namesByOwner.set(item.ownerId, keys);
    }
    for (const item of assignedPlayers) {
      if (!item.ownerId) continue;
      const rowHash = hashRecord(item.row);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'players', String(item.row.id), rowHash);
      const nameKey = canonicalizeName(item.row.name || '');
      const existingName=await tx.query<{id:number}>(
        `SELECT id FROM players WHERE owner_id=$1 AND name_key=$2 AND id<>$3 AND deleted_at IS NULL LIMIT 1`,
        [item.ownerId,nameKey,item.row.id],
      );
      const collision = !nameKey || (namesByOwner.get(item.ownerId)?.get(nameKey) ?? 0) > 1 || existingName.length>0;
      const invalidStats = [item.row.games_played, item.row.wins, item.row.losses, item.row.draws,
        item.row.points_for, item.row.points_against].some(value => value !== null && value !== undefined && value < 0);
      if (collision || invalidStats || sourceState.changed || sourceState.unresolved) needsReview += 1;
      if (!invalidStats && !sourceState.changed && !sourceState.unresolved) {
        await tx.execute(
          `UPDATE players SET owner_id = $1, name_key = $2, name_key_version = $3,
             import_batch_id = $4, updated_at = now()
           WHERE id = $5 AND owner_id IS NULL`,
          [item.ownerId, collision ? null : nameKey, collision ? null : NAME_CANONICALIZATION_VERSION, batchId, item.row.id],
        );
      }
      const activeOwner = validLegacyOwner(item.row.user_id, item.row.guest_session_id)
        && item.ownerId !== null;
      const status = collision || invalidStats || sourceState.changed || sourceState.unresolved
        ? 'needs_review' : activeOwner ? 'imported' : 'quarantined';
      await appendImportRecord(tx, batchId, 'legacy-postgres', 'players', String(item.row.id), rowHash, status,
        [
          ...(collision ? ['player_name_normalization_collision'] : []),
          ...(invalidStats ? ['negative_player_stat'] : []),
          ...(sourceState.changed ? ['source_record_changed_review_required'] : []),
          ...(!sourceState.changed && sourceState.unresolved ? ['prior_review_unresolved'] : []),
          ...(!validLegacyOwner(item.row.user_id, item.row.guest_session_id) ? ['legacy_owner_quarantined'] : []),
        ],
        'players', String(item.row.id));
    }

    for (const row of tournaments) {
      const rowHash = hashRecord(row);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'tournaments', String(row.id), rowHash);
      const userOwnerId=validLegacyOwner(row.user_id,row.guest_session_id)
        ? ownerByUser.get(row.user_id as number) ?? await getOrCreateUserOwner(tx,row.user_id as number)
        : null;
      let ownerId=userOwnerId;
      if (!ownerId) {
        ownerId = await getOrCreateQuarantineOwner(tx, guestNamespace(row.guest_session_id));
        quarantined += 1;
      }
      if (!sourceState.changed && !sourceState.unresolved) {
        await tx.execute('UPDATE tournaments SET owner_id = $1, import_batch_id = $2 WHERE id = $3 AND owner_id IS NULL', [ownerId, batchId, row.id]);
      }
      const validOwner = validLegacyOwner(row.user_id,row.guest_session_id)&&userOwnerId!==null;
      const review = sourceState.changed || sourceState.unresolved;
      if (review) needsReview += 1;
      await appendImportRecord(tx, batchId, 'legacy-postgres', 'tournaments', String(row.id), rowHash,
        review ? 'needs_review' : validOwner ? 'imported' : 'quarantined',
        [
          ...(!validOwner ? ['legacy_owner_quarantined'] : []),
          ...(sourceState.changed ? ['source_record_changed_review_required'] : []),
          ...(!sourceState.changed && sourceState.unresolved ? ['prior_review_unresolved'] : []),
        ],
        'tournaments', String(row.id));
    }

    for (const row of matches) {
      const rowHash = hashRecord(row);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'matches', String(row.id), rowHash);
      const parsed = parseLegacySides(row.teams);
      const normalized = normalizeLegacyMatchResult(row.status,row.start_time,row.end_time,parsed);
      const tournamentRows=row.tournament_id===null?[]:await tx.query<LegacyTournament & {owner_id:string|null}>(
        `SELECT id,user_id,guest_session_id,owner_id::text FROM tournaments WHERE id=$1`,[row.tournament_id],
      );
      const sourceTournament=tournamentRows[0];
      let ownerId=sourceTournament?.owner_id??null;
      if(sourceTournament&&!ownerId){
        ownerId=validLegacyOwner(sourceTournament.user_id,sourceTournament.guest_session_id)
          ? await getOrCreateUserOwner(tx,sourceTournament.user_id as number)
          : await getOrCreateQuarantineOwner(tx,guestNamespace(sourceTournament.guest_session_id));
        if(ownerId)await tx.execute('UPDATE tournaments SET owner_id=$1 WHERE id=$2 AND owner_id IS NULL',[ownerId,sourceTournament.id]);
      }
      const canInherit = ownerId !== null && sourceTournament !== undefined
        && row.user_id === sourceTournament.user_id
        && row.guest_session_id === sourceTournament.guest_session_id;
      if (canInherit && ownerId && !sourceState.changed && !sourceState.unresolved) {
        await tx.execute(
          `UPDATE matches SET owner_id=coalesce(owner_id,$1),import_batch_id=coalesce(import_batch_id,$2),
             normalized_status=$3,winner_side=$4,completed_at=$5,normalized_started_at=$6
           WHERE id=$7 AND (owner_id IS NULL OR owner_id=$1)`,
          [ownerId,batchId,normalized.status,normalized.winnerSide,normalized.completedAt,normalized.startedAt,row.id],
        );
      }
      if (!canInherit || sourceState.changed || sourceState.unresolved) {
        needsReview += 1;
      }
      const warnings: string[] = [
        ...(!canInherit ? ['match_owner_does_not_match_tournament'] : []),
        ...(sourceState.changed ? ['source_record_changed_review_required'] : []),
        ...(!sourceState.changed && sourceState.unresolved ? ['prior_review_unresolved'] : []),
        ...normalized.warnings,
      ];
      if(normalized.needsReview)needsReview+=1;
      if (parsed.sides && canInherit && ownerId && !sourceState.changed && !sourceState.unresolved && row.tournament_id !== null) {
        for (let sideIndex = 0; sideIndex < parsed.sides.length; sideIndex += 1) {
          const side = parsed.sides[sideIndex]!;
          // Legacy score fields commonly contain 0 before play. Only a
          // validated completed result may retain either side's score.
          const score = normalized.status==='completed' ? normalized.scores[sideIndex]! : null;
          await tx.execute(
            `INSERT INTO match_sides (match_id, tournament_id, owner_id, side_no, score)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (match_id, side_no) DO UPDATE SET score=EXCLUDED.score`,
            [row.id, row.tournament_id, ownerId, sideIndex + 1, score],
          );
          for (let position = 0; position < side.participants.length; position += 1) {
            const participant = side.participants[position]!;
            const playerId = legacyPlayerId(participant.id);
            const playerRows=playerId===null?[]:await tx.query<{owner_id:string|null}>(
              `SELECT owner_id::text FROM players WHERE id=$1`,[playerId],
            );
            const linkedPlayerId = playerId !== null && playerRows[0]?.owner_id===ownerId ? playerId : null;
            if (playerId !== null && linkedPlayerId === null) warnings.push('participant_reference_unverified');
            const enrollmentId = linkedPlayerId === null ? null : await findOrCreateEnrollment(
              tx, row.tournament_id, ownerId, linkedPlayerId, participant.name as string,
            );
            await tx.execute(
              `INSERT INTO match_players
                (match_id, side_no, tournament_id, owner_id, position, player_id, enrollment_id, player_name_snapshot)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (match_id, side_no, position) DO NOTHING`,
              [row.id, sideIndex + 1, row.tournament_id, ownerId, position + 1, linkedPlayerId, enrollmentId, participant.name],
            );
          }
        }
        if(warnings.includes('participant_reference_unverified'))needsReview+=1;
      }
      const ownerStatus=ownerId?await tx.query<{status:string}>('SELECT status FROM data_owners WHERE id=$1',[ownerId]):[];
      const tournamentIsAccountOwned=ownerStatus[0]?.status==='active'&&sourceTournament!==undefined
        &&validLegacyOwner(sourceTournament.user_id,sourceTournament.guest_session_id);
      if(!tournamentIsAccountOwned)quarantined+=1;
      await appendImportRecord(tx, batchId, 'legacy-postgres', 'matches', String(row.id), rowHash,
        warnings.length > 0 ? 'needs_review' : tournamentIsAccountOwned ? 'imported' : 'quarantined',
        warnings, 'matches', String(row.id));
    }

    const totalQuarantined=cumulativeQuarantined+quarantined;
    const totalReview=cumulativeReview+needsReview;
    const progressCounts={sourceCounts:scanCounts,highWater,cursor:nextCheckpoint,quarantined:totalQuarantined,needsReview:totalReview};
    const nextStatus=complete?(totalReview?'needs_review':'completed'):'started';
    await tx.execute(
      `UPDATE import_batches SET status=$2,completed_at=CASE WHEN $3 THEN now() ELSE NULL END,
       counts=$4::jsonb,error_summary=$5 WHERE id=$1`,
      [batchId,nextStatus,complete,JSON.stringify(progressCounts),complete&&totalReview?'review_required':null],
    );
    return {
      source: 'legacy_postgres', sourceLabel: label, dryRun: false, batchId,
      counts:scanCounts,checkpoint:nextCheckpoint,highWater,quarantined:totalQuarantined,needsReview:totalReview,noOp:false,
      warnings: ['legacy_guest_cookie_values_are_not_activated', 'legacy_json_snapshots_are_preserved',
        ...(complete?[]:['checkpointed_batch_incomplete; rerun --apply to resume']),...(complete&&totalReview?['review_required']:[])],
    };
  });
}

export async function reconcileLegacyData(db: PostgresDatabase): Promise<Record<string, number>> {
  const rows = await db.query<{ key: string; value: string }>(`
    SELECT 'players_without_owner' AS key, count(*)::text AS value FROM players WHERE owner_id IS NULL
    UNION ALL SELECT 'tournaments_without_owner', count(*)::text FROM tournaments WHERE owner_id IS NULL
    UNION ALL SELECT 'matches_without_owner', count(*)::text FROM matches WHERE owner_id IS NULL
    UNION ALL SELECT 'players_without_name_key', count(*)::text FROM players WHERE owner_id IS NOT NULL AND name_key IS NULL
    UNION ALL SELECT 'normalized_matches_without_sides', count(*)::text FROM matches m WHERE m.owner_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM match_sides s WHERE s.match_id = m.id)
    UNION ALL SELECT 'completed_matches_missing_two_sides', count(*)::text FROM matches m
      WHERE m.normalized_status = 'completed' AND (SELECT count(*) FROM match_sides s WHERE s.match_id = m.id) <> 2
    UNION ALL SELECT 'idempotency_requests_in_progress', count(*)::text FROM idempotency_requests WHERE status = 'in_progress'
    UNION ALL SELECT 'active_owners', count(*)::text FROM data_owners WHERE status = 'active'
    UNION ALL SELECT 'quarantined_owners', count(*)::text FROM data_owners WHERE status = 'quarantined'
    UNION ALL SELECT 'import_batches_needing_review', count(*)::text FROM import_batches WHERE status = 'needs_review'
    UNION ALL SELECT 'import_records_quarantined', count(*)::text FROM import_records WHERE status = 'quarantined'
  `);
  return Object.fromEntries(rows.map(row => [row.key, Number(row.value)]));
}
