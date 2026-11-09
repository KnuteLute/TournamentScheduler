import * as assert from 'assert';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { ApiStore, StoreOperation, StoreRequest, StoreResult, StoreConflictError, StoreNotFoundError, StorePreconditionFailedError, VerifiedActor } from '../src/services/ports';
import { PostgresApiStore } from '../src/persistence/api-store';
import { PostgresDatabase, postgresPoolConfig } from '../src/persistence/database';
import { canonicalizeName } from '../src/domain/names';

type Actor = VerifiedActor;
type Result = StoreResult<Record<string, any>>;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function actorFrom(session: { id: string; ownerId: string; kind: 'guest' | 'authenticated'; account: { id: string; username: string } | null }): Actor {
  return { sessionId: session.id, ownerId: session.ownerId, kind: session.kind, account: session.account };
}

function request(
  operation: StoreOperation,
  actor: Actor | null,
  options: Partial<StoreRequest> = {},
  idempotencyKey = randomUUID(),
): StoreRequest {
  const input = options.input ?? {};
  return {
    operation,
    actor,
    ...options,
    ...(operation === 'session.createGuest' ? {} : {
      idempotency: options.idempotency ?? {
        key: idempotencyKey,
        requestHash: hash(JSON.stringify({ operation, input, resourceId: options.resourceId, matchId: options.matchId })),
        anchor: operation === 'auth.register' ? 'new-owner' : operation === 'auth.login' ? 'verified-owner' : 'actor-owner',
      },
    }),
  } as StoreRequest;
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_TEST_DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !url) throw new Error('Set NODE_ENV=test and POSTGRES_TEST_DATABASE_URL to an isolated migrated test database');
  const parsedUrl = new URL(url);
  if (!decodeURIComponent(parsedUrl.pathname).toLowerCase().includes('test')) throw new Error('Test database name must contain "test"');

  const database = new PostgresDatabase(postgresPoolConfig({ POSTGRES_URL: url, NODE_ENV: 'test', DB_POOL_MAX: '4' }));
  const store: ApiStore = new PostgresApiStore(database);
  const covered = new Set<StoreOperation>();
  const call = async (value: StoreRequest): Promise<Result> => {
    covered.add(value.operation);
    return await store.execute(value) as Result;
  };
  const mutate = async (
    operation: StoreOperation,
    actor: Actor | null,
    options: Partial<StoreRequest> = {},
    key = randomUUID(),
  ) => call(request(operation, actor, options, key));
  const credential = () => ({ sessionTokenHash: randomBytes(32), csrfTokenHash: randomBytes(32), sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000) });

  try {
    const migrations = await database.query<{ max_version: number | null }>('SELECT max(version) AS max_version FROM schema_migrations');
    if (Number(migrations[0]?.max_version ?? 0) < 4) throw new Error('Test database is not migrated through version 4');

    // Account registration, credential lookup, session lookup, and auth retry
    // prove that retries create new hashes and never replay old token material.
    const username = `persist-${randomUUID().slice(0, 8)}`;
    const usernameKey = canonicalizeName(username);
    const registrationCredentials={...credential(),passwordHash:`$2b$10$${'a'.repeat(53)}`};
    const registered = await mutate('auth.register', null, {
      input: { username, usernameKey }, credentials: registrationCredentials,
    });
    assert.strictEqual(registered.status, 201);
    const account = await store.findAccountByUsernameKey(usernameKey);
    assert.ok(account);
    const registeredOwner = account!.ownerId;
    assert.ok(account!.passwordHash.startsWith('$2b$10$'));
    const registeredSessionRows = await database.query<{ id: string }>(
      `SELECT id::text FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [Number(account!.id)],
    );
    assert.ok(registeredSessionRows[0]);
    assert.ok(await store.lookupSessionByTokenHash(registrationCredentials.sessionTokenHash,new Date()));

    const loginKey = randomUUID();
    const loginHashA = randomBytes(32);
    const loginHashB = randomBytes(32);
    const loginCredentialsA = { ...credential(), sessionTokenHash: loginHashA };
    const loginRequestOptions: Partial<StoreRequest> = { input: { username, usernameKey } };
    const loginIdem = { key: loginKey, requestHash: hash(`login:${usernameKey}`), anchor: 'verified-owner' as const };
    const loginA = await call(request('auth.login', null, { ...loginRequestOptions, credentials: loginCredentialsA, idempotency: loginIdem }));
    const loginSessionA = await store.lookupSessionByTokenHash(loginHashA, new Date());
    assert.ok(loginSessionA);
    const loginB = await call(request('auth.login', null, { ...loginRequestOptions, credentials: { ...credential(), sessionTokenHash: loginHashB }, idempotency: loginIdem }));
    assert.ok(loginB.value.session);
    assert.strictEqual(await store.lookupSessionByTokenHash(loginHashA, new Date()), null, 'same idempotency retry revokes the stale session hash');
    assert.ok(await store.lookupSessionByTokenHash(loginHashB, new Date()), 'same idempotency retry establishes a fresh session');
    const accountSession = await store.lookupSessionByTokenHash(loginHashB,new Date());assert.ok(accountSession);
    const accountActor=actorFrom(accountSession!);

    // Guest session collision, explicit rollback on missing resolution, then
    // successful ownership cascade over teams, entries, enrollments, matches,
    // sides, and participant snapshots.
    const targetPlayerA = await mutate('players.create', accountActor, { input: { name: 'Shared Player' } });
    const targetPlayerB = await mutate('players.create', accountActor, { input: { name: 'Target Player' } });
    const targetTeam = await mutate('teams.create', accountActor, { input: { name: 'Shared Team', playerIds: [targetPlayerA.value.id, targetPlayerB.value.id] } });
    const archivedTournamentId=randomUUID();
    const archivedTournament=await database.query<{id:number}>(
      `INSERT INTO tournaments (public_id,owner_id,user_id,name,mode,status,version,seed,generator_version,completed_at)
       VALUES ($1,$2,$3,'Imported History','1v1','completed',1,'archived-seed','1',now()) RETURNING id`,
      [archivedTournamentId,registeredOwner,Number(account!.id)],
    );
    const archivedTournamentRowId=archivedTournament[0]!.id;
    const archivedMatchId=await database.query<{id:number}>(
      `INSERT INTO matches (public_id,external_id,tournament_id,owner_id,user_id,sequence_no,round,normalized_status,status,
        winner_side,version,teams,mode,end_time,completed_at)
       VALUES ($1,$2,$3,$4,$5,1,1,'completed','completed',1,1,$6::jsonb,'1v1',now(),now()) RETURNING id`,
      [randomUUID(),`unverified-${randomUUID()}`,archivedTournamentRowId,registeredOwner,Number(account!.id),JSON.stringify([
        {id:'legacy-side-1',participants:[{id:'unknown-old-player',name:'Unresolved Snapshot'}],score:4},
        {id:'legacy-side-2',participants:[{id:String(targetPlayerB.value.id),name:'Target Player'}],score:2},
      ])],
    );
    const archivedMatchRowId=archivedMatchId[0]!.id;
    for(let sideNo=1;sideNo<=2;sideNo++)await database.execute(
      `INSERT INTO match_sides (match_id,tournament_id,owner_id,side_no,score,side_label,side_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [archivedMatchRowId,archivedTournamentRowId,registeredOwner,sideNo,sideNo===1?4:2,`Archived ${sideNo}`,`legacy-side-${sideNo}`],
    );
    await database.execute(
      `INSERT INTO match_players (match_id,side_no,tournament_id,owner_id,position,player_id,enrollment_id,player_name_snapshot)
       VALUES ($1,1,$2,$3,1,NULL,NULL,'Unresolved Snapshot'),($1,2,$2,$3,1,$4,NULL,'Target Player')`,
      [archivedMatchRowId,archivedTournamentRowId,registeredOwner,Number(targetPlayerB.value.id)],
    );
    const legacyStatBaseline={games_played:71,wins:20,losses:12,draws:39,points_for:333,points_against:321,diff:12};
    await database.execute(
      `UPDATE players SET games_played=$1,wins=$2,losses=$3,draws=$4,points_for=$5,points_against=$6,diff=$7 WHERE id=$8 AND owner_id=$9`,
      [legacyStatBaseline.games_played,legacyStatBaseline.wins,legacyStatBaseline.losses,legacyStatBaseline.draws,
        legacyStatBaseline.points_for,legacyStatBaseline.points_against,legacyStatBaseline.diff,Number(targetPlayerA.value.id),registeredOwner],
    );
    const unresolvedSnapshot=await database.query<{count:string}>(
      `SELECT count(*)::text count FROM match_players WHERE match_id=$1 AND player_id IS NULL AND player_name_snapshot='Unresolved Snapshot'`,[archivedMatchRowId],
    );
    assert.strictEqual(Number(unresolvedSnapshot[0]?.count),1);
    const guestSessionHash = randomBytes(32);
    await call(request('session.createGuest', null, { credentials: { ...credential(), sessionTokenHash: guestSessionHash } }));
    const guestSession = await store.lookupSessionByTokenHash(guestSessionHash, new Date());
    assert.ok(guestSession);
    const guestActor = actorFrom(guestSession!);
    const guestPlayers = [] as string[];
    for (const name of ['Shared Player', 'Guest Two', 'Guest Three', 'Guest Four']) {
      const created = await mutate('players.create', guestActor, { input: { name } });
      guestPlayers.push(String(created.value.id));
    }
    const guestTeamA = await mutate('teams.create', guestActor, { input: { name: 'Shared Team', playerIds: guestPlayers.slice(0, 2) } });
    const guestTeamB = await mutate('teams.create', guestActor, { input: { name: 'Guest Team B', playerIds: guestPlayers.slice(2, 4) } });
    const guestTournament = await mutate('tournaments.create', guestActor, {
      input: { name: 'Guest Fixed', mode: '2v2_fixed', teamIds: [guestTeamA.value.id, guestTeamB.value.id], seed: 'transfer-test-seed' },
    });
    const guestTournamentId = String(guestTournament.value.id);
    const guestStarted = await mutate('tournaments.start', guestActor, { resourceId: guestTournamentId, expectedETag: `"${guestTournament.etag}"` });
    const guestOwnerCounts = await database.query<{ matches: number; sides: number; match_players: number }>(
      `SELECT (SELECT count(*)::integer FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$1::uuid)) matches,
        (SELECT count(*)::integer FROM match_sides WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$1::uuid))) sides,
        (SELECT count(*)::integer FROM match_players WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$1::uuid))) match_players`,
      [guestTournamentId],
    );
    assert.ok(Number(guestOwnerCounts[0]?.matches) > 0 && Number(guestOwnerCounts[0]?.sides) === 2 && Number(guestOwnerCounts[0]?.match_players) === 4);

    const guestLoginHash=randomBytes(32);
    const guestLogin=await mutate('auth.login',guestActor,{input:{username,usernameKey},credentials:{...credential(),sessionTokenHash:guestLoginHash}});
    assert.strictEqual(guestLogin.value.session.pendingGuestClaim,true);
    const pendingSession=await store.lookupSessionByTokenHash(guestLoginHash,new Date());assert.ok(pendingSession);
    const claimActor=actorFrom(pendingSession!);
    const claimStatus=await call(request('session.getClaimDetails',claimActor));
    assert.strictEqual(claimStatus.value.pending,true);assert.strictEqual(claimStatus.value.conflicts.length,2);

    const noResolution = request('session.claimGuest', claimActor, {
      input: { renames: [] }, expectedETag: `"${guestLogin.etag}"`,
    });
    await assert.rejects(() => call(noResolution), StoreConflictError);
    const guestStillOwned = await database.query<{ count: string }>('SELECT count(*)::text count FROM players WHERE owner_id=$1',[guestActor.ownerId]);
    assert.strictEqual(Number(guestStillOwned[0]?.count),4,'failed claim rolls back all ownership changes');

    let reachedDeferredCheck=false;
    await assert.rejects(()=>database.transaction(async tx=>{
      await tx.query('SET CONSTRAINTS ALL DEFERRED');
      await tx.execute('UPDATE players SET name_key=NULL WHERE owner_id=$1',[guestActor.ownerId]);
      await tx.execute('UPDATE players SET owner_id=$2,user_id=$3,guest_session_id=NULL WHERE owner_id=$1',
        [guestActor.ownerId,registeredOwner,Number(account!.id)]);
      // Releasing deferred checks before moving teams/tournaments must fail.
      reachedDeferredCheck=true;
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    }));
    assert.ok(reachedDeferredCheck,'composite owner changes are deferred until explicit check');
    const cascadeRollback=await database.query<{count:string}>(
      'SELECT count(*)::text count FROM players WHERE owner_id=$1 AND name_key IS NOT NULL',[guestActor.ownerId],
    );
    assert.strictEqual(Number(cascadeRollback[0]?.count),4,'deferred owner-cascade failure rolls all root changes back');

    const claim = await mutate('session.claimGuest', claimActor, {
      input: { renames: [
        { resourceType: 'player', guestResourceId: guestPlayers[0], newName: 'Shared Player Guest' },
        { resourceType: 'team', guestResourceId: guestTeamA.value.id, newName: 'Shared Team Guest' },
      ] }, expectedETag: `"${guestLogin.etag}"`,
    });
    assert.strictEqual(claim.value.status,'transferred');
    assert.strictEqual(claim.value.playersTransferred,4);
    assert.strictEqual(claim.value.teamsTransferred,2);
    assert.strictEqual(claim.value.tournamentsTransferred,1);
    assert.strictEqual(await store.lookupSessionByTokenHash(guestSessionHash,new Date()),null);
    const transferred=await database.query<{players:number;teams:number;enrollments:number;entries:number;matches:number;sides:number;participants:number}>(
      `SELECT
       (SELECT count(*)::integer FROM players WHERE owner_id=$1 AND id=ANY($2::integer[])) players,
       (SELECT count(*)::integer FROM teams WHERE owner_id=$1 AND id=ANY($3::uuid[])) teams,
       (SELECT count(*)::integer FROM tournament_enrollments WHERE owner_id=$1 AND tournament_id=(SELECT id FROM tournaments WHERE public_id=$4::uuid)) enrollments,
       (SELECT count(*)::integer FROM fixed_team_entries WHERE owner_id=$1 AND tournament_id=(SELECT id FROM tournaments WHERE public_id=$4::uuid)) entries,
       (SELECT count(*)::integer FROM matches WHERE owner_id=$1 AND tournament_id=(SELECT id FROM tournaments WHERE public_id=$4::uuid)) matches,
       (SELECT count(*)::integer FROM match_sides WHERE owner_id=$1 AND match_id IN (SELECT id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$4::uuid))) sides,
       (SELECT count(*)::integer FROM match_players WHERE owner_id=$1 AND match_id IN (SELECT id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$4::uuid))) participants`,
      [registeredOwner,guestPlayers.map(Number),[guestTeamA.value.id,guestTeamB.value.id],guestTournamentId],
    );
    assert.deepStrictEqual(transferred[0],{players:4,teams:2,enrollments:4,entries:2,matches:1,sides:2,participants:4});

    // Exercise every domain operation with fresh, owner-scoped requests.
    const actorSession=await store.lookupSessionByTokenHash(loginHashB,new Date());
    assert.ok(actorSession);const actor=actorFrom(actorSession!);
    const getSession=await call(request('session.get',actor));assert.strictEqual(getSession.value.version,1);
    const guestTournamentAfterTransfer=await call(request('tournaments.get',actor,{resourceId:guestTournamentId}));
    await mutate('tournaments.cancel',actor,{resourceId:guestTournamentId,expectedETag:`"${guestTournamentAfterTransfer.etag}"`});

    const playersList=await call(request('players.list',actor,{query:{limit:10}}));assert.ok(Array.isArray(playersList.value.items));
    await call(request('players.get',actor,{resourceId:String(targetPlayerA.value.id)}));
    const playerUpdated=await mutate('players.update',actor,{resourceId:String(targetPlayerA.value.id),expectedETag:`"${targetPlayerA.etag}"`,input:{name:'Shared Player Updated'}});
    await assert.rejects(()=>mutate('players.update',actor,{resourceId:String(targetPlayerA.value.id),expectedETag:`"${targetPlayerA.etag}"`,input:{name:'Stale Rename'}}),StorePreconditionFailedError);
    await assert.rejects(()=>mutate('players.update',actor,{resourceId:String(targetPlayerA.value.id),expectedETag:`"${targetPlayerA.etag}"`,input:{name:'Stale Rename'}}),StorePreconditionFailedError);
    const replayKey=randomUUID();const replayHash=hash('same-player-replay');
    const replayReq=request('players.update',actor,{resourceId:String(targetPlayerA.value.id),expectedETag:'"v1"',input:{name:'Shared Player Updated'},idempotency:{key:replayKey,requestHash:replayHash,anchor:'actor-owner'}});
    const firstReplay=await call(replayReq);const secondReplay=await call(replayReq);assert.deepStrictEqual(secondReplay,firstReplay);
    await assert.rejects(()=>call({...replayReq,idempotency:{key:replayKey,requestHash:hash('different'),anchor:'actor-owner'}}),StoreConflictError);

    const teamCreated=await mutate('teams.create',actor,{input:{name:'Test Team',playerIds:[String(targetPlayerA.value.id),String(targetPlayerB.value.id)]}});
    await call(request('teams.list',actor,{query:{limit:10}}));
    await call(request('teams.get',actor,{resourceId:String(teamCreated.value.id)}));
    const teamUpdated=await mutate('teams.update',actor,{resourceId:String(teamCreated.value.id),expectedETag:`"${teamCreated.etag}"`,input:{name:'Test Team Updated'}});
    await mutate('teams.delete',actor,{resourceId:String(teamCreated.value.id),expectedETag:`"${teamUpdated.etag}"`});

    const tournament=await mutate('tournaments.create',actor,{input:{name:'Round Robin',mode:'1v1',playerIds:[String(targetPlayerA.value.id),String(targetPlayerB.value.id),guestPlayers[1]],seed:'api-store-test-seed'}});
    await call(request('tournaments.list',actor,{query:{limit:10,status:['draft']}}));
    await call(request('tournaments.get',actor,{resourceId:String(tournament.value.id)}));
    const draftUpdated=await mutate('tournaments.updateDraft',actor,{resourceId:String(tournament.value.id),expectedETag:`"${tournament.etag}"`,input:{name:'Round Robin Updated'}});
    const started=await mutate('tournaments.start',actor,{resourceId:String(tournament.value.id),expectedETag:`"${draftUpdated.etag}"`});
    await call(request('tournaments.getSchedule',actor,{resourceId:String(tournament.value.id)}));
    await call(request('tournaments.getStandings',actor,{resourceId:String(tournament.value.id),query:{view:'players'}}));
    await call(request('tournaments.listMatches',actor,{resourceId:String(tournament.value.id),query:{limit:10}}));
    const matchId=String((await database.query<{external_id:string}>(`SELECT external_id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$1::uuid) ORDER BY sequence_no LIMIT 1`,[tournament.value.id]))[0]?.external_id);
    await call(request('matches.get',actor,{resourceId:String(tournament.value.id),matchId}));
    const matchStarted=await mutate('matches.start',actor,{resourceId:String(tournament.value.id),matchId,expectedETag:`"${started.etag}"`});
    const matchPaused=await mutate('matches.pause',actor,{resourceId:String(tournament.value.id),matchId,expectedETag:`"${matchStarted.etag}"`});
    const matchResumed=await mutate('matches.resume',actor,{resourceId:String(tournament.value.id),matchId,expectedETag:`"${matchPaused.etag}"`});
    const scored=await mutate('matches.recordResult',actor,{resourceId:String(tournament.value.id),matchId,expectedETag:`"${matchResumed.etag}"`,input:{scores:[4,2]}});
    assert.ok(scored.value.match);
    const statsAfterResult=await database.query<typeof legacyStatBaseline>(
      `SELECT games_played,wins,losses,draws,points_for,points_against,diff FROM players WHERE id=$1 AND owner_id=$2`,
      [Number(targetPlayerA.value.id),registeredOwner],
    );
    assert.deepStrictEqual(statsAfterResult[0],legacyStatBaseline,'new results must not overwrite unreconstructible legacy aggregates');
    await mutate('tournaments.updateAvailability',actor,{resourceId:String(tournament.value.id),expectedETag:`"${scored.etag}"`,input:{pausedPlayerIds:[]}});
    const secondMatch=String((await database.query<{external_id:string}>(`SELECT external_id FROM matches WHERE tournament_id=(SELECT id FROM tournaments WHERE public_id=$1::uuid) ORDER BY sequence_no OFFSET 1 LIMIT 1`,[tournament.value.id]))[0]?.external_id);
    const versionBeforeSkip=await call(request('tournaments.get',actor,{resourceId:String(tournament.value.id)}));
    const secondStarted=await mutate('matches.start',actor,{resourceId:String(tournament.value.id),matchId:secondMatch,expectedETag:`"${versionBeforeSkip.etag}"`});
    const skipped=await mutate('matches.skip',actor,{resourceId:String(tournament.value.id),matchId:secondMatch,expectedETag:`"${secondStarted.etag}"`});
    const pausedTournament=await mutate('tournaments.pause',actor,{resourceId:String(tournament.value.id),expectedETag:`"${skipped.etag}"`});
    const resumedTournament=await mutate('tournaments.resume',actor,{resourceId:String(tournament.value.id),expectedETag:`"${pausedTournament.etag}"`});
    await mutate('tournaments.finish',actor,{resourceId:String(tournament.value.id),expectedETag:`"${resumedTournament.etag}"`});
    await call(request('standings.getOverall',actor,{query:{view:'players'}}));

    const cancelDraft=await mutate('tournaments.create',actor,{input:{name:'Cancel Me',mode:'1v1',playerIds:[String(targetPlayerA.value.id),String(targetPlayerB.value.id)]}});
    const cancelStart=await mutate('tournaments.start',actor,{resourceId:String(cancelDraft.value.id),expectedETag:`"${cancelDraft.etag}"`});
    await mutate('tournaments.cancel',actor,{resourceId:String(cancelDraft.value.id),expectedETag:`"${cancelStart.etag}"`});
    const deleteDraft=await mutate('tournaments.create',actor,{input:{name:'Delete Draft',mode:'1v1',playerIds:[String(targetPlayerA.value.id),String(targetPlayerB.value.id)]}});
    await mutate('tournaments.deleteDraft',actor,{resourceId:String(deleteDraft.value.id),expectedETag:`"${deleteDraft.etag}"`});
    const guestTeamAfterClaim=await call(request('teams.get',actor,{resourceId:String(guestTeamB.value.id)}));
    await mutate('teams.delete',actor,{resourceId:String(guestTeamB.value.id),expectedETag:`"${guestTeamAfterClaim.etag}"`});
    const playerForDelete=await call(request('players.get',actor,{resourceId:guestPlayers[3]!}));
    await mutate('players.delete',actor,{resourceId:guestPlayers[3]!,expectedETag:`"${playerForDelete.etag}"`});

    const foreignHash=randomBytes(32);
    await call(request('session.createGuest',null,{credentials:{...credential(),sessionTokenHash:foreignHash}}));
    const foreignSession=await store.lookupSessionByTokenHash(foreignHash,new Date());assert.ok(foreignSession);
    const foreignActor=actorFrom(foreignSession!);
    const foreignPlayer=await mutate('players.create',foreignActor,{input:{name:'Foreign Owner Player'}});
    await assert.rejects(()=>call(request('players.get',actor,{resourceId:String(foreignPlayer.value.id)})),StoreNotFoundError);
    await mutate('session.revoke',foreignActor,{});

    // Verify expiry and explicit revocation without exposing credentials.
    const expiryHash=randomBytes(32);
    await call(request('session.createGuest',null,{credentials:{...credential(),sessionTokenHash:expiryHash}}));
    await database.execute(`UPDATE guest_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,[expiryHash]);
    assert.strictEqual(await store.lookupSessionByTokenHash(expiryHash,new Date()),null);
    const revokeHash=randomBytes(32);
    await call(request('session.createGuest',null,{credentials:{...credential(),sessionTokenHash:revokeHash}}));
    const revokeSession=await store.lookupSessionByTokenHash(revokeHash,new Date());assert.ok(revokeSession);
    const revoked=await mutate('session.revoke',actorFrom(revokeSession!),{});
    assert.strictEqual(revoked.status,204);assert.strictEqual(await store.lookupSessionByTokenHash(revokeHash,new Date()),null);
    await mutate('auth.logout',actor,{});
    assert.strictEqual(await store.lookupSessionByTokenHash(loginHashB,new Date()),null,'logout revokes the authenticated session');

    const allOperations:StoreOperation[]=[
      'session.createGuest','session.get','session.getClaimDetails','session.revoke','session.claimGuest','auth.register','auth.login','auth.logout',
      'players.list','players.get','players.create','players.update','players.delete','teams.list','teams.get','teams.create','teams.update','teams.delete',
      'tournaments.list','tournaments.get','tournaments.create','tournaments.updateDraft','tournaments.deleteDraft','tournaments.start','tournaments.cancel',
      'tournaments.pause','tournaments.resume','tournaments.finish','tournaments.updateAvailability','tournaments.listMatches','tournaments.getSchedule',
      'tournaments.getStandings','matches.get','matches.start','matches.pause','matches.resume','matches.recordResult','matches.skip','standings.getOverall',
    ];
    for(const operation of allOperations)assert.ok(covered.has(operation),`StoreOperation was not exercised: ${operation}`);
    assert.ok(await store.healthCheck?.());
    process.stdout.write('ApiStore PostgreSQL operation, idempotency, session, and ownership-transfer checks passed\n');
  } finally {
    // This script is intentionally restricted to disposable databases; audit
    // events are append-only and fixtures are retained for run diagnostics.
    await database.close();
  }
}

async function lookupByHash(hash: Uint8Array, store: ApiStore) {
  return store.lookupSessionByTokenHash(hash,new Date());
}

main().catch(()=>{
  console.error('ApiStore PostgreSQL checks failed; no connection details or credential material were emitted.');
  process.exitCode=1;
});
