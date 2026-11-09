import { createHash, randomUUID } from 'crypto';
import { basename, resolve } from 'path';
import { PostgresDatabase, Queryable } from './database';
import { QueryResultRow } from 'pg';
import { canonicalizeName, NAME_CANONICALIZATION_VERSION } from './names';

export type LegacyEntity = 'users' | 'players' | 'tournaments' | 'matches';

export interface LegacyImportSummary {
  source: 'legacy_postgres' | 'local_json';
  sourceLabel: string;
  dryRun: boolean;
  batchId?: string;
  counts: Record<string, number>;
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

function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

function hashRecord(row: unknown): Buffer {
  return digest(JSON.stringify(row));
}

function asStableId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
  return null;
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
     VALUES ($1, $2, $3, $4, $5, 2, 'started')`,
    [id, sourceType, sourceIdentifier, contentHash, `persistence-import/1;names=${NAME_CANONICALIZATION_VERSION}`],
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
  if (!apply) {
    return {
      source: 'local_json', sourceLabel: label, dryRun: true, counts,
      quarantined: Object.values(counts).reduce((sum, count) => sum + count, 0),
      needsReview: malformed, noOp: false,
      warnings: ['unclaimed_local_data_is_quarantined', ...(malformed ? ['malformed_records_skipped'] : [])],
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
    const recordCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
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
  start_time: Date | string | null;
  end_time: Date | string | null;
}

interface LegacySide {
  participants: Array<{ id?: unknown; name?: unknown }>;
  score?: unknown;
}

function parseLegacySides(value: unknown): { sides: LegacySide[] | null; warning?: string } {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return { sides: null, warning: 'invalid_match_json' }; }
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return { sides: null, warning: 'match_must_have_two_sides' };
  const sides: LegacySide[] = [];
  for (const rawSide of parsed) {
    if (!rawSide || typeof rawSide !== 'object' || !Array.isArray((rawSide as { participants?: unknown }).participants)) {
      return { sides: null, warning: 'invalid_side_shape' };
    }
    const participants = (rawSide as { participants: unknown[] }).participants;
    if (participants.length < 1 || participants.length > 2) return { sides: null, warning: 'invalid_side_participant_count' };
    const normalized = [] as LegacySide['participants'];
    for (const participant of participants) {
      if (!participant || typeof participant !== 'object') return { sides: null, warning: 'invalid_match_participant' };
      const item = participant as { id?: unknown; name?: unknown };
      if (typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.length > 255) {
        return { sides: null, warning: 'invalid_match_name_snapshot' };
      }
      normalized.push({ id: item.id, name: item.name });
    }
    const score = (rawSide as { score?: unknown }).score;
    if (score !== undefined && score !== null && (!Number.isSafeInteger(score) || Number(score) < 0)) {
      return { sides: null, warning: 'invalid_match_score' };
    }
    sides.push({ participants: normalized, score });
  }
  return { sides };
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

export async function importLegacyPostgres(db: PostgresDatabase, apply: boolean): Promise<LegacyImportSummary> {
  const label = 'legacy-postgres:public';
  const [users, players, tournaments, matches] = await Promise.all([
    db.query<LegacyUser>('SELECT id, username FROM users ORDER BY id'),
    db.query<LegacyPlayer>(`SELECT id, user_id, guest_session_id, name, games_played, wins, losses, draws,
      points_for, points_against FROM players ORDER BY id`),
    db.query<LegacyTournament>('SELECT id, user_id, guest_session_id FROM tournaments ORDER BY id'),
    db.query<LegacyMatch>('SELECT id, tournament_id, user_id, guest_session_id, teams, start_time, end_time FROM matches ORDER BY id'),
  ]);
  const counts = { users: users.length, players: players.length, tournaments: tournaments.length, matches: matches.length };
  const batchHash = digest(JSON.stringify({
    users: users.map(row => hashRecord(row).toString('hex')),
    players: players.map(row => hashRecord(row).toString('hex')),
    tournaments: tournaments.map(row => hashRecord(row).toString('hex')),
    matches: matches.map(row => hashRecord(row).toString('hex')),
  }));
  if (!apply) {
    const tournamentById = new Map(tournaments.map(row => [row.id, row]));
    const quarantineCount = players.filter(row => !validLegacyOwner(row.user_id, row.guest_session_id)).length
      + tournaments.filter(row => !validLegacyOwner(row.user_id, row.guest_session_id)).length
      + matches.filter(row => {
        const tournament = row.tournament_id === null ? undefined : tournamentById.get(row.tournament_id);
        return !tournament || row.user_id !== tournament.user_id || row.guest_session_id !== tournament.guest_session_id
          || !validLegacyOwner(tournament.user_id, tournament.guest_session_id);
      }).length;
    return {
      source: 'legacy_postgres', sourceLabel: label, dryRun: true, counts,
      quarantined: quarantineCount, needsReview: 0, noOp: false,
      warnings: ['legacy_guest_cookie_values_are_not_activated', 'source_rows_are_preserved'],
    };
  }

  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [7281946302]);
    const prior = await findPriorBatch(tx, 'legacy_postgres', label, batchHash);
    if (prior) {
      const priorCounts = prior.counts;
      return {
        source: 'legacy_postgres', sourceLabel: label, dryRun: false, batchId: prior.id,
        counts, quarantined: Number(priorCounts.quarantined || 0), needsReview: Number(priorCounts.needsReview || 0),
        noOp: true, warnings: ['identical_source_already_recorded', ...(prior.status === 'needs_review' ? ['review_required'] : [])],
      };
    }
    const batchId = await beginBatch(tx, 'legacy_postgres', label, batchHash);
    const ownerByUser = new Map<number, string>();
    const keyCounts = new Map<string, number>();
    for (const user of users) {
      const key = canonicalizeName(user.username);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      const ownerRows = await tx.query<{ id: string }>(
        `INSERT INTO data_owners (id, user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING id`, [randomUUID(), user.id],
      );
      const owner = ownerRows[0];
      if (!owner) throw new Error('Could not establish an account owner');
      ownerByUser.set(user.id, owner.id);
    }

    let quarantined = 0;
    let needsReview = 0;
    for (const user of users) {
      const rowHash = hashRecord(user);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'users', String(user.id), rowHash);
      const usernameKey = canonicalizeName(user.username);
      const collision = keyCounts.get(usernameKey) !== 1 || !usernameKey;
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

    const playerOwner = new Map<number, string>();
    const assignedPlayers = players.map(row => ({ row, ownerId: validLegacyOwner(row.user_id, row.guest_session_id)
      ? ownerByUser.get(row.user_id as number) || null
      : null }));
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
      const collision = !nameKey || (namesByOwner.get(item.ownerId)?.get(nameKey) ?? 0) > 1;
      const invalidStats = [item.row.games_played, item.row.wins, item.row.losses, item.row.draws,
        item.row.points_for, item.row.points_against].some(value => value !== null && value !== undefined && value < 0);
      if (collision || invalidStats || sourceState.changed || sourceState.unresolved) needsReview += 1;
      if (!invalidStats && !sourceState.changed && !sourceState.unresolved) {
        playerOwner.set(item.row.id, item.ownerId);
        await tx.execute(
          `UPDATE players SET owner_id = $1, name_key = $2, name_key_version = $3,
             import_batch_id = $4, updated_at = now()
           WHERE id = $5 AND owner_id IS NULL`,
          [item.ownerId, collision ? null : nameKey, collision ? null : NAME_CANONICALIZATION_VERSION, batchId, item.row.id],
        );
      }
      const activeOwner = validLegacyOwner(item.row.user_id, item.row.guest_session_id)
        && ownerByUser.has(item.row.user_id as number);
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

    const tournamentOwner = new Map<number, string>();
    for (const row of tournaments) {
      const rowHash = hashRecord(row);
      const sourceState = await sourceRecordState(tx, 'legacy-postgres', 'tournaments', String(row.id), rowHash);
      let ownerId = validLegacyOwner(row.user_id, row.guest_session_id) ? ownerByUser.get(row.user_id as number) || null : null;
      if (!ownerId) {
        ownerId = await getOrCreateQuarantineOwner(tx, guestNamespace(row.guest_session_id));
        quarantined += 1;
      }
      tournamentOwner.set(row.id, ownerId);
      if (!sourceState.changed && !sourceState.unresolved) {
        await tx.execute('UPDATE tournaments SET owner_id = $1, import_batch_id = $2 WHERE id = $3 AND owner_id IS NULL', [ownerId, batchId, row.id]);
      }
      const validOwner = row.user_id !== null && ownerByUser.has(row.user_id) && row.guest_session_id === null;
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
      const ownerId = row.tournament_id === null ? null : tournamentOwner.get(row.tournament_id) || null;
      const sourceTournament = tournaments.find(tournament => tournament.id === row.tournament_id);
      const canInherit = ownerId !== null && sourceTournament !== undefined
        && row.user_id === sourceTournament.user_id
        && row.guest_session_id === sourceTournament.guest_session_id;
      if (canInherit && ownerId && !sourceState.changed && !sourceState.unresolved) {
        await tx.execute('UPDATE matches SET owner_id = $1, import_batch_id = $2 WHERE id = $3 AND owner_id IS NULL', [ownerId, batchId, row.id]);
      }
      if (!canInherit || sourceState.changed || sourceState.unresolved) {
        needsReview += 1;
      }
      const warnings: string[] = [
        ...(!canInherit ? ['match_owner_does_not_match_tournament'] : []),
        ...(sourceState.changed ? ['source_record_changed_review_required'] : []),
        ...(!sourceState.changed && sourceState.unresolved ? ['prior_review_unresolved'] : []),
      ];
      const parsed = parseLegacySides(row.teams);
      if (!parsed.sides) {
        warnings.push(parsed.warning || 'invalid_match_shape');
        needsReview += 1;
      } else if (canInherit && ownerId && !sourceState.changed && !sourceState.unresolved && row.tournament_id !== null) {
        const scores = parsed.sides.map(side => side.score);
        const completedAt = row.end_time
          ? (row.end_time instanceof Date ? row.end_time : new Date(row.end_time))
          : null;
        const winnerSide = typeof scores[0] === 'number' && typeof scores[1] === 'number' && scores[0] !== scores[1]
          ? (scores[0] > scores[1] ? 1 : 2) : null;
        for (let sideIndex = 0; sideIndex < parsed.sides.length; sideIndex += 1) {
          const side = parsed.sides[sideIndex]!;
          const score = typeof side.score === 'number' ? side.score : null;
          await tx.execute(
            `INSERT INTO match_sides (match_id, tournament_id, owner_id, side_no, score)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (match_id, side_no) DO NOTHING`,
            [row.id, row.tournament_id, ownerId, sideIndex + 1, score],
          );
          for (let position = 0; position < side.participants.length; position += 1) {
            const participant = side.participants[position]!;
            const playerId = legacyPlayerId(participant.id);
            const linkedPlayerId = playerId !== null && playerOwner.get(playerId) === ownerId ? playerId : null;
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
        await tx.execute(
          `UPDATE matches SET winner_side = $1, completed_at = COALESCE(completed_at, $2)
           WHERE id = $3 AND owner_id = $4`,
          [winnerSide, completedAt, row.id, ownerId],
        );
        if (warnings.includes('participant_reference_unverified')) needsReview += 1;
      }
      const tournamentIsAccountOwned = sourceTournament !== undefined
        && validLegacyOwner(sourceTournament.user_id, sourceTournament.guest_session_id)
        && ownerByUser.has(sourceTournament.user_id as number);
      await appendImportRecord(tx, batchId, 'legacy-postgres', 'matches', String(row.id), rowHash,
        warnings.length > 0 ? 'needs_review' : tournamentIsAccountOwned ? 'imported' : 'quarantined',
        warnings, 'matches', String(row.id));
    }

    await tx.execute(
      `UPDATE import_batches SET status = $2, completed_at = now(),
       counts = $3::jsonb, error_summary = $4 WHERE id = $1`,
      [batchId, needsReview ? 'needs_review' : 'completed', JSON.stringify({ ...counts, quarantined, needsReview }),
        needsReview ? 'review_required' : null],
    );
    return {
      source: 'legacy_postgres', sourceLabel: label, dryRun: false, batchId,
      counts, quarantined, needsReview, noOp: false,
      warnings: ['legacy_guest_cookie_values_are_not_activated', 'legacy_json_snapshots_are_preserved'],
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
