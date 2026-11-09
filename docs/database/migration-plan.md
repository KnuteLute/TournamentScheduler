# Fresh-database rollout and optional legacy recovery plan

## Goals and safety boundaries

The recommended/default v2 rollout provisions a **new, empty PostgreSQL database** and applies the versioned schema in [schema.md](schema.md). Importing the current Vercel database or optional offline `.local-data/offline-db.json` is not required for release; the old database and local files may remain untouched and unused. No migration or app startup automatically wipes, resets, or imports a database. The legacy recovery procedures below are optional tooling only, to use after explicit operator approval.

This plan does **not** make a guest cookie value an identity. Existing code reads `guest_session` directly and uses it as `guest_session_id`; those raw values are not verified credentials. Never activate a migrated guest owner by trusting or reusing a request's legacy cookie. Active guest access requires a newly issued high-entropy token whose hash maps to an active server-side `guest_sessions` row. If optional legacy recovery is approved, guest-owned rows without independently verifiable ownership proof remain quarantined and unclaimable until an explicit, audited recovery/claim process succeeds. Never expose them to whichever client presents the old value.

## Phase 0 — select and prepare the path

1. **Default:** provision a new empty v2 PostgreSQL database and a separate `POSTGRES_URL`; leave the old Vercel database untouched. No legacy inventory/import is needed to bring v2 up.
2. **Optional legacy recovery only:** inventory old database/file shapes, take tested backups and immutable copies, record source hashes, and establish a write-freeze/catch-up plan before any import.
3. Do not copy the old database over the new one or run destructive reset/truncate commands.

## Phase 1 — additive schema expansion

1. Apply versioned transactional DDL to the new empty database: create sessions, owners, players, teams, tournaments, enrollments, fixed entries, matches/sides/snapshots, idempotency, rate-limit, and audit tables. The baseline creates empty legacy-compatible base tables; no user data is fabricated or imported.
2. The default empty database has no large legacy tables to backfill; apply the versioned indexes and constraints transactionally. Online/concurrent indexes and bounded backfills are considerations only if optional legacy recovery is approved for a large source.
3. Fresh installs begin with no user-name collisions, while uniqueness constraints are active from the first application write. Optional legacy import must review collisions before assigning canonical keys. DDL replay is controlled by migration versions/checksums, not blind `IF NOT EXISTS` statements.

## Optional Phase 2 — backfill legacy PostgreSQL data (not a release prerequisite)

1. Create a migration/import batch and per-source mapping records. Preserve existing primary keys. Create one data owner for each existing user and map rows whose `user_id` references a valid user to that owner. Report orphaned user references and invalid dual ownership rather than guessing.
2. For rows with only a legacy `guest_session_id`, preserve their full source values and records in a quarantined, non-authenticating legacy owner/import mapping. Do **not** create an active `guest_sessions` row from the old value. Do not allow application reads for a client based only on that value. Any recovery pathway must separately prove control (for example, an audited one-time claim credential delivered/validated outside the untrusted cookie) and then issue a new credential.
3. Backfill `players.name_key` with the documented versioned Unicode canonicalizer. Produce owner-scoped collision reports before enforcing uniqueness. Retain all player IDs and statistics; resolve collisions by explicit rename/merge policy and preserve the decision in audit/provenance.
4. Parse each legacy `matches.teams` JSON document into `match_sides` and `match_players`, retaining scores, participant IDs where trustworthy, display-name snapshots, winner, times, order, and relevant status/mode/round/court fields. Parse tournament `standings` and compare with aggregates computed from matches. Preserve the original JSONB unchanged during the compatibility period. If a participant ID is absent, malformed, or refers outside the correct owner, keep its snapshot and record the issue; never attach it to a same-named player by guesswork.
5. Create tournament enrollment and fixed-team roster snapshots from recoverable match/tournament data only. Mark uncertain historical enrollment/pairing as imported/unknown rather than inventing it. Use a documented ordering rule for `sequence_no` (legacy match ID within a tournament unless a reliable source order exists); persist source ID mappings.
6. Make each batch and each source record restartable. Use stable source keys and hashes; identical already-imported records are no-ops, changed-source hashes are reported for review, and partial batches can resume. Record row counts, reject counts, collision reports, and per-field transformations.

## Optional Phase 3 — import local JSON data (not a release prerequisite)

1. Import each offline file set as a distinct source namespace and batch (`offline-db.json`, or legacy `players_index.json`, `tournament_history.json`, `match_history.json` and player files where present). Never assume IDs from separate devices are globally unique; use `(source namespace, entity, source ID)` mappings to new durable IDs.
2. Validate JSON shape, IDs, `nextIds`, ownership consistency, participant references, timestamps, and duplicate normalized names. Preserve original source identifiers and content hashes. Route malformed records and conflicting references to an exception report/quarantine; import readable history with snapshots where possible without fabricating relationships.
3. Require an authenticated owner selection or a server-issued, one-time import credential to attach a local dataset to a user. A local `user_id`, username, guest ID, cookie value, or file field is not proof of server account ownership. If import is not explicitly claimed, store it in a quarantined import namespace inaccessible to normal users.
4. Import tournament/match records once using provenance and idempotency keys. Never re-add player aggregates on retry: compute target aggregates from successfully imported canonical matches or apply deltas protected by the unique import mapping in the same transaction. Compare source stats with derived totals and report differences.
5. Keep the local original and a verified copy unchanged through the agreed recovery period. Offline mode remains a separate storage mode until product behavior explicitly supports synchronization; do not merge two local devices simply because names match.

## Phase 4 — fresh-database v2 rollout

1. Apply migrations explicitly to the new empty database, verify schema readiness and backup/restore procedures, then point the v2 deployment at it.
2. Verify sessions, revocation/expiry, owner isolation, transactions, idempotency, rate limits, normalized tournament/match writes, and derived standings against that database.
3. Keep the old Vercel database separate and untouched; do not dual-write or import it as part of this default path. No migration/import runs on application startup.
4. If legacy recovery is later approved, use optional phases 0–3 and a separately planned source-to-target cutover; do not silently merge it into the fresh-database rollout.

## Transaction and idempotency requirements

- Each optional importer batch records `started`, `completed`, `failed`, or `needs_review` and is resumable. For each source record, insert target data, provenance mapping, audit details, and any derived-stat delta in one transaction. Unique provenance and idempotency constraints make concurrent/repeated attempts safe.
- For an already-seen idempotency key, return its stored result only when operation and request hash match. A changed payload under the same key returns conflict. Keep key scope bound to server-resolved owner and operation.
- For a guest-to-user merge, lock both owners in stable ID order, verify the guest session token server-side and its active/unclaimed state, reconcile owner-scoped unique names without lossy merges, transfer all dependent rows, append audit events, revoke/claim the guest credential, and commit atomically. Use a retry-safe outcome. Do not expose a caller-controlled `guest_session_id` merge API.
- If optional legacy backfill is selected, run it in bounded transactions with checkpoints; do not hold a table-wide lock while parsing JSON. Persist source high-water marks/counts and establish a write-freeze/catch-up or transactional outbox so concurrent writes are not missed. This process is not part of the fresh-database path.

## Rollback plan

### Fresh-database default

If the v2 deployment or migration validation fails, leave the new database intact
for diagnosis or abandon it without touching the old database. Roll back application
configuration to the prior deployment/database if needed. No import or destructive
reset is part of this path.

### Before normalized writes are enabled on an optional legacy-recovery path

Stop the migration, retain the additive schema and import reports, and continue using the old application/schema. Additive tables/columns can remain unused. Do not drop columns or rewrite legacy JSON. If the schema migration itself failed, use the migration's tested down step only for objects created by that migration and only after confirming they contain no writes.

### After dual-write, before normalized read cutover (optional legacy path only)

Disable new normalized-only features and return reads to the legacy representation. Because legacy writes were preserved transactionally, existing clients continue to operate. Keep normalized tables and import mappings for diagnosis/replay; do not delete data. Reconcile any failed/mismatched dual-writes from audit/provenance before retrying.

### After normalized read cutover (optional legacy path only)

Use the feature flag to return reads to legacy columns/JSONB only if those representations were kept in sync. Pause writes if necessary, take a fresh backup, compare the last common checkpoint, and resolve normalized writes that cannot be represented losslessly in the old shape before reopening legacy writes. Never silently discard those writes. If rollback cannot preserve them, keep the service read-only or roll forward with a fix rather than restoring an older snapshot over newer data.

### Offline JSON rollback

Retain an untouched source copy and a pre-import backup. Stop writers before restoring; write to a new file, validate JSON and `nextIds`, then atomically replace only the intended data file after explicit approval. Do not overwrite or delete the original. The JSON adapter cannot safely represent concurrent server writes; it is not a database rollback target once server writes have diverged.

### General safeguards

- Test both forward migration and rollback/recovery on a production-like restored copy before rollout.
- Keep schema changes additive until a separately approved contract phase. Never use destructive reset, truncate, cascade-delete, or database restore as a routine rollback.
- Retain backups and migration audit/provenance for the retention period. Document an operator, stop condition, restore point, and validation checklist for each production run.

## Completion criteria

The default release path is complete when the new empty database is migrated,
the v2 store/session/owner/transaction checks pass, and the application uses that
database without requiring data import. If optional recovery is separately
approved, its additional completion criteria are correct account-owner mappings,
quarantined unverified guests, reviewed collisions/malformed records, reconciled
history and standings, and tested backup/rollback procedures.
