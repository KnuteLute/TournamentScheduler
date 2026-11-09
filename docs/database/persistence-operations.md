# Persistence implementation notes

## Migration runner

PostgreSQL schema changes are under `web/db/migrations/`, ordered by their
four-digit version. `web/scripts/migrate.ts` creates/uses the
`schema_migrations` checksum ledger, serializes execution with a PostgreSQL
advisory lock, and applies each migration transactionally. A checksum mismatch,
partial legacy schema, or database version unknown to the checked-out code is a
hard failure; the runner does not attempt to repair or reset a schema.

Migration `0001_legacy_baseline.sql` creates the legacy-compatible base schema
only for an empty database. When all four recognized legacy tables already
exist, the runner records that baseline without executing the SQL. Migration
`0002_normalized_persistence.sql` is additive and retains legacy JSON and owner
columns. It does not import data or make legacy guest cookies valid.
`0003_rate_limit_buckets.sql` adds the cross-instance fixed-window counter store;
it contains no raw network, account, or session identifiers.

Run migrations as an explicit operator-controlled command, not during API
startup, Vercel previews, or every serverless invocation. `POSTGRES_URL` is
required. Production requires TLS configured in the URL (`sslmode=require` or
stricter); pool size defaults to two in Vercel and is strictly bounded. The
migration runner has not been applied to production by this change.

## Legacy import and reconciliation

`web/scripts/import-legacy.ts` defaults to dry-run. It reports counts and safe
warning codes, never credentials, source payloads, raw guest-session values,
SQL errors, or connection URLs. Examples:

```sh
cd web
npx ts-node scripts/import-legacy.ts --source local-json --file .local-data/offline-db.json
npx ts-node scripts/import-legacy.ts --source local-json --file .local-data/offline-db.json --apply
npx ts-node scripts/import-legacy.ts --source local-json --file database/players_index.json --file database/tournament_history.json --file database/match_history.json
npx ts-node scripts/import-legacy.ts --source postgres
npx ts-node scripts/import-legacy.ts --source postgres --apply
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
Re-running an identical complete source batch is a no-op.

Import writes occur in a database transaction and preserve legacy columns and
JSON. Review database backups, source hashes, collision reports, and unresolved
quarantine before any separately approved account-claim or cutover operation.
This CLI does not claim that migration or import has been production-applied.
Each apply batch is bounded: local JSON is capped at 10,000 records / 50 MiB,
and the PostgreSQL backfill refuses a source over 1,000 total legacy rows rather
than opening an unbounded transaction. Larger PostgreSQL sources require an
operator-reviewed, checkpointed bulk-import procedure before application; the
CLI reports the refusal and performs no writes.

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
