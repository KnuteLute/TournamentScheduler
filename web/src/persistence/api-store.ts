import { createHash, randomUUID } from 'crypto';
import {
  StoreConflictError,
  StoreNotFoundError,
  StorePreconditionFailedError,
  StoreValidationError,
  StoreUnavailableError,
} from '../services/ports';
import type {
  ApiStore,
  AccountCredential,
  RateLimitDecision,
  RateLimitRequest,
  SessionRecord,
  StoreOperation,
  StoreRequest,
  StoreResult,
  VerifiedActor,
} from '../services/ports';
import {
  cancelTournament,
  completeMatch,
  computeOverallStandings,
  computeTournamentStandings,
  correctMatchScore,
  DomainMatch,
  DomainValidationError,
  finishTournament,
  FixedTeam,
  GENERATOR_VERSION,
  generateNextRotatingMatch,
  generateSchedule,
  MatchPauseInterval,
  MatchSide,
  Participant,
  StandingRow,
  pauseMatch,
  pauseTournament,
  recalculateTournamentStandings,
  resumeMatch,
  resumeTournament,
  skipMatch,
  startMatch,
  startTournament,
  TournamentMode,
  TournamentState,
  TournamentStatus,
  updatePlayerAvailability,
  validateTournamentInput,
} from '../domain';
import { canonicalizeName, NAME_CANONICALIZATION_VERSION } from '../domain/names';
import { PersistenceConflictError, PersistenceUnavailableError, PostgresDatabase, postgresPoolConfig, Queryable } from './database';
import { consumeRateLimitBucket, RateLimitConsumeInput } from './rate-limit';

interface AccountRow {
  id: number;
  username: string;
  username_key: string | null;
  password_hash: string;
  disabled_at: Date | null;
  owner_id: string;
}

interface SessionRow {
  id: string;
  owner_id: string;
  kind: 'guest' | 'authenticated';
  user_id: number | null;
  username: string | null;
  csrf_token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  pending_guest_claim: boolean;
  version: number;
}

interface TournamentRow {
  id: number;
  public_id: string;
  owner_id: string;
  name: string;
  mode: TournamentMode;
  status: TournamentStatus;
  version: number;
  seed: string;
  generator_version: string;
  paused_player_ids: string[];
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  paused_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

interface PlayerRow {
  id: number;
  owner_id: string;
  name: string;
  name_key: string | null;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
  points_against: number;
  diff: number;
  created_at: Date;
  updated_at: Date;
  version: number;
  deleted_at: Date | null;
}

interface TeamRow {
  id: string;
  owner_id: string;
  name: string;
  name_key: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  deleted_at: Date | null;
}

interface MatchRow {
  id: number;
  public_id: string;
  external_id: string;
  tournament_id: number;
  round: number | null;
  sequence_no: number;
  normalized_status: DomainMatch['status'];
  winner_side: 1 | 2 | null;
  version: number;
  start_time: Date | null;
  end_time: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

interface SideRow {
  match_id: number;
  side_no: 1 | 2;
  side_id: string | null;
  score: number | null;
  fixed_team_id: string | null;
  fixed_team_name_snapshot: string | null;
}

interface PlayerSnapshotRow {
  match_id: number;
  side_no: 1 | 2;
  position: number;
  player_id: number | null;
  player_name_snapshot: string;
}

interface StoredResult {
  status?: number;
  value: unknown;
  etag?: string;
}

interface LoadedTournament {
  row: TournamentRow;
  state: TournamentState;
  fixedTeams: FixedTeam[];
  fixedEntries: Array<{ id: string; teamId: string; name: string; playerIds: [string, string] }>;
  scheduleEvents: Array<{ round: number; eventType: 'bye' | 'rest'; subjectType: 'player' | 'fixed_team'; subjectId: string; name: string }>;
}

const MUTATIONS = new Set<StoreOperation>([
  'session.revoke', 'session.claimGuest', 'auth.register', 'auth.login', 'auth.logout',
  'players.create', 'players.update', 'players.delete', 'teams.create', 'teams.update', 'teams.delete',
  'tournaments.create', 'tournaments.updateDraft', 'tournaments.deleteDraft', 'tournaments.start',
  'tournaments.cancel', 'tournaments.pause', 'tournaments.resume', 'tournaments.finish',
  'tournaments.updateAvailability', 'matches.start', 'matches.pause', 'matches.resume',
  'matches.recordResult', 'matches.skip',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function dateText(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quoteEtag(version: number): string {
  return `v${version}`;
}

function assertEtag(expected: string | undefined, currentVersion: number): void {
  if (!expected || !/^"v[1-9]\d*"$/.test(expected)) throw new StorePreconditionFailedError();
  const actual = expected.slice(1,-1);
  if (actual !== quoteEtag(currentVersion)) throw new StorePreconditionFailedError();
}

function cursorEncode(id: number | string): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

function cursorDecode(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    return value.length > 0 && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

function ensureIds(value: unknown,min=0,max=32): string[] {
  if (!Array.isArray(value) || value.length<min || value.length>max || value.some(id => typeof id !== 'string') || new Set(value).size!==value.length) {
    throw new StoreValidationError([{ pointer: '', code: 'invalid-input', message: 'A required ID list is invalid.' }]);
  }
  return value as string[];
}

function mapValidation(error: DomainValidationError): StoreValidationError {
  return new StoreValidationError(error.issues.map(issue => ({
    pointer: issue.path,
    code: issue.code,
    message: issue.message,
  })));
}

function mapError(error: unknown): never {
  if (error instanceof StoreNotFoundError || error instanceof StoreConflictError
    || error instanceof StorePreconditionFailedError || error instanceof StoreValidationError
    || error instanceof StoreUnavailableError) throw error;
  if (error instanceof DomainValidationError) throw mapValidation(error);
  if (error instanceof PersistenceConflictError) throw new StoreConflictError();
  if (error instanceof PersistenceUnavailableError) throw new StoreUnavailableError();
  if (error instanceof Error && /Cannot |must be|cannot |must contain|must have|must precede|must not|only one|earlier scheduled/i.test(error.message)) {
    throw new StoreConflictError();
  }
  throw error;
}

function idempotencyDigest(hash: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new StoreValidationError([{ pointer: '', code: 'idempotency-hash', message: 'Invalid idempotency request hash.' }]);
  return Buffer.from(hash, 'hex');
}

function uuidBytes(hash: Uint8Array): Buffer {
  const result = Buffer.from(hash);
  if (result.length !== 32) throw new StoreValidationError([{ pointer: '', code: 'credential-hash', message: 'Credential hash must be 32 bytes.' }]);
  return result;
}

function normalizedName(name: string,max=80): { display: string; key: string } {
  const display = name.normalize('NFKC').trim().replace(/\p{White_Space}+/gu, ' ');
  const key = canonicalizeName(display);
  if (!display || !key || display.length > max) {
    throw new StoreValidationError([{ pointer: '/name', code: 'invalid-name', message: 'Name must be non-empty and bounded.' }]);
  }
  return { display, key };
}

export function serializePlayerResponse(row: Pick<PlayerRow,'id'|'name'|'created_at'|'updated_at'>): Record<string,unknown>{
  return {id:String(row.id),name:row.name,createdAt:dateText(row.created_at),updatedAt:dateText(row.updated_at)};
}

export function serializeTeamResponse(
  row: Pick<TeamRow,'id'|'name'|'created_at'|'updated_at'>,
  players: ReadonlyArray<{id:number;name:string}>,
): Record<string,unknown>{
  return {id:row.id,name:row.name,players:players.map(player=>({id:String(player.id),name:player.name})),
    createdAt:dateText(row.created_at),updatedAt:dateText(row.updated_at)};
}

/** Remove the internal stable key used for domain grouping/ranking. */
export function serializeStandingRows(rows:readonly StandingRow[]):Array<Omit<StandingRow,'key'>>{
  return rows.map(({key:_key,...row})=>row);
}

function operationScope(request: StoreRequest): string {
  return `${request.operation}:${request.resourceId ?? ''}:${request.matchId ?? ''}`;
}

/** PostgreSQL implementation of the backend-owned ApiStore port. */
export class PostgresApiStore implements ApiStore {
  constructor(private readonly database: PostgresDatabase) {}

  async lookupSessionByTokenHash(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null> {
    const hash = uuidBytes(tokenHash);
    const rows = await this.database.query<SessionRow>(
      `SELECT s.id::text, o.id::text AS owner_id, 'authenticated' AS kind, u.id AS user_id,
          u.username, s.csrf_token_hash, s.expires_at, s.revoked_at,
          (s.pending_guest_owner_id IS NOT NULL) AS pending_guest_claim, s.version
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
       JOIN data_owners o ON o.user_id = u.id AND o.status = 'active'
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
       UNION ALL
       SELECT s.id::text, o.id::text AS owner_id, 'guest' AS kind, NULL::integer AS user_id,
          NULL::text AS username, s.csrf_token_hash, s.expires_at, s.revoked_at,
          false AS pending_guest_claim, s.version
       FROM guest_sessions s
       JOIN data_owners o ON o.guest_session_id = s.id AND o.status = 'active'
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.claimed_at IS NULL AND s.expires_at > $2
       LIMIT 1`,
      [hash, now],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind,
      account: row.user_id === null ? null : { id: String(row.user_id), username: row.username ?? '' },
      csrfTokenHash: new Uint8Array(row.csrf_token_hash),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      pendingGuestClaim: row.pending_guest_claim,
      version: Number(row.version),
    };
  }

  async findAccountByUsernameKey(usernameKey: string): Promise<AccountCredential | null> {
    const key = canonicalizeName(usernameKey);
    const rows = await this.database.query<AccountRow>(
      `SELECT u.id, u.username, u.username_key, u.password_hash, u.disabled_at, o.id::text AS owner_id
       FROM users u JOIN data_owners o ON o.user_id = u.id AND o.status = 'active'
       WHERE u.username_key = $1 AND u.disabled_at IS NULL LIMIT 1`, [key],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: String(row.id), ownerId: row.owner_id, username: row.username, usernameKey: row.username_key ?? key, passwordHash: row.password_hash };
  }

  async consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision> {
    const decision = await this.database.consumeRateLimit({
      bucketHash: request.bucketHash,
      now: request.now,
      windowMs: request.windowMs,
      maximum: request.maximum,
    } satisfies RateLimitConsumeInput);
    return decision;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const rows = await this.database.query<{ ok: number }>('SELECT 1 AS ok');
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async execute<T = unknown>(request: StoreRequest): Promise<StoreResult<T>> {
    try {
      return await this.database.transaction(async tx => {
        if (request.actor) await this.assertActor(tx, request.actor, new Date());
        if (request.operation === 'session.createGuest') return await this.createGuest<T>(tx, request);
        if (request.operation === 'auth.register' || request.operation === 'auth.login') return await this.authenticate<T>(tx, request);
        const ownerId = this.requireActor(request.actor).ownerId;
        if (MUTATIONS.has(request.operation)) {
          const claimed = await this.claimIdempotency(tx, request, ownerId);
          if (claimed.replay) return claimed.replay as StoreResult<T>;
          const result = await this.dispatch<T>(tx, request, ownerId);
          if(request.operation!=='session.claimGuest')await this.appendAudit(tx,request.actor,ownerId,request.operation,request.resourceId??request.matchId??null);
          await this.completeIdempotency(tx, claimed.id, result);
          return result;
        }
        return await this.dispatch<T>(tx, request, ownerId);
      });
    } catch (error) {
      return mapError(error);
    }
  }

  private requireActor(actor: VerifiedActor | null): VerifiedActor {
    if (!actor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.ownerId)) {
      throw new StoreNotFoundError();
    }
    return actor;
  }

  private async ownerForUser(tx: Queryable, userId: number): Promise<string> {
    const found = await tx.query<{ id: string }>(
      `SELECT id::text FROM data_owners WHERE user_id=$1 AND status='active'`, [userId],
    );
    if (found[0]) return found[0].id;
    const id = randomUUID();
    await tx.execute(`INSERT INTO data_owners (id,user_id,status) VALUES ($1,$2,'active')`, [id, userId]);
    return id;
  }

  private async accountForAuth(tx: Queryable, usernameKey: string): Promise<AccountRow | null> {
    const key = canonicalizeName(usernameKey);
    const rows = await tx.query<AccountRow>(
      `SELECT u.id,u.username,u.username_key,u.password_hash,u.disabled_at,o.id::text owner_id
       FROM users u JOIN data_owners o ON o.user_id=u.id AND o.status='active'
       WHERE u.username_key=$1 AND u.disabled_at IS NULL FOR UPDATE OF u`, [key],
    );
    return rows[0] ?? null;
  }

  private async insertAuthenticatedSession(
    tx: Queryable,
    userId: number,
    credentials: NonNullable<StoreRequest['credentials']>,
    pendingGuestOwnerId: string | null,
    idempotencyRequestId: string,
  ): Promise<number> {
    if (!credentials.sessionTokenHash || !credentials.csrfTokenHash || !credentials.sessionExpiresAt
      || credentials.sessionExpiresAt.getTime()<=Date.now()) {
      throw new StoreValidationError([{ pointer: '', code: 'session-credentials', message: 'Session credentials are required.' }]);
    }
    const rows = await tx.query<{ version: number }>(
      `INSERT INTO user_sessions
        (id,user_id,token_hash,csrf_token_hash,expires_at,pending_guest_owner_id,idempotency_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING version`,
      [randomUUID(), userId, uuidBytes(credentials.sessionTokenHash), uuidBytes(credentials.csrfTokenHash), credentials.sessionExpiresAt, pendingGuestOwnerId,idempotencyRequestId],
    );
    return Number(rows[0]?.version ?? 1);
  }

  private async revokePreviousSession(tx: Queryable, actor: VerifiedActor | null): Promise<void> {
    if (!actor) return;
    if (actor.kind === 'authenticated') {
      await tx.execute(`UPDATE user_sessions SET revoked_at=now(),version=version+1 WHERE id=$1 AND revoked_at IS NULL`, [actor.sessionId]);
    } else {
      // The pending owner is now bound to the new authenticated session. The
      // former guest credential must no longer authorize its old owner scope.
      await tx.execute(`UPDATE guest_sessions SET revoked_at=now(),version=version+1 WHERE id=$1 AND revoked_at IS NULL`,[actor.sessionId]);
    }
  }

  private async authenticate<T>(tx: Queryable, request: StoreRequest): Promise<StoreResult<T>> {
    const input = record(request.input);
    const username = text(input.username).normalize('NFKC').trim().replace(/\p{White_Space}+/gu, ' ');
    const usernameKey = canonicalizeName(text(input.usernameKey, username));
    if (!username || username.length<3 || username.length>64 || !/^[\p{L}\p{N}_.@-]+$/u.test(username) || !usernameKey) {
      throw new StoreValidationError([{ pointer: '/username', code: 'invalid-name', message: 'Username is invalid.' }]);
    }
    const registering = request.operation === 'auth.register';
    if(!request.idempotency||request.idempotency.anchor!==(registering?'new-owner':'verified-owner'))
      throw new StoreValidationError([{pointer:'',code:'idempotency-anchor',message:'Authentication idempotency anchor is invalid.'}]);
    let account = await this.accountForAuth(tx, usernameKey);
    let createdAccount = false;
    if (registering && !account) {
      if (!request.credentials?.passwordHash || !/^\$2[aby]\$1[0-5]\$[./A-Za-z0-9]{53}$/.test(request.credentials.passwordHash)) {
        throw new StoreValidationError([{ pointer: '/password', code: 'password-hash-required', message: 'A password hash is required.' }]);
      }
      const users = await tx.query<{ id: number; username: string; username_key: string }>(
        `INSERT INTO users (username,username_key,username_key_version,password_hash)
         VALUES ($1,$2,$3,$4) RETURNING id,username,username_key`,
        [username, usernameKey, NAME_CANONICALIZATION_VERSION, request.credentials.passwordHash],
      );
      const user = users[0];
      if (!user) throw new StoreUnavailableError();
      const ownerId = await this.ownerForUser(tx, user.id);
      account = { ...user, password_hash: request.credentials.passwordHash, disabled_at: null, owner_id: ownerId };
      createdAccount = true;
    }
    if (!account) throw new StoreNotFoundError();
    const userOwnerId = account.owner_id || await this.ownerForUser(tx, account.id);
    const claimOwnerId = await this.claimIdempotency(tx, request, userOwnerId);
    if (registering && !createdAccount && !claimOwnerId.replay) throw new StoreConflictError();
    const actor = request.actor;
    let guestOwnerId: string | null = null;
    if (actor?.kind === 'guest') {
      const guest = await tx.query<{ owner_id: string }>(
        `SELECT o.id::text owner_id FROM guest_sessions s
         JOIN data_owners o ON o.guest_session_id=s.id AND o.status='active'
         WHERE s.id=$1 AND o.id=$2 AND s.revoked_at IS NULL AND s.claimed_at IS NULL AND s.expires_at>now() FOR UPDATE OF s,o`,
        [actor.sessionId, actor.ownerId],
      );
      guestOwnerId = guest[0]?.owner_id ?? null;
      if (!guestOwnerId) throw new StoreNotFoundError();
    }

    let logical: StoredResult;
    if (claimOwnerId.replay) {
      logical = record(claimOwnerId.replay) as unknown as StoredResult;
      if (registering && !createdAccount) {
        // A replay for the account created by this idempotency key is valid;
        // a different registration key for an existing username is not.
        if (claimOwnerId.replay.status !== 201) throw new StoreConflictError();
      }
      if (!guestOwnerId) {
        const pending = await tx.query<{ pending_guest_owner_id: string | null }>(
          `SELECT pending_guest_owner_id::text FROM user_sessions WHERE user_id=$1 AND pending_guest_owner_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`, [account.id],
        );
        guestOwnerId = pending[0]?.pending_guest_owner_id ?? null;
      }
      await tx.execute(`UPDATE user_sessions SET revoked_at=now(),version=version+1 WHERE idempotency_request_id=$1 AND revoked_at IS NULL`,[claimOwnerId.id]);
    } else {
      let transfer: Record<string, unknown> = {
        status: 'none', playersTransferred: 0, teamsTransferred: 0, tournamentsTransferred: 0, conflicts: [],
      };
      if (guestOwnerId) {
        const conflicts = await this.nameConflicts(tx, guestOwnerId, userOwnerId);
        if (conflicts.length) {
          transfer = { status: 'pending_conflicts', playersTransferred: 0, teamsTransferred: 0, tournamentsTransferred: 0, conflicts };
        } else {
          const counts = await this.transferGuestOwner(tx, guestOwnerId, userOwnerId, account.id);
          transfer = { status: 'transferred', ...counts, conflicts: [] };
          guestOwnerId = null;
        }
      }
      const pendingGuestOwnerId = guestOwnerId;
      const version = await this.insertAuthenticatedSession(tx, account.id, request.credentials ?? {}, pendingGuestOwnerId,claimOwnerId.id);
      await this.revokePreviousSession(tx, actor);
      logical = {
        status: registering ? 201 : 200,
        etag: quoteEtag(version),
        value: {
          session: {
            kind: 'authenticated',
            account: { id: String(account.id), username: account.username },
            pendingGuestClaim: Boolean(pendingGuestOwnerId),
            version,
          },
          transfer,
        },
      };
      await tx.execute(
        `INSERT INTO audit_events (id,actor_type,user_id,owner_id,action,entity_type,entity_id,details)
         VALUES ($1,'user',$2,$3,$4,'session',$5,$6::jsonb)`,
        [randomUUID(),account.id,userOwnerId,registering?'auth.registered':'auth.logged_in',actor?.sessionId??null,
          JSON.stringify({pendingGuestClaim:Boolean(pendingGuestOwnerId)})],
      );
      await this.completeIdempotency(tx, claimOwnerId.id, logical);
      return logical as StoreResult<T>;
    }

    const session = record(record(logical.value).session);
    const pendingGuestOwnerId = guestOwnerId ?? null;
    const version = await this.insertAuthenticatedSession(tx, account.id, request.credentials ?? {}, pendingGuestOwnerId,claimOwnerId.id);
    await this.revokePreviousSession(tx, actor);
    const value = {
      ...record(logical.value),
      session: {
        ...session,
        kind: 'authenticated',
        account: { id: String(account.id), username: account.username },
        pendingGuestClaim: Boolean(pendingGuestOwnerId),
        version,
      },
    };
    await tx.execute(
      `INSERT INTO audit_events (id,actor_type,user_id,owner_id,action,entity_type,entity_id,details)
       VALUES ($1,'user',$2,$3,$4,'session',$5,'{"idempotencyReplay":true}'::jsonb)`,
      [randomUUID(),account.id,userOwnerId,registering?'auth.registered':'auth.logged_in',actor?.sessionId??null],
    );
    return { status: registering ? 201 : 200, value: value as T, etag: quoteEtag(version) };
  }

  private async appendAudit(tx:Queryable,actor:VerifiedActor|null,ownerId:string,action:string,entityId:string|null):Promise<void>{
    const userId=actor?.kind==='authenticated'&&actor.account?Number(actor.account.id):null;
    const guestSessionId=actor?.kind==='guest'?actor.sessionId:null;
    await tx.execute(
      `INSERT INTO audit_events (id,actor_type,user_id,guest_session_id,owner_id,action,entity_type,entity_id,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
      [randomUUID(),actor?.kind==='authenticated'?'user':actor?.kind??'system',userId,guestSessionId,ownerId,action,action.split('.')[0]??'resource',entityId],
    );
  }

  private async nameConflicts(tx: Queryable, guestOwnerId: string, userOwnerId: string): Promise<Array<Record<string, unknown>>> {
    const [guestPlayers,targetPlayers,guestTeams,targetTeams]=await Promise.all([
      tx.query<{id:string;name:string}>(`SELECT id::text,name FROM players WHERE owner_id=$1 AND deleted_at IS NULL`,[guestOwnerId]),
      tx.query<{id:string;name:string}>(`SELECT id::text,name FROM players WHERE owner_id=$1 AND deleted_at IS NULL`,[userOwnerId]),
      tx.query<{id:string;name:string}>(`SELECT id::text,name FROM teams WHERE owner_id=$1 AND deleted_at IS NULL`,[guestOwnerId]),
      tx.query<{id:string;name:string}>(`SELECT id::text,name FROM teams WHERE owner_id=$1 AND deleted_at IS NULL`,[userOwnerId]),
    ]);
    const collect=(kind:'player'|'team',guestRows:Array<{id:string;name:string}>,targetRows:Array<{id:string;name:string}>):Array<Record<string,unknown>>=>{
      const targetNames=new Map<string,Set<string>>();
      for(const row of targetRows){const key=canonicalizeName(row.name);const names=targetNames.get(key)??new Set<string>();names.add(row.name);targetNames.set(key,names);}
      const guestNames=new Map<string,Array<{id:string;name:string}>>();
      for(const row of guestRows){const key=canonicalizeName(row.name);const rows=guestNames.get(key)??[];rows.push(row);guestNames.set(key,rows);}
      const conflicts:Array<Record<string,unknown>>=[];
      for(const [key,rows] of guestNames){
        const peers=rows.length>1?rows.map(row=>row.name):[];
        const collisionNames=new Set<string>([...(targetNames.get(key)??[]),...peers]);
        if(!key)for(const row of rows)collisionNames.add(row.name);
        if(collisionNames.size===0)continue;
        for(const row of rows)conflicts.push({entityKind:kind,resourceId:row.id,displayName:row.name,collisionNames:Array.from(collisionNames)});
      }
      return conflicts;
    };
    return [...collect('player',guestPlayers,targetPlayers),...collect('team',guestTeams,targetTeams)];
  }

  private async transferGuestOwner(
    tx: Queryable,
    guestOwnerId: string,
    userOwnerId: string,
    userId: number,
  ): Promise<{ playersTransferred: number; teamsTransferred: number; tournamentsTransferred: number }> {
    const locked=await tx.query<{id:string;status:string}>(
      `SELECT id::text,status FROM data_owners WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[[guestOwnerId,userOwnerId]],
    );
    if(locked.length!==2||locked.find(owner=>owner.id===guestOwnerId)?.status!=='active'
      ||locked.find(owner=>owner.id===userOwnerId)?.status!=='active')throw new StoreConflictError();
    await tx.query('SET CONSTRAINTS ALL DEFERRED');
    const players = await tx.execute(
      `UPDATE players SET owner_id=$2,user_id=$3,guest_session_id=NULL,updated_at=now(),version=version+1
       WHERE owner_id=$1`, [guestOwnerId,userOwnerId,userId],
    );
    const teams = await tx.execute(
      `UPDATE teams SET owner_id=$2,updated_at=now(),version=version+1 WHERE owner_id=$1`, [guestOwnerId,userOwnerId],
    );
    const tournaments = await tx.execute(
      `UPDATE tournaments SET owner_id=$2,user_id=$3,guest_session_id=NULL,updated_at=now(),version=version+1 WHERE owner_id=$1`,
      [guestOwnerId,userOwnerId,userId],
    );
    await tx.execute(
      `UPDATE matches SET owner_id=$2,user_id=$3,guest_session_id=NULL WHERE owner_id=$1`, [guestOwnerId,userOwnerId,userId],
    );
    await tx.execute(
      `UPDATE user_sessions SET pending_guest_owner_id=NULL,version=version+1
       WHERE pending_guest_owner_id=$1 AND user_id=$2`,[guestOwnerId,userId],
    );
    const source = await tx.query<{ guest_session_id: string | null }>('SELECT guest_session_id::text FROM data_owners WHERE id=$1 FOR UPDATE', [guestOwnerId]);
    await tx.execute(
      `UPDATE data_owners SET status='merged',merged_into_owner_id=$2 WHERE id=$1 AND status='active'`, [guestOwnerId,userOwnerId],
    );
    if (source[0]?.guest_session_id) {
      await tx.execute(`UPDATE guest_sessions SET revoked_at=now(),claimed_at=now(),version=version+1 WHERE id=$1`, [source[0].guest_session_id]);
    }
    await tx.execute(
      `INSERT INTO audit_events (id,actor_type,user_id,owner_id,action,entity_type,entity_id,details)
       VALUES ($1,'user',$2,$3,'guest.claimed','data_owner',$4,$5::jsonb)`,
      [randomUUID(),userId,userOwnerId,guestOwnerId,JSON.stringify({ players, teams, tournaments })],
    );
    return { playersTransferred: players, teamsTransferred: teams, tournamentsTransferred: tournaments };
  }

  private async normalizeGuestNames(tx: Queryable, ownerId: string): Promise<void> {
    const players = await tx.query<{ id: number; name: string }>(
      'SELECT id,name FROM players WHERE owner_id=$1 AND deleted_at IS NULL', [ownerId],
    );
    for (const player of players) {
      const key = canonicalizeName(player.name);
      if (!key) throw new StoreConflictError();
      await tx.execute(
        'UPDATE players SET name_key=$1,name_key_version=$2 WHERE id=$3 AND owner_id=$4',
        [key, NAME_CANONICALIZATION_VERSION, player.id, ownerId],
      );
    }
    const teams = await tx.query<{ id: string; name: string }>(
      'SELECT id::text,name FROM teams WHERE owner_id=$1 AND deleted_at IS NULL', [ownerId],
    );
    for (const team of teams) {
      const key = canonicalizeName(team.name);
      if (!key) throw new StoreConflictError();
      await tx.execute(
        'UPDATE teams SET name_key=$1,name_key_version=$2 WHERE id=$3 AND owner_id=$4',
        [key, NAME_CANONICALIZATION_VERSION, team.id, ownerId],
      );
    }
  }

  private async assertActor(tx: Queryable, actor: VerifiedActor, now: Date): Promise<void> {
    const rows = await tx.query<SessionRow>(
      `SELECT s.id::text, o.id::text AS owner_id, 'authenticated' AS kind, u.id AS user_id,
          u.username, s.csrf_token_hash, s.expires_at, s.revoked_at,
          (s.pending_guest_owner_id IS NOT NULL) AS pending_guest_claim, s.version
       FROM user_sessions s JOIN users u ON u.id = s.user_id JOIN data_owners o ON o.user_id = u.id
       WHERE s.id = $1 AND o.status = 'active' AND u.disabled_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at > $2
       UNION ALL
       SELECT s.id::text, o.id::text AS owner_id, 'guest' AS kind, NULL::integer AS user_id,
          NULL::text AS username, s.csrf_token_hash, s.expires_at, s.revoked_at,
          false AS pending_guest_claim, s.version
       FROM guest_sessions s JOIN data_owners o ON o.guest_session_id = s.id
       WHERE s.id = $1 AND o.status = 'active' AND s.revoked_at IS NULL AND s.claimed_at IS NULL AND s.expires_at > $2
       LIMIT 1`, [actor.sessionId, now],
    );
    const row = rows[0];
    if (!row || row.owner_id !== actor.ownerId || row.kind !== actor.kind
      || (row.user_id === null) !== (actor.account === null)
      || (row.user_id !== null && String(row.user_id) !== actor.account?.id)) throw new StoreNotFoundError();
  }

  private async claimIdempotency(tx: Queryable, request: StoreRequest, ownerId: string): Promise<{ id: string; replay?: StoreResult }> {
    const input = request.idempotency;
    if (!input || input.key.length < 16 || input.key.length > 200) {
      throw new StoreValidationError([{ pointer: '', code: 'idempotency-required', message: 'A valid idempotency key is required.' }]);
    }
    const expectedAnchor=request.operation==='auth.register'?'new-owner':request.operation==='auth.login'?'verified-owner':'actor-owner';
    if(input.anchor!==expectedAnchor)throw new StoreValidationError([{pointer:'',code:'idempotency-anchor',message:'Idempotency anchor does not match this operation.'}]);
    const operation = operationScope(request);
    const hash = idempotencyDigest(input.requestHash);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO idempotency_requests (id, owner_id, operation, key, request_hash, status)
       VALUES ($1,$2,$3,$4,$5,'in_progress')
       ON CONFLICT (owner_id, operation, key) DO NOTHING RETURNING id::text`,
      [randomUUID(), ownerId, operation, input.key, hash],
    );
    if (inserted[0]) return { id: inserted[0].id };
    const rows = await tx.query<{ id: string; request_hash: Buffer; status: string; response: StoredResult | null }>(
      `SELECT id::text, request_hash, status, response FROM idempotency_requests
       WHERE owner_id=$1 AND operation=$2 AND key=$3 FOR UPDATE`, [ownerId, operation, input.key],
    );
    const prior = rows[0];
    if (!prior || !Buffer.from(prior.request_hash).equals(hash)) throw new StoreConflictError();
    if (prior.status !== 'completed' || !prior.response) throw new StoreConflictError();
    return { id: prior.id, replay: prior.response };
  }

  private async completeIdempotency(tx: Queryable, id: string, result: StoreResult): Promise<void> {
    await tx.execute(
      `UPDATE idempotency_requests SET status='completed', response=$2::jsonb, completed_at=now()
       WHERE id=$1 AND status='in_progress'`, [id, JSON.stringify(result)],
    );
  }

  private async dispatch<T>(tx: Queryable, request: StoreRequest, ownerId: string): Promise<StoreResult<T>> {
    switch (request.operation) {
      case 'session.get': return this.getSession<T>(tx, request.actor!);
      case 'session.getClaimDetails': return this.getClaimDetails<T>(tx, request.actor!);
      case 'session.revoke': case 'auth.logout': return this.revokeSession<T>(tx, request.actor!);
      case 'session.claimGuest': return this.claimGuest<T>(tx, request, ownerId);
      case 'players.list': return this.listPlayers<T>(tx, ownerId, request.query);
      case 'players.get': return this.getPlayer<T>(tx, ownerId, request.resourceId);
      case 'players.create': return this.createPlayer<T>(tx, ownerId, request.input);
      case 'players.update': return this.updatePlayer<T>(tx, ownerId, request);
      case 'players.delete': return this.deletePlayer<T>(tx, ownerId, request);
      case 'teams.list': return this.listTeams<T>(tx, ownerId, request.query);
      case 'teams.get': return this.getTeam<T>(tx, ownerId, request.resourceId);
      case 'teams.create': return this.createTeam<T>(tx, ownerId, request.input);
      case 'teams.update': return this.updateTeam<T>(tx, ownerId, request);
      case 'teams.delete': return this.deleteTeam<T>(tx, ownerId, request);
      case 'tournaments.list': return this.listTournaments<T>(tx, ownerId, request.query);
      case 'tournaments.get': return this.getTournamentResult<T>(tx, ownerId, request.resourceId);
      case 'tournaments.create': return this.createTournament<T>(tx, ownerId, request.input);
      case 'tournaments.updateDraft': return this.updateDraft<T>(tx, ownerId, request);
      case 'tournaments.deleteDraft': return this.deleteDraft<T>(tx, ownerId, request);
      case 'tournaments.start': return this.startTournamentOperation<T>(tx, ownerId, request);
      case 'tournaments.cancel': case 'tournaments.pause': case 'tournaments.resume': case 'tournaments.finish':
        return this.tournamentTransition<T>(tx, ownerId, request);
      case 'tournaments.updateAvailability': return this.updateAvailability<T>(tx, ownerId, request);
      case 'tournaments.listMatches': return this.listMatches<T>(tx, ownerId, request);
      case 'tournaments.getSchedule': return this.getSchedule<T>(tx, ownerId, request.resourceId);
      case 'tournaments.getStandings': return this.getStandings<T>(tx, ownerId, request.resourceId, request.query);
      case 'matches.get': return this.getMatchResult<T>(tx, ownerId, request);
      case 'matches.start': case 'matches.pause': case 'matches.resume': case 'matches.recordResult': case 'matches.skip':
        return this.matchOperation<T>(tx, ownerId, request);
      case 'standings.getOverall': return this.getOverallStandings<T>(tx, ownerId, request.query);
      case 'session.createGuest': case 'auth.register': case 'auth.login':
        throw new StoreUnavailableError();
      default: {
        const exhaustive: never = request.operation;
        void exhaustive;
        throw new StoreUnavailableError();
      }
    }
  }

  private async getSession<T>(tx: Queryable, actor: VerifiedActor): Promise<StoreResult<T>> {
    const rows = await tx.query<SessionRow>(
      `SELECT s.id::text, o.id::text owner_id, 'authenticated' kind, u.id user_id, u.username,
        s.csrf_token_hash, s.expires_at, s.revoked_at,
        s.pending_guest_owner_id IS NOT NULL pending_guest_claim, s.version
       FROM user_sessions s JOIN users u ON u.id=s.user_id JOIN data_owners o ON o.user_id=u.id
       WHERE s.id=$1 AND o.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL
       UNION ALL
       SELECT s.id::text,o.id::text,'guest',NULL::integer,NULL::text,s.csrf_token_hash,s.expires_at,s.revoked_at,
        false,s.version FROM guest_sessions s JOIN data_owners o ON o.guest_session_id=s.id
       WHERE s.id=$1 AND o.id=$2 AND s.revoked_at IS NULL AND s.claimed_at IS NULL AND s.expires_at>now() LIMIT 1`,
      [actor.sessionId, actor.ownerId],
    );
    const row = rows[0];
    if (!row) throw new StoreNotFoundError();
    return { value: { version: Number(row.version), pendingGuestClaim: row.pending_guest_claim } as T, etag: quoteEtag(Number(row.version)) };
  }

  private async createGuest<T>(tx: Queryable, request: StoreRequest): Promise<StoreResult<T>> {
    const credentials = request.credentials;
    if (request.actor || !credentials?.sessionTokenHash || !credentials.csrfTokenHash || !credentials.sessionExpiresAt
      || credentials.sessionExpiresAt.getTime()<=Date.now()) {
      throw new StoreValidationError([{ pointer: '', code: 'session-credentials', message: 'Guest session credentials are required.' }]);
    }
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    await tx.execute(
      `INSERT INTO guest_sessions (id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4)`,
      [sessionId, uuidBytes(credentials.sessionTokenHash), uuidBytes(credentials.csrfTokenHash), credentials.sessionExpiresAt],
    );
    await tx.execute(`INSERT INTO data_owners (id,guest_session_id,status) VALUES ($1,$2,'active')`, [ownerId, sessionId]);
    await tx.execute(
      `INSERT INTO audit_events (id,actor_type,guest_session_id,owner_id,action,entity_type,entity_id,details)
       VALUES ($1,'guest',$2,$3,'session.created','guest_session',$2,'{}'::jsonb)`,[randomUUID(),sessionId,ownerId],
    );
    return { status: 201, value: { version: 1 } as T, etag: quoteEtag(1) };
  }

  private async revokeSession<T>(tx: Queryable, actor: VerifiedActor): Promise<StoreResult<T>> {
    const user = await tx.execute('UPDATE user_sessions SET revoked_at=now(), version=version+1 WHERE id=$1 AND user_id=(SELECT user_id FROM data_owners WHERE id=$2) AND revoked_at IS NULL', [actor.sessionId, actor.ownerId]);
    const guest = user === 0 ? await tx.execute('UPDATE guest_sessions SET revoked_at=now(), version=version+1 WHERE id=$1 AND id=(SELECT guest_session_id FROM data_owners WHERE id=$2) AND revoked_at IS NULL', [actor.sessionId, actor.ownerId]) : 0;
    if (user + guest === 0) throw new StoreNotFoundError();
    return { status: 204, value: null as T };
  }

  private async getClaimDetails<T>(tx: Queryable, actor: VerifiedActor): Promise<StoreResult<T>> {
    const rows = await tx.query<{ pending_guest_owner_id: string | null; version: number }>(
      `SELECT pending_guest_owner_id::text,version FROM user_sessions WHERE id=$1 AND user_id=(SELECT user_id FROM data_owners WHERE id=$2) AND revoked_at IS NULL`,
      [actor.sessionId, actor.ownerId],
    );
    const session = rows[0];
    if (!session?.pending_guest_owner_id) throw new StoreNotFoundError();
    const conflicts = await this.nameConflicts(tx, session.pending_guest_owner_id, actor.ownerId);
    return { value: { pending: true, conflicts } as T, etag: quoteEtag(Number(session.version)) };
  }

  private async claimGuest<T>(tx: Queryable, request: StoreRequest, userOwnerId: string): Promise<StoreResult<T>> {
    const actor = this.requireActor(request.actor);
    if (actor.kind !== 'authenticated' || !actor.account) throw new StoreConflictError();
    const userId = Number(actor.account.id);
    if (!Number.isSafeInteger(userId)) throw new StoreNotFoundError();
    const sessions = await tx.query<{ pending_guest_owner_id: string | null; version: number }>(
      `SELECT pending_guest_owner_id::text,version FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE`,
      [actor.sessionId,userId],
    );
    const session = sessions[0];
    if (!session?.pending_guest_owner_id) throw new StoreNotFoundError();
    assertEtag(request.expectedETag, Number(session.version));
    const guestOwnerId = session.pending_guest_owner_id;
    await tx.query(`SELECT id FROM data_owners WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`, [guestOwnerId,userOwnerId]);
    const guest = await tx.query<{ status: string }>(`SELECT status FROM data_owners WHERE id=$1`, [guestOwnerId]);
    if (guest[0]?.status !== 'active') throw new StoreConflictError();
    const currentConflicts = await this.nameConflicts(tx,guestOwnerId,userOwnerId);
    const input = record(request.input);
    const resolutions = Array.isArray(input.renames) ? input.renames.map(record) : [];
    const expected = new Set(currentConflicts.map(conflict => `${conflict.entityKind}:${conflict.resourceId}`));
    const seen = new Set<string>();
    for(const resolution of resolutions){
      const type=text(resolution.resourceType);const id=text(resolution.guestResourceId);
      const key=`${type==='player'?'player':'team'}:${id}`;
      if(!expected.has(key))continue;
      const table=type==='player'?'players':type==='team'?'teams':null;
      if(!table)continue;
      const cleared=await tx.execute(`UPDATE ${table} SET name_key=NULL WHERE id::text=$1 AND owner_id=$2 AND deleted_at IS NULL`,[id,guestOwnerId]);
      if(!cleared)throw new StoreNotFoundError();
    }
    for (const resolution of resolutions) {
      const type = text(resolution.resourceType);
      const id = text(resolution.guestResourceId);
      const key = `${type === 'player' ? 'player' : 'team'}:${id}`;
      if (!expected.has(key) || seen.has(key)) throw new StoreConflictError();
      seen.add(key);
      const name = normalizedName(text(resolution.newName));
      if (type === 'player') {
        const updated = await tx.execute(
          `UPDATE players SET name=$1,name_key=$2,name_key_version=$3,updated_at=now(),version=version+1
           WHERE id::text=$4 AND owner_id=$5 AND deleted_at IS NULL`,
          [name.display,name.key,NAME_CANONICALIZATION_VERSION,id,guestOwnerId],
        );
        if (!updated) throw new StoreNotFoundError();
      } else if (type === 'team') {
        const updated = await tx.execute(
          `UPDATE teams SET name=$1,name_key=$2,name_key_version=$3,updated_at=now(),version=version+1
           WHERE id::text=$4 AND owner_id=$5 AND deleted_at IS NULL`,
          [name.display,name.key,NAME_CANONICALIZATION_VERSION,id,guestOwnerId],
        );
        if (!updated) throw new StoreNotFoundError();
      } else throw new StoreConflictError();
    }
    if (seen.size !== expected.size) throw new StoreConflictError();
    await this.normalizeGuestNames(tx,guestOwnerId);
    if ((await this.nameConflicts(tx,guestOwnerId,userOwnerId)).length) throw new StoreConflictError();
    const counts = await this.transferGuestOwner(tx,guestOwnerId,userOwnerId,userId);
    const updatedSessions=await tx.query<{id:string;version:number}>(
      `UPDATE user_sessions SET pending_guest_owner_id=NULL,version=version+1
       WHERE pending_guest_owner_id=$1 AND user_id=$2 RETURNING id::text,version`,[guestOwnerId,userId],
    );
    const version=Number(updatedSessions.find(item=>item.id===actor.sessionId)?.version??(Number(session.version)+1));
    return { status: 200, value: { status:'transferred',...counts,conflicts:[] } as T, etag: quoteEtag(version) };
  }

  private async findPlayer(tx: Queryable, ownerId: string, playerId: string | undefined, lock = false): Promise<PlayerRow> {
    const parsedId = playerId && /^\d+$/.test(playerId) ? Number(playerId) : NaN;
    if (!Number.isSafeInteger(parsedId)) throw new StoreNotFoundError();
    const rows = await tx.query<PlayerRow>(
      `SELECT id,owner_id::text,name,name_key,games_played,wins,losses,draws,points_for,points_against,diff,
        created_at,updated_at,version,deleted_at FROM players
       WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [parsedId,ownerId],
    );
    if (!rows[0]) throw new StoreNotFoundError();
    return rows[0];
  }

  private playerValue(row: PlayerRow): Record<string, unknown> {
    return serializePlayerResponse(row);
  }

  private async listPlayers<T>(tx: Queryable, ownerId: string, query?: StoreRequest['query']): Promise<StoreResult<T>> {
    const limit = Math.min(100, Math.max(1, integer(query?.limit,25)));
    const cursor = cursorDecode(query?.cursor);
    const cursorId = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    if (query?.cursor !== undefined && (!cursorId || !Number.isSafeInteger(cursorId))) throw new StoreValidationError([{pointer:'/cursor',code:'invalid-cursor',message:'Cursor is invalid.'}]);
    const q = text(query?.q).slice(0,100);
    const rows = await tx.query<PlayerRow>(
      `SELECT id,owner_id::text,name,name_key,games_played,wins,losses,draws,points_for,points_against,diff,
        created_at,updated_at,version,deleted_at FROM players
       WHERE owner_id=$1 AND deleted_at IS NULL AND id>$2 AND ($3='' OR name ILIKE '%' || $3 || '%')
       ORDER BY id LIMIT $4`, [ownerId,cursorId,q,limit+1],
    );
    const pageRows = rows.slice(0,limit);
    const nextCursor = rows.length > limit ? cursorEncode(pageRows[pageRows.length-1]!.id) : null;
    return { value:{ items:pageRows.map(row=>this.playerValue(row)),nextCursor } as T };
  }

  private async getPlayer<T>(tx: Queryable, ownerId: string, id?: string): Promise<StoreResult<T>> {
    const row = await this.findPlayer(tx,ownerId,id);
    return {value:this.playerValue(row) as T,etag:quoteEtag(Number(row.version))};
  }

  private async createPlayer<T>(tx: Queryable, ownerId: string, inputValue?: Readonly<Record<string, unknown>>): Promise<StoreResult<T>> {
    const name=normalizedName(text(record(inputValue).name));
    const rows=await tx.query<PlayerRow>(
      `INSERT INTO players (owner_id,name,name_key,name_key_version) VALUES ($1,$2,$3,$4)
       RETURNING id,owner_id::text,name,name_key,games_played,wins,losses,draws,points_for,points_against,diff,created_at,updated_at,version,deleted_at`,
      [ownerId,name.display,name.key,NAME_CANONICALIZATION_VERSION],
    );
    const row=rows[0]; if(!row) throw new StoreUnavailableError();
    return {status:201,value:this.playerValue(row) as T,etag:quoteEtag(Number(row.version))};
  }

  private async updatePlayer<T>(tx: Queryable, ownerId: string, request: StoreRequest): Promise<StoreResult<T>> {
    const row=await this.findPlayer(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(row.version));
    const name=normalizedName(text(record(request.input).name));
    const rows=await tx.query<PlayerRow>(
      `UPDATE players SET name=$1,name_key=$2,name_key_version=$3,updated_at=now(),version=version+1
       WHERE id=$4 AND owner_id=$5 AND version=$6
       RETURNING id,owner_id::text,name,name_key,games_played,wins,losses,draws,points_for,points_against,diff,created_at,updated_at,version,deleted_at`,
      [name.display,name.key,NAME_CANONICALIZATION_VERSION,row.id,ownerId,row.version],
    );
    const updated=rows[0]; if(!updated) throw new StorePreconditionFailedError();
    return {value:this.playerValue(updated) as T,etag:quoteEtag(Number(updated.version))};
  }

  private async deletePlayer<T>(tx: Queryable, ownerId: string, request: StoreRequest): Promise<StoreResult<T>> {
    const row=await this.findPlayer(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(row.version));
    const refs=await tx.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id
         WHERE tm.player_id=$1 AND tm.owner_id=$2 AND t.deleted_at IS NULL)
       OR EXISTS(SELECT 1 FROM tournament_enrollments e JOIN tournaments t ON t.id=e.tournament_id
         WHERE e.player_id=$1 AND e.owner_id=$2 AND t.status IN ('draft','active','paused')) AS exists`,[row.id,ownerId],
    );
    if(refs[0]?.exists) throw new StoreConflictError();
    const deleted=await tx.execute(`UPDATE players SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND owner_id=$2 AND version=$3`,[row.id,ownerId,row.version]);
    if(!deleted) throw new StorePreconditionFailedError();
    return {status:204,value:null as T};
  }

  private async findTeam(tx: Queryable, ownerId: string, id?: string, lock = false): Promise<TeamRow> {
    if(!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new StoreNotFoundError();
    const rows=await tx.query<TeamRow>(
      `SELECT id::text,owner_id::text,name,name_key,created_at,updated_at,version,deleted_at FROM teams
       WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[id,ownerId],
    );
    if(!rows[0]) throw new StoreNotFoundError();
    return rows[0];
  }

  private async teamValue(tx: Queryable, row: TeamRow): Promise<Record<string, unknown>> {
    const members=await tx.query<{id:number;name:string;position:number}>(
      `SELECT p.id,p.name,tm.position FROM team_members tm JOIN players p ON p.id=tm.player_id
       WHERE tm.team_id=$1 AND tm.owner_id=$2 ORDER BY tm.position`,[row.id,row.owner_id],
    );
    return serializeTeamResponse(row,members);
  }

  private async listTeams<T>(tx: Queryable, ownerId: string, query?: StoreRequest['query']): Promise<StoreResult<T>> {
    const limit=Math.min(100,Math.max(1,integer(query?.limit,25)));
    const cursor=cursorDecode(query?.cursor);
    if(query?.cursor!==undefined&&(!cursor||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)))
      throw new StoreValidationError([{pointer:'/cursor',code:'invalid-cursor',message:'Cursor is invalid.'}]);
    const rows=await tx.query<TeamRow>(
      `SELECT id::text,owner_id::text,name,name_key,created_at,updated_at,version,deleted_at FROM teams
       WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id>$2::uuid)
       ORDER BY id LIMIT $3`,[ownerId,cursor,limit+1],
    );
    const pageRows=rows.slice(0,limit);
    const items=[]; for(const row of pageRows) items.push(await this.teamValue(tx,row));
    return {value:{items,nextCursor:rows.length>limit?cursorEncode(pageRows[pageRows.length-1]!.id):null} as T};
  }

  private async ownedPlayers(tx: Queryable, ownerId: string, inputIds: unknown,min=2,max=32): Promise<PlayerRow[]> {
    const ids=ensureIds(inputIds,min,max);
    const numeric=ids.map(id=>/^\d+$/.test(id)?Number(id):NaN);
    if(numeric.some(id=>!Number.isSafeInteger(id))) throw new StoreNotFoundError();
    const rows=await tx.query<PlayerRow>(
      `SELECT id,owner_id::text,name,name_key,games_played,wins,losses,draws,points_for,points_against,diff,
        created_at,updated_at,version,deleted_at FROM players
       WHERE owner_id=$1 AND deleted_at IS NULL AND id=ANY($2::integer[]) ORDER BY array_position($2::integer[],id) FOR UPDATE`,[ownerId,numeric],
    );
    if(rows.length!==new Set(numeric).size) throw new StoreNotFoundError();
    return rows;
  }

  private async createTeam<T>(tx: Queryable, ownerId: string, inputValue?: Readonly<Record<string, unknown>>): Promise<StoreResult<T>> {
    const input=record(inputValue); const name=normalizedName(text(input.name));
    const players=await this.ownedPlayers(tx,ownerId,input.playerIds,2,2);
    if(players.length!==2) throw new StoreNotFoundError();
    const teamId=randomUUID();
    const rows=await tx.query<TeamRow>(
      `INSERT INTO teams (id,owner_id,name,name_key,name_key_version) VALUES ($1,$2,$3,$4,$5)
       RETURNING id::text,owner_id::text,name,name_key,created_at,updated_at,version,deleted_at`,
      [teamId,ownerId,name.display,name.key,NAME_CANONICALIZATION_VERSION],
    );
    const team=rows[0]; if(!team) throw new StoreUnavailableError();
    for(let i=0;i<2;i++) await tx.execute(`INSERT INTO team_members (team_id,owner_id,player_id,position) VALUES ($1,$2,$3,$4)`,[teamId,ownerId,players[i]!.id,i+1]);
    return {status:201,value:await this.teamValue(tx,team) as T,etag:quoteEtag(Number(team.version))};
  }

  private async getTeam<T>(tx: Queryable, ownerId: string, id?: string): Promise<StoreResult<T>> {
    const row=await this.findTeam(tx,ownerId,id);
    return {value:await this.teamValue(tx,row) as T,etag:quoteEtag(Number(row.version))};
  }

  private async updateTeam<T>(tx: Queryable, ownerId: string, request: StoreRequest): Promise<StoreResult<T>> {
    const row=await this.findTeam(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(row.version));
    const input=record(request.input); const updates: Array<{display:string;key:string}> = [];
    if(typeof input.name==='string') updates.push(normalizedName(input.name));
    const refs=await tx.query<{exists:boolean}>(
      `SELECT EXISTS(SELECT 1 FROM fixed_team_entries e JOIN tournaments t ON t.id=e.tournament_id
       WHERE e.team_id=$1 AND e.owner_id=$2 AND t.status IN ('draft','active','paused')) AS exists`,[row.id,ownerId],
    );
    if(refs[0]?.exists) throw new StoreConflictError();
    if(input.playerIds!==undefined){
      const players=await this.ownedPlayers(tx,ownerId,input.playerIds,2,2);
      if(players.length!==2) throw new StoreNotFoundError();
      await tx.execute('DELETE FROM team_members WHERE team_id=$1 AND owner_id=$2',[row.id,ownerId]);
      for(let i=0;i<2;i++) await tx.execute('INSERT INTO team_members (team_id,owner_id,player_id,position) VALUES ($1,$2,$3,$4)',[row.id,ownerId,players[i]!.id,i+1]);
    }
    const name=updates[0];
    const updated=await tx.query<TeamRow>(
      `UPDATE teams SET name=coalesce($1,name),name_key=coalesce($2,name_key),
         name_key_version=CASE WHEN $1 IS NULL THEN name_key_version ELSE $3 END,
         updated_at=now(),version=version+1
       WHERE id=$4 AND owner_id=$5 AND version=$6
       RETURNING id::text,owner_id::text,name,name_key,created_at,updated_at,version,deleted_at`,
      [name?.display??null,name?.key??null,NAME_CANONICALIZATION_VERSION,row.id,ownerId,row.version],
    );
    const result=updated[0];if(!result)throw new StorePreconditionFailedError();
    return {value:await this.teamValue(tx,result) as T,etag:quoteEtag(Number(result.version))};
  }

  private async deleteTeam<T>(tx: Queryable, ownerId: string, request: StoreRequest): Promise<StoreResult<T>> {
    const row=await this.findTeam(tx,ownerId,request.resourceId,true);assertEtag(request.expectedETag,Number(row.version));
    const refs=await tx.query<{exists:boolean}>(
      `SELECT EXISTS(SELECT 1 FROM fixed_team_entries e JOIN tournaments t ON t.id=e.tournament_id
       WHERE e.team_id=$1 AND e.owner_id=$2 AND t.status IN ('draft','active','paused')) AS exists`,[row.id,ownerId],
    );
    if(refs[0]?.exists)throw new StoreConflictError();
    const n=await tx.execute(`UPDATE teams SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND owner_id=$2 AND version=$3`,[row.id,ownerId,row.version]);
    if(!n)throw new StorePreconditionFailedError();
    return {status:204,value:null as T};
  }

  private async findTournament(tx: Queryable, ownerId: string, id?: string, lock = false): Promise<TournamentRow> {
    if(!id)throw new StoreNotFoundError();
    const rows=await tx.query<TournamentRow>(
      `SELECT id,public_id::text,owner_id::text,name,mode,status,version,seed,generator_version,paused_player_ids,
        created_at,updated_at,started_at,paused_at,completed_at,cancelled_at
       FROM tournaments WHERE public_id::text=$1 AND owner_id=$2 AND deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[id,ownerId],
    );
    if(!rows[0])throw new StoreNotFoundError();
    return rows[0];
  }

  private async loadTournament(tx: Queryable, ownerId: string, id?: string, lock = false): Promise<LoadedTournament> {
    const row=await this.findTournament(tx,ownerId,id,lock);
    const enrollments=await tx.query<{id:string;player_id:number|null;player_name_snapshot:string;seed:number|null}>(
      `SELECT id::text,player_id,player_name_snapshot,seed FROM tournament_enrollments
       WHERE tournament_id=$1 AND owner_id=$2 AND withdrawn_at IS NULL ORDER BY seed NULLS LAST,enrolled_at,id`,[row.id,ownerId],
    );
    const participants:Participant[]=enrollments.map(entry=>({id:entry.player_id===null?`snapshot:${entry.id}`:String(entry.player_id),name:entry.player_name_snapshot}));
    const entries=await tx.query<{id:string;team_id:string|null;team_name_snapshot:string;entry_number:number}>(
      `SELECT id::text,team_id::text,team_name_snapshot,entry_number FROM fixed_team_entries
       WHERE tournament_id=$1 AND owner_id=$2 ORDER BY entry_number`,[row.id,ownerId],
    );
    const fixedEntries:LoadedTournament['fixedEntries']=[];
    const fixedTeams:FixedTeam[]=[];
    for(const entry of entries){
      const members=await tx.query<{position:number;player_id:number|null;player_name_snapshot:string}>(
        `SELECT position,player_id,player_name_snapshot FROM fixed_team_entry_members
         WHERE fixed_team_entry_id=$1 AND owner_id=$2 ORDER BY position`,[entry.id,ownerId],
      );
      if(members.length!==2)continue;
      const playerIds=members.map((member,index)=>member.player_id===null?`snapshot:${entry.id}:${index+1}`:String(member.player_id)) as [string,string];
      const id=entry.team_id??entry.id;
      fixedEntries.push({id:entry.id,teamId:entry.team_id??entry.id,name:entry.team_name_snapshot,playerIds});
      fixedTeams.push({id,name:entry.team_name_snapshot,playerIds});
    }
    const matchRows=await tx.query<MatchRow>(
      `SELECT id,public_id::text,external_id,tournament_id,round,sequence_no,normalized_status,winner_side,version,
        start_time,end_time,completed_at,created_at FROM matches WHERE tournament_id=$1 AND owner_id=$2
       ORDER BY sequence_no,id`,[row.id,ownerId],
    );
    const matches:DomainMatch[]=[];
    for(const match of matchRows){
      const sides=await tx.query<SideRow>(
        `SELECT match_id,side_no,side_id,score,fixed_team_id::text,fixed_team_name_snapshot FROM match_sides
         WHERE match_id=$1 AND owner_id=$2 ORDER BY side_no`,[match.id,ownerId],
      );
      if(sides.length!==2)continue;
      const pauseRows=await tx.query<{started_at:Date;ended_at:Date|null;reason:'organizer'|'participant_unavailable'}>(
        `SELECT started_at,ended_at,reason FROM match_pause_intervals WHERE match_id=$1 ORDER BY started_at`,[match.id],
      );
      const domainSides:MatchSide[]=[];
      for(const side of sides){
        const snapshots=await tx.query<PlayerSnapshotRow>(
          `SELECT match_id,side_no,position,player_id,player_name_snapshot FROM match_players
           WHERE match_id=$1 AND side_no=$2 AND owner_id=$3 ORDER BY position`,[match.id,side.side_no,ownerId],
        );
        const players=snapshots.map(snapshot=>({
          id:snapshot.player_id===null?`snapshot:${match.external_id}:${side.side_no}:${snapshot.position}`:String(snapshot.player_id),
          name:snapshot.player_name_snapshot,
        }));
        for(const participant of players)if(!participants.some(existing=>existing.id===participant.id))participants.push(participant);
        const matchSide:MatchSide={id:side.side_id??`${match.external_id}:side${side.side_no}`,players,score:side.score};
        if(side.fixed_team_id)matchSide.fixedTeamId=side.fixed_team_id;
        if(side.fixed_team_name_snapshot)matchSide.fixedTeamName=side.fixed_team_name_snapshot;
        domainSides.push(matchSide);
      }
      matches.push({
        id:match.external_id,round:match.round??match.sequence_no,sequence:match.sequence_no,status:match.normalized_status,
        sides:domainSides as [MatchSide,MatchSide],pauseIntervals:pauseRows.map(pause=>({
          pausedAt:dateText(pause.started_at)!,resumedAt:dateText(pause.ended_at),reason:pause.reason,
        })),version:Number(match.version),
        ...(match.start_time?{startTime:dateText(match.start_time)!}:{}),
        ...(match.completed_at?{endTime:dateText(match.completed_at)!}:{}),
      });
    }
    const events=await tx.query<{round_no:number;event_type:'bye'|'rest';subject_type:'player'|'fixed_team';subject_id:string;player_name_snapshot:string}>(
      `SELECT round_no,event_type,subject_type,subject_id,player_name_snapshot FROM tournament_schedule_events
       WHERE tournament_id=$1 AND owner_id=$2 ORDER BY round_no,sequence_no,subject_id`,[row.id,ownerId],
    );
    const state:TournamentState={
      id:row.public_id,mode:row.mode,status:row.status,participants,
      seed:row.seed??'',generatorVersion:row.generator_version??'1',pausedPlayerIds:Array.from(row.paused_player_ids??[]),matches,
      version:Number(row.version),...(row.started_at?{startedAt:dateText(row.started_at)!}:{}),
      ...(row.paused_at?{pausedAt:dateText(row.paused_at)!}:{}),...(row.completed_at?{completedAt:dateText(row.completed_at)!}:{}),
      ...(row.cancelled_at?{cancelledAt:dateText(row.cancelled_at)!}:{}),
    };
    if(fixedTeams.length)state.fixedTeams=fixedTeams;
    return {row,state,fixedTeams,fixedEntries,scheduleEvents:events.map(event=>({round:event.round_no,eventType:event.event_type,subjectType:event.subject_type,subjectId:event.subject_id,name:event.player_name_snapshot}))};
  }

  private tournamentValue(loaded:LoadedTournament):Record<string,unknown>{
    const {row,state,fixedEntries}=loaded;
    const participants=state.mode==='2v2_fixed'&&fixedEntries.length
      ? fixedEntries.map(entry=>({id:entry.teamId,name:entry.name,kind:'team',players:entry.playerIds.map(id=>({id,name:state.participants.find(player=>player.id===id)?.name??id}))}))
      : state.participants.map(player=>({id:player.id,name:player.name,kind:'player'}));
    const current=state.matches.find(match=>match.status==='in_progress'||match.status==='paused')??state.matches.find(match=>match.status==='scheduled');
    return {id:row.public_id,name:row.name,mode:row.mode,status:row.status,participants,pausedPlayerIds:state.pausedPlayerIds,
      version:Number(row.version),seed:row.seed,generatorVersion:row.generator_version,currentMatchId:current?.id??null,
      startedAt:dateText(row.started_at),pausedAt:dateText(row.paused_at),completedAt:dateText(row.completed_at),cancelledAt:dateText(row.cancelled_at),
      createdAt:dateText(row.created_at),updatedAt:dateText(row.updated_at)};
  }

  private async tournamentResult<T>(tx:Queryable,ownerId:string,id?:string,lock=false):Promise<{loaded:LoadedTournament;result:StoreResult<T>}>{
    const loaded=await this.loadTournament(tx,ownerId,id,lock);
    return {loaded,result:{value:this.tournamentValue(loaded) as T,etag:quoteEtag(Number(loaded.row.version))}};
  }

  private async getTournamentResult<T>(tx:Queryable,ownerId:string,id?:string):Promise<StoreResult<T>>{
    return (await this.tournamentResult<T>(tx,ownerId,id)).result;
  }

  private async rosterFromInput(tx:Queryable,ownerId:string,mode:TournamentMode,input:Record<string,unknown>):Promise<{participants:Participant[];fixedTeams:FixedTeam[];entries:LoadedTournament['fixedEntries']}>{
    if(mode!=='2v2_fixed'){
      const players=await this.ownedPlayers(tx,ownerId,input.playerIds,mode==='1v1'?2:4,32);
      return {participants:players.map(player=>({id:String(player.id),name:player.name})),fixedTeams:[],entries:[]};
    }
    const ids=ensureIds(input.teamIds);
    if(ids.length<2||ids.length>16)throw new StoreValidationError([{pointer:'/teamIds',code:'array-size',message:'Fixed-team roster size is invalid.'}]);
    const teamRows=await tx.query<TeamRow>(
      `SELECT id::text,owner_id::text,name,name_key,created_at,updated_at,version,deleted_at FROM teams
       WHERE owner_id=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[]) FOR UPDATE`,[ownerId,ids],
    );
    if(teamRows.length!==new Set(ids).size)throw new StoreNotFoundError();
    const participantsMap=new Map<string,Participant>();const fixedTeams:FixedTeam[]=[];const entries:LoadedTournament['fixedEntries']=[];
    for(const team of teamRows){
      const members=await tx.query<{player_id:number;name:string;position:number}>(
        `SELECT p.id player_id,p.name,tm.position FROM team_members tm JOIN players p ON p.id=tm.player_id
         WHERE tm.team_id=$1 AND tm.owner_id=$2 AND p.deleted_at IS NULL ORDER BY tm.position`,[team.id,ownerId],
      );
      if(members.length!==2)throw new StoreConflictError();
      const playerIds=members.map(member=>String(member.player_id)) as [string,string];
      for(let index=0;index<members.length;index++)participantsMap.set(playerIds[index]!,{id:playerIds[index]!,name:members[index]!.name});
      fixedTeams.push({id:team.id,name:team.name,playerIds});
      entries.push({id:team.id,teamId:team.id,name:team.name,playerIds});
    }
    return {participants:Array.from(participantsMap.values()),fixedTeams,entries};
  }

  private async insertTournamentRoster(tx:Queryable,ownerId:string,tournamentId:number,rows:{participants:Participant[];fixedTeams:FixedTeam[];entries:LoadedTournament['fixedEntries']}):Promise<void>{
    const enrollmentIds=new Map<string,string>();
    for(let i=0;i<rows.participants.length;i++){
      const player=rows.participants[i]!;const playerId=Number(player.id);
      const id=randomUUID();
      await tx.execute(
        `INSERT INTO tournament_enrollments (id,tournament_id,owner_id,player_id,player_name_snapshot,seed)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id,tournamentId,ownerId,Number.isSafeInteger(playerId)?playerId:null,player.name,i+1],
      );
      enrollmentIds.set(player.id,id);
    }
    if(rows.fixedTeams.length){
      for(let i=0;i<rows.entries.length;i++){
        const entry=rows.entries[i]!;const id=randomUUID();
        await tx.execute(
          `INSERT INTO fixed_team_entries (id,tournament_id,owner_id,entry_number,team_id,team_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6)`,[id,tournamentId,ownerId,i+1,entry.teamId,entry.name],
        );
        for(let position=0;position<2;position++){
          const playerId=entry.playerIds[position]!;
          await tx.execute(
            `INSERT INTO fixed_team_entry_members (fixed_team_entry_id,tournament_id,owner_id,position,player_id,player_name_snapshot,enrollment_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id,tournamentId,ownerId,position+1,Number(playerId),rows.participants.find(p=>p.id===playerId)?.name??playerId,enrollmentIds.get(playerId)??null],
          );
        }
      }
    }
  }

  private async createTournament<T>(tx:Queryable,ownerId:string,inputValue?:Readonly<Record<string,unknown>>):Promise<StoreResult<T>>{
    const input=record(inputValue);const mode=text(input.mode) as TournamentMode;
    const roster=await this.rosterFromInput(tx,ownerId,mode,input);
    const seed=typeof input.seed==='string'?input.seed:randomUUID();
    const generatorVersion=GENERATOR_VERSION;
    try { validateTournamentInput(mode,roster.participants,{...(mode==='2v2_fixed'?{fixedTeams:roster.fixedTeams}:{}),seed,generatorVersion}).forEach(issue=>{throw new DomainValidationError([issue]);}); }
    catch(error){if(error instanceof DomainValidationError)throw mapValidation(error);throw error;}
    const publicId=randomUUID();
    const inserted=await tx.query<TournamentRow>(
      `INSERT INTO tournaments (public_id,owner_id,name,mode,status,version,seed,generator_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'draft',1,$5,$6,now(),now())
       RETURNING id,public_id::text,owner_id::text,name,mode,status,version,seed,generator_version,paused_player_ids,created_at,updated_at,started_at,paused_at,completed_at,cancelled_at`,
      [publicId,ownerId,normalizedName(text(input.name),100).display,mode,seed,generatorVersion],
    );
    const tournament=inserted[0];if(!tournament)throw new StoreUnavailableError();
    await this.insertTournamentRoster(tx,ownerId,tournament.id,roster);
    const loaded=await this.loadTournament(tx,ownerId,tournament.public_id);
    return {status:201,value:this.tournamentValue(loaded) as T,etag:quoteEtag(Number(tournament.version))};
  }

  private async listTournaments<T>(tx:Queryable,ownerId:string,query?:StoreRequest['query']):Promise<StoreResult<T>>{
    const limit=Math.min(100,Math.max(1,integer(query?.limit,25)));const cursor=cursorDecode(query?.cursor);
    const cursorId=cursor&&/^\d+$/.test(cursor)?Number(cursor):0;
    if(query?.cursor!==undefined&&(!cursorId||!Number.isSafeInteger(cursorId)))throw new StoreValidationError([{pointer:'/cursor',code:'invalid-cursor',message:'Cursor is invalid.'}]);
    const statuses=Array.isArray(query?.status)?query!.status as readonly string[]:[];
    const rows=await tx.query<TournamentRow>(
      `SELECT id,public_id::text,owner_id::text,name,mode,status,version,seed,generator_version,paused_player_ids,created_at,updated_at,started_at,paused_at,completed_at,cancelled_at
       FROM tournaments WHERE owner_id=$1 AND deleted_at IS NULL AND id>$2
         AND (cardinality($3::text[])=0 OR status=ANY($3::text[])) ORDER BY id LIMIT $4`,[ownerId,cursorId,statuses,limit+1],
    );
    const pageRows=rows.slice(0,limit);const items=[];
    for(const row of pageRows){const loaded=await this.loadTournament(tx,ownerId,row.public_id);items.push(this.tournamentValue(loaded));}
    return {value:{items,nextCursor:rows.length>limit?cursorEncode(pageRows[pageRows.length-1]!.id):null} as T};
  }

  private async replaceTournamentRoster(tx:Queryable,ownerId:string,loaded:LoadedTournament,roster:{participants:Participant[];fixedTeams:FixedTeam[];entries:LoadedTournament['fixedEntries']}):Promise<void>{
    await tx.execute(`DELETE FROM fixed_team_entries WHERE tournament_id=$1 AND owner_id=$2`,[loaded.row.id,ownerId]);
    await tx.execute(`DELETE FROM tournament_enrollments WHERE tournament_id=$1 AND owner_id=$2`,[loaded.row.id,ownerId]);
    await this.insertTournamentRoster(tx,ownerId,loaded.row.id,roster);
  }

  private async updateDraft<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(loaded.row.version));
    if(loaded.row.status!=='draft')throw new StoreConflictError();
    const input=record(request.input);const mode=(input.mode??loaded.row.mode) as TournamentMode;
    if(!['1v1','2v2_fixed','2v2_rotating'].includes(mode))throw new StoreValidationError([{pointer:'/mode',code:'invalid-mode',message:'Unsupported tournament mode.'}]);
    let roster:{participants:Participant[];fixedTeams:FixedTeam[];entries:LoadedTournament['fixedEntries']};
    const rosterChanged=mode!==loaded.row.mode||input.playerIds!==undefined||input.teamIds!==undefined;
    if(rosterChanged){
      roster=await this.rosterFromInput(tx,ownerId,mode,input);
    }else roster={participants:loaded.state.participants.filter(p=>!p.id.startsWith('snapshot:')),fixedTeams:loaded.fixedTeams,entries:loaded.fixedEntries};
    const seed=loaded.row.seed??'';const generatorVersion=loaded.row.generator_version??'1';
    const issues=validateTournamentInput(mode,roster.participants,{...(mode==='2v2_fixed'?{fixedTeams:roster.fixedTeams}:{}),seed,generatorVersion});
    if(issues.length)throw mapValidation(new DomainValidationError(issues));
    const name=input.name===undefined?loaded.row.name:normalizedName(text(input.name),100).display;
    if(rosterChanged)await this.replaceTournamentRoster(tx,ownerId,loaded,roster);
    const updated=await tx.query<TournamentRow>(
      `UPDATE tournaments SET name=$1,mode=$2,version=version+1,updated_at=now()
       WHERE id=$3 AND owner_id=$4 AND version=$5 AND status='draft'
       RETURNING id,public_id::text,owner_id::text,name,mode,status,version,seed,generator_version,paused_player_ids,created_at,updated_at,started_at,paused_at,completed_at,cancelled_at`,
      [name,mode,loaded.row.id,ownerId,loaded.row.version],
    );
    if(!updated[0])throw new StorePreconditionFailedError();
    const fresh=await this.loadTournament(tx,ownerId,updated[0].public_id);
    return {value:this.tournamentValue(fresh) as T,etag:quoteEtag(Number(updated[0].version))};
  }

  private async deleteDraft<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);assertEtag(request.expectedETag,Number(loaded.row.version));
    if(loaded.row.status!=='draft')throw new StoreConflictError();
    await tx.execute('DELETE FROM tournament_schedule_events WHERE tournament_id=$1 AND owner_id=$2',[loaded.row.id,ownerId]);
    await tx.execute('DELETE FROM fixed_team_entries WHERE tournament_id=$1 AND owner_id=$2',[loaded.row.id,ownerId]);
    await tx.execute('DELETE FROM tournament_enrollments WHERE tournament_id=$1 AND owner_id=$2',[loaded.row.id,ownerId]);
    await tx.execute('DELETE FROM matches WHERE tournament_id=$1 AND owner_id=$2',[loaded.row.id,ownerId]);
    const deleted=await tx.execute('DELETE FROM tournaments WHERE id=$1 AND owner_id=$2 AND status=\'draft\'',[loaded.row.id,ownerId]);
    if(!deleted)throw new StoreNotFoundError();
    return {status:204,value:null as T};
  }

  private async writeDomainMatch(tx:Queryable,ownerId:string,tournamentId:number,tournament:LoadedTournament,match:DomainMatch):Promise<void>{
    const existing=await tx.query<{id:number;public_id:string}>(
      `SELECT id,public_id::text FROM matches WHERE tournament_id=$1 AND owner_id=$2 AND external_id=$3 FOR UPDATE`,
      [tournamentId,ownerId,match.id],
    );
    const matchId=existing[0]?.id;
    const sideJson=match.sides.map(side=>({id:side.id,participants:side.players.map(player=>({id:player.id,name:player.name})),score:side.score}));
    let storedId=matchId;
    if(storedId===undefined){
      const generated=await tx.query<{id:number}>(
        `INSERT INTO matches (public_id,external_id,tournament_id,owner_id,sequence_no,round,normalized_status,status,
          winner_side,version,teams,mode,start_time,end_time,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10::jsonb,$11,$12,$13,$13) RETURNING id`,
        [randomUUID(),match.id,tournamentId,ownerId,match.sequence,match.round,match.status,this.winnerSide(match),match.version,
          JSON.stringify(sideJson),tournament.row.mode,match.startTime?new Date(match.startTime):null,match.endTime?new Date(match.endTime):null],
      );
      storedId=generated[0]?.id;
    }else{
      await tx.execute(
        `UPDATE matches SET round=$1,normalized_status=$2,status=$2,winner_side=$3,version=$4,teams=$5::jsonb,
          start_time=$6,end_time=$7,completed_at=$7 WHERE id=$8 AND tournament_id=$9 AND owner_id=$10`,
        [match.round,match.status,this.winnerSide(match),match.version,JSON.stringify(sideJson),
          match.startTime?new Date(match.startTime):null,match.endTime?new Date(match.endTime):null,storedId,tournamentId,ownerId],
      );
    }
    if(storedId===undefined)throw new StoreUnavailableError();
    for(let index=0;index<2;index++){
      const side=match.sides[index]!;
      await tx.execute(
        `INSERT INTO match_sides (match_id,tournament_id,owner_id,side_no,score,side_label,side_id,fixed_team_id,fixed_team_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (match_id,side_no) DO UPDATE SET score=EXCLUDED.score,side_label=EXCLUDED.side_label,
           side_id=EXCLUDED.side_id,fixed_team_id=EXCLUDED.fixed_team_id,fixed_team_name_snapshot=EXCLUDED.fixed_team_name_snapshot`,
        [storedId,tournamentId,ownerId,index+1,side.score,side.fixedTeamName??side.players.map(p=>p.name).join(' + '),side.id,
          side.fixedTeamId??null,side.fixedTeamName??null],
      );
      for(let position=0;position<side.players.length;position++){
        const player=side.players[position]!;
        const playerId=/^\d+$/.test(player.id)?Number(player.id):null;
        let enrollmentId:string|null=null;
        if(playerId!==null){
          const enrollments=await tx.query<{id:string}>(
            `SELECT id::text FROM tournament_enrollments WHERE tournament_id=$1 AND owner_id=$2 AND player_id=$3`,[tournamentId,ownerId,playerId],
          );
          enrollmentId=enrollments[0]?.id??null;
          if(!enrollmentId)throw new StoreNotFoundError();
        }
        await tx.execute(
          `INSERT INTO match_players (match_id,side_no,tournament_id,owner_id,position,player_id,enrollment_id,player_name_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (match_id,side_no,position) DO UPDATE SET player_name_snapshot=EXCLUDED.player_name_snapshot`,
          [storedId,index+1,tournamentId,ownerId,position+1,playerId,enrollmentId,player.name],
        );
      }
    }
    await tx.execute('DELETE FROM match_pause_intervals WHERE match_id=$1',[storedId]);
    for(const interval of match.pauseIntervals){
      await tx.execute(
        `INSERT INTO match_pause_intervals (id,match_id,started_at,ended_at,reason) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(),storedId,new Date(interval.pausedAt),interval.resumedAt?new Date(interval.resumedAt):null,interval.reason],
      );
    }
  }

  private winnerSide(match:DomainMatch):1|2|null{
    const one=match.sides[0]?.score;const two=match.sides[1]?.score;
    if(one===null||two===null||one===undefined||two===undefined||one===two)return null;
    return one>two?1:2;
  }

  private async persistScheduleEvents(tx:Queryable,ownerId:string,tournamentId:number,round:number,
    byeEvents:ReadonlyArray<{subjectType:'player'|'fixed_team';subjectId:string}>,restPlayerIds:readonly string[]):Promise<void>{
    for(const event of byeEvents){
      const entry=event.subjectType==='fixed_team'?await tx.query<{name:string;id:string}>(
        `SELECT team_name_snapshot name,id::text FROM fixed_team_entries WHERE tournament_id=$1 AND owner_id=$2
         AND (team_id::text=$3 OR id::text=$3) LIMIT 1`,[tournamentId,ownerId,event.subjectId],
      ):[];
      const player=event.subjectType==='player'?await tx.query<{name:string;id:number}>(
        `SELECT p.name,p.id FROM tournament_enrollments e LEFT JOIN players p ON p.id=e.player_id
         WHERE e.tournament_id=$1 AND e.owner_id=$2 AND e.player_id::text=$3 LIMIT 1`,[tournamentId,ownerId,event.subjectId],
      ):[];
      const name=event.subjectType==='fixed_team'?entry[0]?.name:player[0]?.name;
      const enrollment=event.subjectType==='player'?await tx.query<{id:string}>(
        'SELECT id::text FROM tournament_enrollments WHERE tournament_id=$1 AND owner_id=$2 AND player_id::text=$3 LIMIT 1',[tournamentId,ownerId,event.subjectId],
      ):[];
      await tx.execute(
        `INSERT INTO tournament_schedule_events (id,tournament_id,owner_id,sequence_no,event_type,subject_type,subject_id,round_no,enrollment_id,player_name_snapshot)
         VALUES ($1,$2,$3,$4,'bye',$5,$6,$4,$7,$8) ON CONFLICT DO NOTHING`,
        [randomUUID(),tournamentId,ownerId,round,event.subjectType,event.subjectId,enrollment[0]?.id??null,name??event.subjectId],
      );
    }
    for(const playerId of restPlayerIds){
      const player=await tx.query<{name:string;id:string}>(
        `SELECT e.player_name_snapshot name,e.id::text FROM tournament_enrollments e
         WHERE e.tournament_id=$1 AND e.owner_id=$2 AND e.player_id::text=$3 LIMIT 1`,[tournamentId,ownerId,playerId],
      );
      await tx.execute(
        `INSERT INTO tournament_schedule_events (id,tournament_id,owner_id,sequence_no,event_type,subject_type,subject_id,round_no,enrollment_id,player_name_snapshot)
         VALUES ($1,$2,$3,$4,'rest','player',$5,$4,$6,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(),tournamentId,ownerId,round,playerId,player[0]?.id??null,player[0]?.name??playerId],
      );
    }
  }

  private async updateTournamentState(tx:Queryable,ownerId:string,loaded:LoadedTournament,state:TournamentState):Promise<TournamentRow>{
    const updated=await tx.query<TournamentRow>(
      `UPDATE tournaments SET status=$1,version=$2,seed=$3,generator_version=$4,paused_player_ids=$5::text[],
        started_at=$6,paused_at=$7,completed_at=$8,cancelled_at=$9,updated_at=now()
       WHERE id=$10 AND owner_id=$11 AND version=$12
       RETURNING id,public_id::text,owner_id::text,name,mode,status,version,seed,generator_version,paused_player_ids,created_at,updated_at,started_at,paused_at,completed_at,cancelled_at`,
      [state.status,state.version,state.seed,state.generatorVersion,state.pausedPlayerIds,
        state.startedAt?new Date(state.startedAt):null,state.pausedAt?new Date(state.pausedAt):null,
        state.completedAt?new Date(state.completedAt):null,state.cancelledAt?new Date(state.cancelledAt):null,
        loaded.row.id,ownerId,loaded.row.version],
    );
    if(!updated[0])throw new StorePreconditionFailedError();
    return updated[0];
  }

  private async startTournamentOperation<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(loaded.row.version));
    const started=startTournament(loaded.state,new Date().toISOString());
    for(const match of started.tournament.matches)await this.writeDomainMatch(tx,ownerId,loaded.row.id,loaded,match);
    if(started.schedule){
      for(const round of started.schedule.rounds){
        for(const event of round.byeEvents)await this.persistScheduleEvents(tx,ownerId,loaded.row.id,round.round,[event],[]);
        if(round.restPlayerIds.length)await this.persistScheduleEvents(tx,ownerId,loaded.row.id,round.round,[],round.restPlayerIds);
      }
    }
    if(started.nextMatch){
      await this.writeDomainMatch(tx,ownerId,loaded.row.id,loaded,started.nextMatch.match);
      await this.persistScheduleEvents(tx,ownerId,loaded.row.id,started.nextMatch.match.sequence,[],started.nextMatch.restPlayerIds);
    }
    const updated=await this.updateTournamentState(tx,ownerId,loaded,started.tournament);
    const fresh=await this.loadTournament(tx,ownerId,updated.public_id);
    return {value:this.tournamentValue(fresh) as T,etag:quoteEtag(Number(updated.version))};
  }

  private async tournamentTransition<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(loaded.row.version));
    const now=new Date().toISOString();let state:TournamentState;
    if(request.operation==='tournaments.cancel')state=cancelTournament(loaded.state,now);
    else if(request.operation==='tournaments.pause')state=pauseTournament(loaded.state,now);
    else if(request.operation==='tournaments.resume')state=resumeTournament(loaded.state,now);
    else state=finishTournament(loaded.state,now);
    const updated=await this.updateTournamentState(tx,ownerId,loaded,state);
    const fresh=await this.loadTournament(tx,ownerId,updated.public_id);
    return {value:this.tournamentValue(fresh) as T,etag:quoteEtag(Number(updated.version))};
  }

  private async updateAvailability<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(loaded.row.version));
    const input=record(request.input);const paused=ensureIds(input.pausedPlayerIds);
    const rosterIds=new Set(loaded.state.participants.map(player=>player.id));
    if(paused.some(id=>!rosterIds.has(id)))throw new StoreNotFoundError();
    const current=loaded.state.matches.find(match=>match.status==='in_progress');
    const update=updatePlayerAvailability(loaded.state,paused,current,new Date().toISOString());
    const state={...loaded.state,pausedPlayerIds:update.pausedPlayerIds,version:loaded.state.version+1};
    if(update.match){
      state.matches=state.matches.map(match=>match.id===update.match!.id?update.match!:match);
      await this.writeDomainMatch(tx,ownerId,loaded.row.id,loaded,update.match);
    }
    const updated=await this.updateTournamentState(tx,ownerId,loaded,state);
    const fresh=await this.loadTournament(tx,ownerId,updated.public_id);
    return {value:this.tournamentValue(fresh) as T,etag:quoteEtag(Number(updated.version))};
  }

  private matchValue(match:DomainMatch,createdAt:Date):Record<string,unknown>{
    return {id:match.id,round:match.round,sequence:match.sequence,status:match.status,
      sides:match.sides.map((side,index)=>({participantId:side.fixedTeamId??side.id,name:side.fixedTeamName??side.players.map(player=>player.name).join(' + '),
        players:side.players.map(player=>({id:player.id,name:player.name})),score:side.score})),
      winnerSide:this.winnerSide(match),startTime:match.startTime??null,endTime:match.endTime??null,
      pauseIntervals:match.pauseIntervals,version:match.version,createdAt:dateText(createdAt)};
  }

  private async matchCreatedAt(tx:Queryable,tournamentId:number,ownerId:string,externalId:string):Promise<Date>{
    const rows=await tx.query<{created_at:Date}>(
      `SELECT created_at FROM matches WHERE tournament_id=$1 AND owner_id=$2 AND external_id=$3`,[tournamentId,ownerId,externalId],
    );
    if(!rows[0])throw new StoreNotFoundError();return rows[0].created_at;
  }

  private async listMatches<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId);
    const query=request.query;const limit=Math.min(100,Math.max(1,integer(query?.limit,25)));
    const cursor=cursorDecode(query?.cursor);const sequenceCursor=cursor&&/^\d+$/.test(cursor)?Number(cursor):0;
    if(query?.cursor!==undefined&&(!sequenceCursor||!Number.isSafeInteger(sequenceCursor)))throw new StoreValidationError([{pointer:'/cursor',code:'invalid-cursor',message:'Cursor is invalid.'}]);
    const statuses=Array.isArray(query?.status)?query!.status as readonly string[]:[];
    const matchRows=await tx.query<{external_id:string;sequence_no:number;created_at:Date}>(
      `SELECT external_id,sequence_no,created_at FROM matches WHERE tournament_id=$1 AND owner_id=$2
       AND sequence_no>$3 AND (cardinality($4::text[])=0 OR normalized_status=ANY($4::text[])) ORDER BY sequence_no LIMIT $5`,
      [loaded.row.id,ownerId,sequenceCursor,statuses,limit+1],
    );
    const pageRows=matchRows.slice(0,limit);const items=[];
    for(const row of pageRows){const match=loaded.state.matches.find(item=>item.id===row.external_id);if(match)items.push(this.matchValue(match,row.created_at));}
    return {value:{items,nextCursor:matchRows.length>limit?cursorEncode(pageRows[pageRows.length-1]!.sequence_no):null} as T};
  }

  private async getMatchResult<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId);
    const match=loaded.state.matches.find(candidate=>candidate.id===request.matchId);
    if(!match)throw new StoreNotFoundError();
    const createdAt=await this.matchCreatedAt(tx,loaded.row.id,ownerId,match.id);
    return {value:this.matchValue(match,createdAt) as T,etag:quoteEtag(Number(loaded.row.version))};
  }

  private async matchOperation<T>(tx:Queryable,ownerId:string,request:StoreRequest):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,request.resourceId,true);
    assertEtag(request.expectedETag,Number(loaded.row.version));
    const selected=loaded.state.matches.find(match=>match.id===request.matchId);
    if(!selected)throw new StoreNotFoundError();
    let updatedMatch:DomainMatch;
    const now=new Date().toISOString();
    switch(request.operation){
      case 'matches.start':updatedMatch=startMatch(selected,loaded.state.status,loaded.state.pausedPlayerIds,loaded.state.matches,now);break;
      case 'matches.pause':updatedMatch=pauseMatch(selected,loaded.state.status,now);break;
      case 'matches.resume':updatedMatch=resumeMatch(selected,loaded.state.status,loaded.state.pausedPlayerIds,now);break;
      case 'matches.skip':updatedMatch=skipMatch(selected,loaded.state.status,now);break;
      case 'matches.recordResult':{
        const rawScores=record(request.input).scores;
        const scores=Array.isArray(rawScores)?rawScores.map(Number):[];
        if(scores.length!==2||scores.some(score=>!Number.isSafeInteger(score)||score<0||score>1_000_000))throw new StoreValidationError([{pointer:'/scores',code:'invalid-score',message:'Exactly two bounded integer scores are required.'}]);
        updatedMatch=selected.status==='completed'
          ?correctMatchScore(selected,scores as [number,number],loaded.state.status,now)
          :completeMatch(selected,scores as [number,number],loaded.state.status,now,loaded.state.pausedPlayerIds);
        break;
      }
      default:throw new StoreUnavailableError();
    }
    let matches=loaded.state.matches.map(match=>match.id===updatedMatch.id?updatedMatch:match);
    let nextMatch:DomainMatch|undefined;
    let restPlayerIds:string[]=[];
    if(loaded.state.mode==='2v2_rotating'&&(updatedMatch.status==='completed'||updatedMatch.status==='skipped')){
      const generated=generateNextRotatingMatch(matches,loaded.state.participants,loaded.state.pausedPlayerIds,loaded.state.seed,loaded.state.generatorVersion);
      if(generated){nextMatch=generated.match;restPlayerIds=generated.restPlayerIds;matches=matches.concat(nextMatch);}
    }
    const state={...loaded.state,matches,version:loaded.state.version+1};
    await this.writeDomainMatch(tx,ownerId,loaded.row.id,loaded,updatedMatch);
    if(nextMatch){
      await this.writeDomainMatch(tx,ownerId,loaded.row.id,loaded,nextMatch);
      await this.persistScheduleEvents(tx,ownerId,loaded.row.id,nextMatch.sequence,[],restPlayerIds);
    }
    const updated=await this.updateTournamentState(tx,ownerId,loaded,state);
    const createdAt=await this.matchCreatedAt(tx,loaded.row.id,ownerId,updatedMatch.id);
    const matchValue=this.matchValue(updatedMatch,createdAt);
    if(request.operation==='matches.recordResult'){
      return {value:{match:matchValue,tournamentVersion:Number(updated.version)} as T,etag:quoteEtag(Number(updated.version))};
    }
    return {value:matchValue as T,etag:quoteEtag(Number(updated.version))};
  }

  private async getSchedule<T>(tx:Queryable,ownerId:string,id?:string):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,id);
    const rounds=new Map<number,{round:number;matchIds:string[];byeEvents:Array<{subjectType:string;subjectId:string}>;restPlayerIds:string[]}>();
    const getRound=(round:number)=>{
      let value=rounds.get(round);if(!value){value={round,matchIds:[],byeEvents:[],restPlayerIds:[]};rounds.set(round,value);}return value;
    };
    for(const match of loaded.state.matches)getRound(match.round).matchIds.push(match.id);
    for(const event of loaded.scheduleEvents){
      const round=getRound(event.round);
      if(event.eventType==='bye')round.byeEvents.push({subjectType:event.subjectType,subjectId:event.subjectId});
      else if(event.subjectType==='player')round.restPlayerIds.push(event.subjectId);
    }
    return {value:{tournamentId:loaded.row.public_id,seed:loaded.row.seed,generatorVersion:loaded.row.generator_version,
      rounds:Array.from(rounds.values()).sort((a,b)=>a.round-b.round)} as T,etag:quoteEtag(Number(loaded.row.version))};
  }

  private async getStandings<T>(tx:Queryable,ownerId:string,id?:string,query?:StoreRequest['query']):Promise<StoreResult<T>>{
    const loaded=await this.loadTournament(tx,ownerId,id);const view=text(query?.view);
    if(view!=='players'&&view!=='teams')throw new StoreValidationError([{pointer:'/view',code:'invalid-view',message:'Standings view is invalid.'}]);
    const standings=recalculateTournamentStandings(loaded.state.mode,loaded.state.participants,loaded.state.matches,loaded.fixedTeams);
    return {value:{scope:'tournament',view,tournamentId:loaded.row.public_id,tournamentVersion:Number(loaded.row.version),
      rows:serializeStandingRows(view==='players'?standings.players:standings.teams),calculatedAt:new Date().toISOString()} as T,etag:quoteEtag(Number(loaded.row.version))};
  }

  private async getOverallStandings<T>(tx:Queryable,ownerId:string,query?:StoreRequest['query']):Promise<StoreResult<T>>{
    const view=text(query?.view);
    if(view!=='players'&&view!=='teams')throw new StoreValidationError([{pointer:'/view',code:'invalid-view',message:'Standings view is invalid.'}]);
    const ids=await tx.query<{public_id:string}>(`SELECT public_id::text FROM tournaments WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`,[ownerId]);
    const histories=[];
    for(const item of ids){
      const loaded=await this.loadTournament(tx,ownerId,item.public_id);
      histories.push({mode:loaded.state.mode,participants:loaded.state.participants,matches:loaded.state.matches,fixedTeams:loaded.fixedTeams});
    }
    const players=await tx.query<{id:number;name:string}>(`SELECT id,name FROM players WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY id`,[ownerId]);
    const overall=computeOverallStandings({tournaments:histories,players:players.map(player=>({id:String(player.id),name:player.name}))});
    const rows=serializeStandingRows(view==='players'?overall.players:overall.teams);
    const fingerprint=createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0,32);
    return {value:{scope:'overall',view,tournamentId:null,tournamentVersion:null,rows,
      calculatedAt:new Date().toISOString()} as T,etag:`overall-${fingerprint}`};
  }

  async close():Promise<void>{await this.database.close();}
}

/** Construct the API store without opening a connection; Pool connects on first query. */
export function createPostgresApiStore(env?:NodeJS.ProcessEnv):ApiStore{
  const config=postgresPoolConfig(env??process.env);
  return new PostgresApiStore(new PostgresDatabase(config));
}
