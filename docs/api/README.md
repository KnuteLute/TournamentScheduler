# Tournament Scheduler API v1

`openapi.yaml` is the planning contract for the Vue client and the backend API. It describes a JSON REST API rooted at `/api/v1`; it does not replace or redefine the current Express/EJS page routes. PostgreSQL is the durable source of truth for sessions, owner-scoped data, tournament state, results, and standings. The backend—not the browser—validates all relationships, computes schedules and standings, and applies state transitions.

## Ownership and sessions

- Every player, team, tournament, match, and idempotency record belongs to an owner scope. A scope is either an authenticated account or an anonymous guest session.
- Resolve the owner only from the verified server-side session. Never accept `ownerId`, `accountId`, or a session identifier from a JSON body, query string, or resource ID. Apply the owner predicate to every read, write, join, and nested-resource lookup in PostgreSQL.
- A foreign-owned ID must have the same externally visible behavior as an unknown ID (`404`), including nested match and team paths. Do not disclose whether the ID exists for another owner.
- Sessions use a high-entropy opaque random secret in the `__Host-ts_session` cookie. Persist only a one-way hash of the secret. Set `Secure`, `HttpOnly`, `SameSite=Lax` (or stricter), `Path=/`, and no `Domain`; enforce idle/absolute expiry, revocation, and secret rotation on authentication or privilege changes. Do not use a self-contained client-readable token as the session store.
- Create a guest scope through `POST /sessions`. `GET /session` returns the current guest/authenticated state and a session-bound CSRF token. Use `Cache-Control: no-store` for session/authentication responses.
- Require a valid CSRF token and same-origin/Origin validation for cookie-authenticated mutations. Do not enable credentialed cross-origin API access by default.
- Registration/login can start without a guest or use the current guest cookie. On successful authentication, atomically transfer guest-owned players, teams, and tournaments into the account and rotate the session secret. The response includes transfer counts. If a normalized player/team-name collision exists, preserve the account's existing reusable record; preserve the guest tournament and its participant/result snapshots, and do not overwrite existing account data. A failed authentication or failed transaction transfers nothing. Revoke the old guest session after a successful transfer. Define and test exact name normalization consistently in application and PostgreSQL (trim, collapse whitespace, Unicode-aware case folding); unique normalized names are scoped to one owner.
- Logging out revokes the active session but does not delete owner data. Guest data expiration/retention is a server policy and must not silently affect authenticated data.

## Data model and tournament behavior

Supported wire values are exactly `1v1`, `2v2_fixed`, and `2v2_rotating`.

| Mode | Draft input | Start requirements and schedule |
| --- | --- | --- |
| `1v1` | At least two distinct owned `playerIds` | Round-robin player matches; odd player counts are supported with a bye. |
| `2v2_fixed` | At least two distinct owned `teamIds` | Each reusable team has exactly two distinct owned players; schedule team-versus-team matches. |
| `2v2_rotating` | At least four distinct owned `playerIds` | Generate eligible two-player sides server-side, considering prior pairings/opponents and paused players; append matches as play progresses. |

Creation produces a `draft`; `POST .../start` validates the complete roster and atomically snapshots mode, names, and membership before generating matches and entering `active`. Client-supplied player/team IDs must all belong to the current owner. Names and membership shown in a started tournament are snapshots: later renames or roster edits do not rewrite history. A team or player referenced by a draft/active tournament cannot be deleted; historical tournament snapshots remain available.

An active tournament can be `completed` by finish or `cancelled`; both are terminal. Finishing leaves remaining matches unplayed. Cancelling preserves results already recorded and awards no points for unplayed matches. A completed or cancelled tournament is immutable through these write endpoints. Drafts may be edited or deleted; active rosters and mode cannot be edited.

Matches have `scheduled`, `in_progress`, `completed`, or `skipped` status. `POST .../matches/{matchId}/start` explicitly starts the next scheduled match and captures its start time; only one match may be in progress, and earlier sequence matches must be completed or skipped. A result is accepted only for an active tournament and an in-progress match. Recording a result, its timestamps, match status, standings derivation, and any newly scheduled rotating-mode match is one database transaction. Corrections to a completed result are allowed only while the tournament remains active and must use the latest tournament ETag; recompute standings from match results rather than incrementally trusting client totals. Skip does not create a score or change standings. Paused participants are excluded from future rotating match generation; past and already-created match snapshots are not modified.

Scores are non-negative integers; equal scores are draws. Standings are derived from completed matches only: win = 3 points, draw = 1, loss = 0. Sort by points, score difference, points-for, then stable name and ID. Rows are teams for `2v2_fixed` and players for the other modes. These ranking rules are a product contract and should be revised explicitly if tournament rules change.

## Validation and errors

- Accept JSON request bodies (and `application/merge-patch+json` for PATCH). Reject malformed JSON with `400`; return `422` for valid JSON that violates field or domain rules. Ignore no unknown write fields: reject them with `422` to catch client/server drift.
- Return RFC 9457 `application/problem+json` for errors. Validation problems include `errors[]` with JSON Pointer, stable machine `code`, and safe human message. Never include SQL, stack traces, secrets, or foreign-owner details in a problem response. Include a trace ID for operational correlation.
- `401` means no valid session/credentials; `403` means failed CSRF/origin check; `404` includes missing or foreign-owned resources; `409` means state/uniqueness/idempotency conflict; `412` means stale `If-Match`; `429` may include `Retry-After`.
- Passwords are submitted only over HTTPS, never returned or logged, and stored using a contemporary password-hashing function. Login failure messages must not reveal account existence.

## Concurrency and idempotency

- Return a strong `ETag` for mutable resources and require `If-Match` on every resource update/delete and tournament/match lifecycle command. Missing preconditions should be rejected (recommended `428 Precondition Required`); a stale tag returns `412` and the client should refetch before retrying. Increment the tournament `version` for every accepted state mutation that affects the tournament or its matches. Match writes check the tournament version so two clients cannot both advance/score from stale state.
- Every state-changing request requires `Idempotency-Key`. Persist the key scoped to owner + HTTP method + canonical route, together with a request hash and the final status/headers/body. Same key and same request replays the original outcome; same key with a different request returns `409`. Claim the key and execute the mutation in one transaction. Retain records for a documented period longer than normal client retry windows.
- Idempotency handles network retries; `If-Match` handles competing edits. Use both. Do not implement advance/score/finish as GET requests.
- Use PostgreSQL transactions and suitable row locking/conditional updates for lifecycle changes and uniqueness constraints. Enforce normalized player/team name uniqueness in the database, scoped by owner, as well as request validation.

## API conventions

- Pagination uses opaque `cursor`, `limit` (1–100), and `nextCursor`; clients must not construct cursors.
- Timestamps are ISO 8601 UTC strings. IDs are opaque and are not authorization tokens.
- Do not expose persistence details, owner IDs, internal scheduler state, or mutable standings fields. There is deliberately no standings write endpoint.
- This OpenAPI document is the contract boundary. Keep Vue-generated types and server request/response validation aligned to it; add backward-incompatible changes under a new API version rather than silently changing v1 semantics.

## Contract checks

Validate the file with an OpenAPI 3.1-capable validator before implementation and in API-contract CI, for example:

```sh
npx --yes @redocly/cli lint docs/api/openapi.yaml
```

Also add CI checks for unresolved references, operation ID uniqueness, request/response examples, and parity between server runtime validation and the published schemas. No application routes or database migrations are part of this planning-only change.
