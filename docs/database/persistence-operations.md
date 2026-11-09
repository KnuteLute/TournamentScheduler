# Persistence implementation notes

## Intended rollout: fresh empty database

The intended v2 rollout path is a **new, empty PostgreSQL database**. Apply the
versioned migrations to that database, then point the v2 deployment at it. No
legacy import is required for this path; the existing Vercel database may remain
untouched and unused. Do not wipe, reset, or repurpose that existing database as
part of this workstream. Import tooling below is optional recovery/migration
support for a separately approved data-preservation decision, not a prerequisite
or release gate for the fresh-database rollout.

## API store adapter

`web/src/persistence/api-store.ts` imports and implements the backend-owned
`ApiStore` port from `web/src/services/ports.ts`. The production wiring entry is
`createPostgresApiStore(env?: NodeJS.ProcessEnv): ApiStore`; construction
validates PostgreSQL configuration and creates a bounded lazy pool, without
opening a connection. `PostgresApiStore.close(): Promise<void>` and
`PostgresDatabase.close(): Promise<void>` are available to server/test lifecycle
owners; the store adapter does not mount itself into the application.

All `StoreOperation` mutations use a database transaction. Idempotency rows are
claimed and completed in the same transaction as data changes; stored auth
outcomes contain no raw session token/hash or password. Authentication retries
create a new token-hash/CSRF-hash session row and revoke a prior session tied to
the same idempotency request. Resource SQL includes the verified actor's owner
scope; foreign resource IDs return the port's not-found error. Schedule,
lifecycle, score, and standings changes call the shared domain functions.
Career and tournament standings are derived from normalized completed matches.
Legacy `players` aggregate counters are retained and are not overwritten on
normal match/result operations: quarantined or unlinked historical snapshots
cannot reconstruct every pre-upgrade counter, so destructive cache recomputation
is deferred until a separate baseline/adjustment migration can reconcile them.

Guest transfer locks both owners, resolves all player/team name collisions
explicitly, then updates the domain root owner IDs in one transaction.
All owner-bearing composite foreign keys defer validation and cascade updates.
A failed midway transfer rolls back without losing history or snapshots.

## Migration runner

PostgreSQL schema changes are under `web/db/migrations/`, ordered by their
four-digit version. `web/scripts/migrate.ts` defaults to read-only status;
`--apply` is required to mutate the database. Apply creates/uses the
`schema_migrations` checksum ledger, serializes execution with a PostgreSQL
advisory lock, and applies each migration transactionally. A checksum mismatch,
partial legacy schema, or database version unknown to the checked-out code is a
hard failure; the runner does not attempt to repair or reset a schema. The
script is operator-invoked only and is never run during application startup.
The persistence CLI commands load the repository-root `.env` quietly before
reading `POSTGRES_URL`; existing process/Vercel variables take precedence, and
no environment values are printed.

```sh
cd web
npx ts-node scripts/migrate.ts --status   # default; read-only
npx ts-node scripts/migrate.ts --apply    # explicit schema mutation
```

Migration `0001_legacy_baseline.sql` creates the legacy-compatible base schema
only for an empty database. When all four recognized legacy tables already
exist, the runner records that baseline without executing the SQL. Migration
`0002_normalized_persistence.sql` is additive and retains legacy JSON and owner
columns. It does not import data or make legacy guest cookies valid.
`0003_rate_limit_buckets.sql` adds the cross-instance fixed-window counter store;
it contains no raw network, account, or session identifiers. `0004_api_store.sql`
adds API resource fields and links guest-claim sessions to fresh session rows.
All owner-bearing composite foreign keys are `ON UPDATE CASCADE DEFERRABLE
INITIALLY DEFERRED`. The claim locks both owners, resolves all canonical-name
collisions, then updates player, team, tournament, and match roots in dependency
order within one transaction. Cascades preserve IDs and snapshots across team
members, enrollments, fixed entries, schedule events, match sides, and match
players; deferred team-entry triggers validate the final graph at commit.

Run migrations as an explicit operator-controlled command, not during API
startup, Vercel previews, or every serverless invocation. `POSTGRES_URL` is
required. Production requires TLS configured in the URL (`sslmode=require` or
stricter); pool size defaults to two in Vercel and is strictly bounded. The
migration runner has not been applied to production by this change.

## Legacy import and reconciliation

Legacy import is an explicit operator tool only: the migration command, API
startup, and deployment do not invoke it. `--apply` affects only the selected
source/database and is never part of the fresh-empty-database default rollout.

`web/scripts/import-legacy.ts` defaults to dry-run. It reports counts and safe
warning codes, never credentials, source payloads, raw guest-session values,
SQL errors, or connection URLs. Examples:

```sh
cd web
npx ts-node scripts/import-legacy.ts --source local-json --file .local-data/offline-db.json
npx ts-node scripts/import-legacy.ts --source local-json --file .local-data/offline-db.json --apply
npx ts-node scripts/import-legacy.ts --source local-json --file database/players_index.json --file database/tournament_history.json --file database/match_history.json
npx ts-node scripts/import-legacy.ts --source postgres
npx ts-node scripts/import-legacy.ts --source postgres --apply --limit 250
npx ts-node scripts/import-legacy.ts --source postgres --apply --rescan --limit 250
npx ts-node scripts/import-legacy.ts --reconcile
```

Local JSON imports are recorded in an inaccessible quarantined owner namespace;
the source file is not changed and does not become an authenticated user's data.
The PostgreSQL importer maps only unambiguous account-owned records, adds
normalized match sides and participant snapshots when their source shape and
ownership references are valid, records match-derived enrollments, and stores
per-record hashes/provenance. Legacy guest rows map only to non-authenticating
quarantined owners; their old cookie strings are represented only by hashes and
are never inserted into `guest_sessions`. Name collisions, malformed rows,
invalid stats, and cross-owner participant references are retained for review.
An incomplete PostgreSQL import resumes from its persisted per-entity cursors.
After completion, a later apply pass rescans stable source IDs; unchanged target
rows are idempotent and changed source hashes are marked for review.

For legacy matches, initialized `0`/`0` JSON scores are not treated as results.
Only a completed/finished source status (or legacy status absent with completion
time) with a valid completion timestamp and two bounded integer scores becomes
normalized `completed` data. Scheduled, in-progress, paused, and skipped matches
get `NULL` normalized scores and no winner; the original legacy JSON and timing
columns remain unchanged. A purported completion with malformed/missing score
or completion time is marked `needs_review` and normalized as non-completed. A
valid legacy `start_time` is copied into `normalized_started_at`; scheduled rows
with a start time are normalized to `in_progress`. Legacy paused rows lacking
pause-interval history are likewise made resumable as `in_progress`, marked
`needs_review`, and do not receive fabricated pause intervals. Invalid start
timestamps are marked for review, not exposed as normalized start times, and
cannot validate a completion result.

Import writes occur in a database transaction and preserve legacy columns and
JSON. Review database backups, source hashes, collision reports, and unresolved
quarantine before any separately approved account-claim or cutover operation.
This CLI does not claim that migration or import has been production-applied.
Each apply transaction is bounded: local JSON is capped at 10,000 records /
50 MiB, and PostgreSQL imports use an ordered high-water mark with persisted
per-entity ID cursors (default 250 rows per entity, configurable up to 1,000).
If the output reports `checkpointed_batch_incomplete`, rerun the same `--apply`
command to resume; the source mapping and cursor advance atomically with every
page. The safe JSON output includes per-entity `checkpoint` and `highWater` IDs.
If row counts or high-water IDs change while a checkpoint is active, the importer
fails closed before resuming; an operator must reconcile that incomplete batch
before starting a new scan. A completed PostgreSQL batch with the same counts
and high-water IDs returns `noOp` by default. Because this inventory signature
cannot detect content edits that preserve both row counts and IDs, production
imports require a write-freeze/catch-up boundary. If such edits are suspected,
use `--rescan` to page through the same inventory and compare per-record hashes;
changed records are retained and marked `needs_review` rather than overwritten.
Finish any active checkpoint without `--rescan` before starting a full rescan.

## Local JSON safety boundary

The persistence local JSON helper is intended only for explicitly selected,
single-process development. It rejects production, requires
`LOCAL_JSON_MODE=single-process`, private user-owned directories/files, refuses
symlinks and corrupt JSON, and rejects concurrent/stale exclusive locks rather
than silently dropping a write. Writes use a mode-0600 temporary file, fsync,
verified backup, atomic rename, and directory sync. Multi-process/serverless
local JSON is unsupported. Existing legacy JSON files remain unchanged; do not
point production runtime at the legacy offline adapter.

## Distributed rate limiting

`PostgresDatabase.consumeRateLimit(input: RateLimitConsumeInput):
Promise<RateLimitConsumeResult>` and the same method on
`TransactionQueryable` consume one fixed-window request with one
`INSERT .. ON CONFLICT DO UPDATE` statement. It is safe to call directly or
inside the store's transaction callback: rollback undoes the consume, commit
persists it, and concurrent Vercel instances serialize on the bucket's primary
key. The validated server-side request timestamp from the shared port defines
window boundaries. Rejected requests do not increase a bucket beyond its
configured limit.

The shared services port exposes
`consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision>`;
its PostgreSQL adapter must delegate transaction callbacks to the transaction
handle rather than opening a separate pool query. The request contract is
`{ bucketHash: string; now: Date; windowMs: number; maximum: number }` and the
decision is `{ allowed: boolean; retryAfterSeconds: number }`.

`RateLimitRequest.bucketHash` must be lowercase hex for a 32-byte HMAC-SHA-256
computed by application code. The adapter rejects any other encoding and
stores only the decoded 32-byte hash, count, window start, and reset timestamp.
Never hash an identity without a secret, and never persist or log a raw IP,
username, cookie, session token, or rate-limit key.

`pruneExpiredRateLimitBuckets(input?: RateLimitPruneInput): Promise<number>`
deletes at most the requested bounded batch using `FOR UPDATE SKIP LOCKED`, so
concurrent cleanup jobs do not contend on the same expired rows. Run it from a
controlled maintenance/scheduled task, not as an unbounded request-path scan.
`web/scripts/test-rate-limit-postgres.ts` checks rollback/commit behavior and
concurrent consumers using two independent pools. It requires `NODE_ENV=test`,
`RATE_LIMIT_TEST_DATABASE_URL` pointed at an isolated migrated database whose
name contains `test`; it must never be pointed at deployed data.

`web/scripts/test-api-store-postgres.ts` exercises every `ApiStore` operation,
idempotency replay/hash conflicts, sessions, cross-owner not-found behavior,
guest-name collision rollback, and a normalized guest-owner transfer. It is also
restricted to an isolated migrated test database whose name contains `test`.
It was not runtime-verified when PostgreSQL was unavailable.
