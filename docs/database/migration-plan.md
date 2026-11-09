# Additive migration and import plan

## Goals and safety boundaries

Move from the current PostgreSQL tables (`users`, `players`, `tournaments`, `matches`, with `teams` and standings embedded in JSONB) and optional offline `.local-data/offline-db.json` to the normalized target in [schema.md](schema.md). Preserve history and existing account-owned records, make every step repeatable, and provide a rollback that does not destroy either source or migrated data.

This plan does **not** make a guest cookie value an identity. Existing code reads `guest_session` directly and uses it as `guest_session_id`; those raw values are not verified credentials. Never activate a migrated guest owner by trusting or reusing a request's legacy cookie. Active guest access requires a newly issued high-entropy token whose hash maps to an active server-side `guest_sessions` row. Legacy guest-owned rows with no independently verifiable ownership proof must be imported under quarantined legacy ownership and remain unclaimable until an explicit, audited recovery/claim process succeeds. Preserve them; do not silently discard or expose them to whichever client presents the old value.

## Phase 0 — inventory, backup, and baseline

1. Inventory PostgreSQL constraints, indexes, row counts, sequences, supported deployed app versions, and all locations of local JSON files. Record source database version, schema checksum, and row counts. Inspect actual legacy JSON shapes rather than assuming every row is valid.
2. Take a tested database backup and immutable copy of each offline JSON source before migration. Keep original files read-only; record cryptographic hashes and access-controlled source identifiers. Test restoring both backups in an isolated environment.
3. Capture baseline counts and checksums for users, players, tournaments, matches, and JSON files. Record unresolved malformed/orphaned records as exceptions, not as reasons to coerce data silently.
4. Ensure migration is scheduled in a maintenance window or deployed with compatibility code and a clear write-freeze/catch-up boundary. Document who can pause/resume and where migration logs are retained.

## Phase 1 — additive schema expansion

1. Apply versioned, transactional DDL where PostgreSQL permits: create session, guest-session, owner, team, membership, enrollment, fixed-team entry/member, match side/player, idempotency, audit, import-batch, and import-record tables. Add nullable `owner_id`, canonical name keys, UUID public IDs, timestamps/status/version fields, and provenance columns to existing tables. Keep every legacy column intact.
2. For large production tables, add indexes using an online/concurrent deployment strategy; `CREATE INDEX CONCURRENTLY` must run outside a transaction. Add checks and foreign keys as `NOT VALID` if needed, backfill, then validate them. Review lock behavior and use a lock timeout; abort and retry rather than blocking traffic unexpectedly.
3. Create unique indexes/constraints only after collision reports are reviewed. Keep writes in legacy mode until schema readiness checks pass. The DDL itself must be idempotent through migration version tracking, not blind `IF NOT EXISTS` statements that hide partial failures.

## Phase 2 — backfill current PostgreSQL data

1. Create a migration/import batch and per-source mapping records. Preserve existing primary keys. Create one data owner for each existing user and map rows whose `user_id` references a valid user to that owner. Report orphaned user references and invalid dual ownership rather than guessing.
2. For rows with only a legacy `guest_session_id`, preserve their full source values and records in a quarantined, non-authenticating legacy owner/import mapping. Do **not** create an active `guest_sessions` row from the old value. Do not allow application reads for a client based only on that value. Any recovery pathway must separately prove control (for example, an audited one-time claim credential delivered/validated outside the untrusted cookie) and then issue a new credential.
3. Backfill `players.name_key` with the documented versioned Unicode canonicalizer. Produce owner-scoped collision reports before enforcing uniqueness. Retain all player IDs and statistics; resolve collisions by explicit rename/merge policy and preserve the decision in audit/provenance.
4. Parse each legacy `matches.teams` JSON document into `match_sides` and `match_players`, retaining scores, participant IDs where trustworthy, display-name snapshots, winner, times, order, and relevant status/mode/round/court fields. Parse tournament `standings` and compare with aggregates computed from matches. Preserve the original JSONB unchanged during the compatibility period. If a participant ID is absent, malformed, or refers outside the correct owner, keep its snapshot and record the issue; never attach it to a same-named player by guesswork.
5. Create tournament enrollment and fixed-team roster snapshots from recoverable match/tournament data only. Mark uncertain historical enrollment/pairing as imported/unknown rather than inventing it. Use a documented ordering rule for `sequence_no` (legacy match ID within a tournament unless a reliable source order exists); persist source ID mappings.
6. Make each batch and each source record restartable. Use stable source keys and hashes; identical already-imported records are no-ops, changed-source hashes are reported for review, and partial batches can resume. Record row counts, reject counts, collision reports, and per-field transformations.

## Phase 3 — import local JSON data

1. Import each offline file set as a distinct source namespace and batch (`offline-db.json`, or legacy `players_index.json`, `tournament_history.json`, `match_history.json` and player files where present). Never assume IDs from separate devices are globally unique; use `(source namespace, entity, source ID)` mappings to new durable IDs.
2. Validate JSON shape, IDs, `nextIds`, ownership consistency, participant references, timestamps, and duplicate normalized names. Preserve original source identifiers and content hashes. Route malformed records and conflicting references to an exception report/quarantine; import readable history with snapshots where possible without fabricating relationships.
3. Require an authenticated owner selection or a server-issued, one-time import credential to attach a local dataset to a user. A local `user_id`, username, guest ID, cookie value, or file field is not proof of server account ownership. If import is not explicitly claimed, store it in a quarantined import namespace inaccessible to normal users.
4. Import tournament/match records once using provenance and idempotency keys. Never re-add player aggregates on retry: compute target aggregates from successfully imported canonical matches or apply deltas protected by the unique import mapping in the same transaction. Compare source stats with derived totals and report differences.
5. Keep the local original and a verified copy unchanged through the agreed recovery period. Offline mode remains a separate storage mode until product behavior explicitly supports synchronization; do not merge two local devices simply because names match.

## Phase 4 — application cutover and validation

1. Deploy compatibility code that reads normalized ownership and writes normalized rows transactionally. Resolve user/guest principal server-side from validated sessions only. All protected queries must be scoped by resolved `owner_id`; ignore ownership IDs supplied in request bodies, URL parameters, JWT payloads not cryptographically verified, or raw guest cookies.
2. During a controlled transition, dual-write legacy JSONB and normalized representations in the same database transaction. Avoid asynchronous dual-write. If safe atomic dual-write is unavailable, use a write freeze or a transactional outbox with replay and reconciliation before cutover.
3. Compare counts and deterministic checksums by owner and source mapping; compare match/team/score/player snapshots; compare historical standings and recalculated aggregates. Verify all foreign keys, no cross-owner links, no duplicate idempotency keys, no unresolved high-severity import exceptions, and successful backup restore. Exercise guest claim with a valid new token, an expired/revoked token, a forged raw cookie, retries, and name collisions.
4. Run shadow reads/diff reporting without serving shadow results. Once results agree, switch reads to normalized tables behind a rollback-capable feature flag. Monitor errors, query latency, duplicate writes, migration exceptions, and reconciliation drift. Keep the legacy representation synchronized only for the agreed compatibility window.
5. Stop dual-write only after the rollback observation window and confirmation all deployed instances use normalized paths. A later migration may remove old columns/JSONB; it is a separate reviewed change, not part of this rollout.

## Transaction and idempotency requirements

- Each importer batch records `started`, `completed`, `failed`, or `needs_review` and is resumable. For each source record, insert target data, provenance mapping, audit details, and any derived-stat delta in one transaction. Unique provenance and idempotency constraints make concurrent/repeated attempts safe.
- For an already-seen idempotency key, return its stored result only when operation and request hash match. A changed payload under the same key returns conflict. Keep key scope bound to server-resolved owner and operation.
- For a guest-to-user merge, lock both owners in stable ID order, verify the guest session token server-side and its active/unclaimed state, reconcile owner-scoped unique names without lossy merges, transfer all dependent rows, append audit events, revoke/claim the guest credential, and commit atomically. Use a retry-safe outcome. Do not expose a caller-controlled `guest_session_id` merge API.
- Run long backfills in bounded transactions with checkpoints; do not hold a table-wide lock while parsing JSON. For each checkpoint persist source high-water mark and counts. Use an explicit write freeze/catch-up or transactional dual-write/outbox so records created during backfill are not missed.

## Rollback plan

### Before normalized writes are enabled

Stop the migration, retain the additive schema and import reports, and continue using the old application/schema. Additive tables/columns can remain unused. Do not drop columns or rewrite legacy JSON. If the schema migration itself failed, use the migration's tested down step only for objects created by that migration and only after confirming they contain no writes.

### After dual-write, before normalized read cutover

Disable new normalized-only features and return reads to the legacy representation. Because legacy writes were preserved transactionally, existing clients continue to operate. Keep normalized tables and import mappings for diagnosis/replay; do not delete data. Reconcile any failed/mismatched dual-writes from audit/provenance before retrying.

### After normalized read cutover

Use the feature flag to return reads to legacy columns/JSONB only if those representations were kept in sync. Pause writes if necessary, take a fresh backup, compare the last common checkpoint, and resolve normalized writes that cannot be represented losslessly in the old shape before reopening legacy writes. Never silently discard those writes. If rollback cannot preserve them, keep the service read-only or roll forward with a fix rather than restoring an older snapshot over newer data.

### Offline JSON rollback

Retain an untouched source copy and a pre-import backup. Stop writers before restoring; write to a new file, validate JSON and `nextIds`, then atomically replace only the intended data file after explicit approval. Do not overwrite or delete the original. The JSON adapter cannot safely represent concurrent server writes; it is not a database rollback target once server writes have diverged.

### General safeguards

- Test both forward migration and rollback/recovery on a production-like restored copy before rollout.
- Keep schema changes additive until a separately approved contract phase. Never use destructive reset, truncate, cascade-delete, or database restore as a routine rollback.
- Retain backups and migration audit/provenance for the retention period. Document an operator, stop condition, restore point, and validation checklist for each production run.

## Completion criteria

Migration is complete only when account-owned legacy records map to the right owner; legacy guest data is preserved but not authorized by raw cookie values; local data is imported only after explicit ownership proof; all relational constraints validate; duplicate/collision and malformed-record exceptions are reviewed; normalized/legacy comparisons meet agreed tolerances; retry tests prove no duplicate history or stat increments; and backup restore plus rollback exercises pass.
