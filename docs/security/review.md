# Focused security review — v2 API

**Status: PENDING; NO RELEASE SIGN-OFF.** Review is limited to authentication/session identity, guest session creation/claim, PostgreSQL owner scoping, transactions/idempotency, rate limits, error handling, and app/Vercel routing. Production secret provisioning, TLS, and proxy behavior were not verified in the deployed environment.

## Reviewed code and configuration

- Rebased integration source at `cabd9a8`; API router `52e8b83`, application entrypoint `898d77a`, and PostgreSQL store `215c8f2` (`web/src/api/router.ts`, `web/src/services/ports.ts`, `web/src/persistence/api-store.ts`, `web/src/persistence/database.ts`, `web/src/persistence/rate-limit.ts`, migrations, and `web/src/app.ts`).
- Platform branch `origin/upgrade/platform-ci` at `33db58fe` for `web/vercel.json` routing and response headers.
- The live isolated service at `http://127.0.0.1:4173` returned readiness `200`; the test database was verified as `tournament_test` on the local PostgreSQL service.

## Evidence

Ran `npm run test:security` against the isolated PostgreSQL/API environment (`NODE_ENV=test`, `TEST_DATABASE_NAME=tournament_test`, loopback API origin, disposable test password injected): **17 passed, 12 TODO, 1 failed**. The passing real-DB cases verified:

- Foreign player and tournament IDs are hidden with `404`; a mixed-owner team roster is rejected with `404`; each owner’s visible player data remains isolated.
- A fabricated opaque cookie cannot bootstrap a session. A real authenticated session is revoked, its cookie is expired, and replay returns `401`.
- Wrong login password returns `401` without a session cookie; the correct password establishes a session for the registered account. Code inspection confirms bcrypt verification occurs in the API router before `ApiStore.execute`; the store then selects the account by canonical username key, not client-supplied user/owner IDs.
- The mock-router suite still covers CSRF/origin denial, request owner-field rejection, forwarding-chain handling, and rate-limit response behavior.

Session resolution uses an HMAC-protected cookie hash and filters revoked/expired sessions. `PostgresApiStore.execute` revalidates the actor inside its transaction; resource reads and writes carry the resolved owner predicate, with schema-level owner foreign keys/composite constraints. Logout/revocation is session- and owner-scoped. Guest claim is bound to the authenticated session’s pending guest owner. PostgreSQL mutations use `BEGIN`/`COMMIT` with rollback on error; rate limiting uses a single atomic `INSERT .. ON CONFLICT` fixed-window update keyed by an HMAC. The reviewed request path returns generic problem responses and contains no raw SQL/error logging calls. These source observations do not substitute for the pending DB-wide transaction/idempotency, multi-instance, and log-capture tests below.

## High blocker

**Guest session bootstrap fails against the isolated PostgreSQL database.** `tests/security/postgres-api-security.test.ts` expects real `POST /api/v1/sessions` to return `201` but receives generic `500`. A rollback-only PostgreSQL probe reproduced error `42P08` (`inconsistent types deduced for parameter $2`) at `web/src/persistence/api-store.ts:795-796`: the `audit_events` insert reuses `$2` as both `guest_session_id` (UUID) and `entity_id` (text). No diagnostic details or secrets were returned to the API client, and the probe rolled back without changing data. This prevents a new guest session from being created and blocks release until the persistence owner fixes the query and the real-DB regression passes.

No other High/Critical blocker was confirmed in this focused review. The importer is not a release gate under the current rollout decision.

## Still pending; not asserted as passed

- Complete PostgreSQL owner-isolation coverage for all resource reads/writes, derived statistics, and history; the tests above cover representative foreign IDs only.
- Guest-to-account transfer ownership/collision behavior, transaction rollback, and idempotency replay/conflict behavior.
- Multi-instance rate-limit atomicity and verification that production `API_TRUSTED_PROXY_HOPS` matches the deployed proxy chain.
- Importer review (non-release-gating for the accepted fresh-empty-database rollout).
- Captured application/proxy log-redaction tests.
- Production secret provisioning/rotation, actual TLS/HSTS/cookie delivery, and deployed proxy configuration. Source configuration is not deployment evidence.

Keep this review pending until the guest bootstrap blocker is fixed and retested, and the explicitly pending production/integration evidence is reviewed. Do not treat the passing cases as release approval.
