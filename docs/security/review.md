# Focused security review — v2 API

**Status: PENDING OPERATOR CONFIGURATION REVIEW; NO RELEASE SIGN-OFF.** No confirmed High/Critical source-code blocker remains after persistence fix `bd17f87`. Production secret provisioning, TLS/HSTS/cookie delivery, proxy-hop configuration, and captured log redaction remain unverified. This was not a penetration test.

## Reviewed scope

- Rebased integration source through `0ee9e27`; API router `52e8b83`, application entrypoint `898d77a`, PostgreSQL store/rate-limit fix `bd17f87`.
- Platform branch `origin/upgrade/platform-ci` at `33db58fe`, including `web/vercel.json` routes/headers.
- Focus: login identity selection, session/guest claims and revocation, owner authorization/foreign IDs, transactions/idempotency, rate limits, safe errors/logging, and app routing.

## Evidence

- **Our security suite**, rerun after rebasing through `0ee9e27` against `tournament_test` and `http://127.0.0.1:4173` with `NODE_ENV=test`: `npm run test:security` — **3 suites passed, 18 passed, 3 TODO, 0 failed**. Real API/PostgreSQL cases cover foreign player/tournament IDs and mixed-owner roster rejection, owner-visible data isolation, fabricated-cookie rejection, session revocation/replay, guest bootstrap, and wrong/correct-password login identity. Mock-router tests cover CSRF/origin denial, owner-field rejection, and forwarding/rate-limit response behavior.
- **Engineering Lead’s integration evidence** (reported for `656ebd9`, 2026-11-09): REST PostgreSQL integration **11/11 passed**; `web/scripts/test-api-store-postgres.ts` and `web/scripts/test-rate-limit-postgres.ts` passed. Reported coverage includes all `ApiStore` operations, owner/foreign-ID checks, atomic guest transfer with graph cascade and rollback, stale ETag rejection/idempotency replay, session expiry/logout, and exactly **5 of 20** shared rate-limit admissions.
- Source review confirms login verifies the password with bcrypt before `ApiStore.execute`; the store selects identity by canonical username key. Session cookies are hash-looked-up and checked for expiry/revocation; the transaction revalidates the actor. Queries use bound values and owner predicates. Errors return generic problems; no request-path raw error logging was found.

## Resolved finding

An earlier isolated run found guest bootstrap returning `500` (`42P08`): an audit insert reused one parameter as UUID and text. `bd17f87` assigns `entity_id` a separate parameter. The real guest-bootstrap regression now passes. No other concrete High/Critical blocker was confirmed in the reviewed scope.

## Pending operator checks

- Verify production secret provisioning/rotation and fail-closed startup.
- Verify deployed TLS/HSTS/cookie behavior and that `API_TRUSTED_PROXY_HOPS` matches the actual proxy chain.
- Capture application/platform logs during auth, database errors, and guest transfer to verify credential/capability redaction.

The fresh-empty-database rollout is accepted; legacy-import issues are not release gates. PostgreSQL transfer/transaction/idempotency and shared rate-limit behavior are covered by the lead-reported tests above. Keep review status pending until operator checks are recorded; do not treat these tests as release approval.
