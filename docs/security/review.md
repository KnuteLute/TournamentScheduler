# Security review plan and acceptance criteria

**Review status: PENDING FULL SECURITY REVIEW AND DATABASE/DEPLOYMENT EVIDENCE.** The integration app mounts the v1 API through `createApplication`; the legacy EJS/global-tournament entrypoint and stale generated app/auth JavaScript artifacts have been removed. The legacy JWT utility no longer has a fallback and fails closed for missing/weak production secrets. This work adds contract and route-level regressions for those code-level controls using a mock `ApiStore`. PostgreSQL/offline ownership, guest-transfer transactions, importer behavior, multi-instance rate limiting, log redaction, and deployed proxy/secrets configuration are not established by these checks. This is **not security sign-off**.

## Severity rubric

- **Critical:** Credible unauthenticated or broadly reachable compromise of authentication, arbitrary cross-account access/modification at scale, or a release/configuration condition that defeats the primary security boundary. Do not release until fixed and independently retested.
- **High:** Material account/data confidentiality or integrity impact, reliable cross-owner access/modification, significant authentication/CSRF weakness, or practical service disruption. Release-blocking unless fixed or formally risk-accepted by the security and product owners with compensating controls and an expiry.
- **Medium:** Limited or conditional security impact, defense-in-depth gap, or weakness that can amplify another issue. Must have an owner and scheduled remediation; fix before release where it weakens a critical/high control or handles sensitive data.
- **Low:** Minor hardening or low-impact issue. Track and remediate according to risk; must not mask a higher-severity failure.

Severity is provisional. Confirm exploitability, deployment exposure, and impact during implementation review; adjust with rationale.

## Preliminary findings and actionable acceptance criteria

| ID | Severity | Risk to address | Acceptance criteria |
|---|---:|---|---|
| R-01 | Critical | **Production secret provisioning remains unverified.** The code-level legacy JWT fallback has been removed; the utility now throws when its secret is absent or under 32 UTF-8 bytes. The v2 API separately requires `API_SESSION_HASH_SECRET`. | Every production entrypoint fails with a clear, non-secret diagnostic if a required auth/session secret is absent, weak, or invalid. No default signing/hash key remains in a reachable production path. Secret provisioning, rotation, and incident response are documented. Jest verifies missing/short legacy JWT and API session secrets fail closed and a strong test secret works; deployed secret provisioning/rotation remains to be verified. |
| R-02 | High | **Guest capability persistence and transfer are unverified.** The v1 router treats the cookie as an opaque capability and looks up a protected hash; real store enforcement and guest-to-account transfer behavior have not been retested against PostgreSQL. | Guest IDs are server-issued, opaque, high entropy, validated, and not selectable by arbitrary client input; capability storage/verification is documented. Foreign/invalid guest capability cannot read, write, or merge data. Successful login/signup rotates/revokes the guest capability. Merge is transactional, idempotent, ownership-scoped, and follows a tested duplicate-name policy. |
| R-03 | High | **Durable tournament isolation remains unverified.** The mounted application no longer includes the legacy process-global tournament state; active state must still be verified against PostgreSQL ownership and multi-instance behavior. | Active tournaments are stored against an authenticated user or validated guest owner. Every operation checks that owner. Two concurrent sessions and two application instances retain independent tournament state. Unowned or expired state is denied safely. Static application checks confirm the legacy global is absent; persistent and multi-instance evidence remains pending. |
| R-04 | High | **Persistence ownership enforcement is unverified.** The API rejects client-selected owner fields and passes a session-derived actor, but foreign/unowned resource authorization and constraints require PostgreSQL-backed verification. | Start rejects any player ID not found in the caller's owned set; no fabricated participant is accepted. All database reads/updates/deletes include ownership checks or derive from a verified owned record. A foreign player ID cannot alter statistics, create a history record referring to that player, or expose its name/history. Database constraints reinforce application checks. |
| R-05 | High | **Route-level controls are tested; remaining route/deployment evidence is pending.** Mock-router tests reject missing CSRF, foreign Origin, and cross-site Fetch Metadata; the mounted app no longer exposes the known state-changing tournament GET routes. | Every browser state-changing endpoint has CSRF defense. Cross-site requests without valid CSRF proof are rejected without state change. GET routes remain read-only. Cookies have explicit `SameSite`, `Secure` in HTTPS production, `HttpOnly`, `Path`, and expiry attributes. Route tests support the tested code-level controls; deployed cookie/TLS configuration remains pending. |
| R-06 | High | **Complete validation coverage is pending.** The API defines and applies schemas, but this security suite has not exhaustively tested all runtime input boundaries or persistence-side invariants. | Schemas validate type, length, range, format and allowlists before any mutation. Scores are finite bounded integers; player IDs are unique and owned; mode/action is allowlisted; names and credentials have documented limits and normalization. Malformed requests receive safe 4xx responses and do not throw an uncaught error or partially mutate data. Request-body size is bounded. |
| R-07 | High | **Rate limiting exists at the router; persistent atomicity and deployed proxy topology are unverified.** Route tests cover HMAC buckets, trusted-hop parsing, and readiness throttling with a mock store only. | Login/signup and expensive/state-changing endpoints have effective configurable limits, safe retry behavior, and monitoring. Login errors do not reveal whether a username exists. Limits remain correct behind the production proxy and do not trust unvalidated forwarding headers. Password hash work is concurrency-bounded. |
| R-08 | Medium | **Account merge collisions / identity normalization.** Account and player uniqueness rules differ between paths; merge can create confusing duplicates or detach history. Legacy login compatibility accepts passwords shorter than the registration minimum. | Username and player-name normalization is defined once and consistently enforced in both database modes. Uniqueness is backed by database constraints with a documented case/Unicode policy. Merge collision behavior preserves record ownership and references, is atomic, and is covered for concurrent/repeated merge requests. New registrations require 12–72 characters; login retains legacy compatibility at 1–72 characters, but both reject over-72-UTF-8-byte values before bcrypt without truncation. Review the remaining legacy-password population and any upgrade policy against the account threat model. |
| R-09 | Medium | **Code-level response headers are configured; production delivery is unverified.** `createApplication` sets CSP and baseline headers, but deployed HTTPS/HSTS behavior has not been checked. | Production responses include a reviewed CSP (without broad unsafe allowances unless explicitly risk-accepted), `X-Content-Type-Options: nosniff`, frame protection via CSP `frame-ancestors` or equivalent, and a restrictive `Referrer-Policy`. HSTS is sent only after HTTPS is enforced. Inline code/style is removed, hashed, or nonce-authorized. Policy is checked on rendered pages and does not silently disable required protections. |
| R-10 | Medium | **SQL injection and database ownership.** Parameterized value queries are a positive baseline to preserve; query construction and write scopes need verification. | All user-controlled values remain bound parameters; dynamic identifiers, if any, come from fixed allowlists. Integration tests exercise hostile-looking names/credentials without changing query structure or accessing other records. SQL errors are handled safely, transactions roll back on failure, and updates are ownership-scoped. |
| R-11 | Medium | **Logging and errors.** Exception/DB error logging can disclose sensitive internal details if secrets or request values enter logs. | Logs never include passwords, password hashes, JWTs, cookies, CSRF/guest capabilities, or full credential-bearing request bodies. User-controlled log fields are sanitized and internal error details are not returned to clients. Logging tests or a documented redaction review cover authentication, merge and database failure paths. |
| R-12 | Medium | **Offline persistence and concurrency.** JSON persistence requires explicit permissions and atomic/concurrency handling if it is supported in production or shared environments. | Offline mode is either explicitly restricted to trusted single-user/local use or hardened with restrictive file permissions, atomic writes, corruption handling, and serialization/locking. Configuration cannot accidentally select it for production. Test data and secrets are not committed or served as static files. |

## Required test cases

Tests should use isolated fixtures and assert both the response and persistence/state outcome. Do not use real accounts or production data.

### Authentication, cookies, guest ownership, and merge

1. **Missing secret:** Start with production settings and no JWT secret; assert startup fails closed and emits no secret material. Repeat with a valid configured secret and verify login works.
2. **JWT verification:** Reject malformed, tampered, expired, wrong-algorithm, and wrong-claim tokens; accept only a correctly issued token. Logout/revocation behavior matches the documented design.
3. **Guest isolation:** Create separate guest sessions A and B. Verify A cannot read or alter B's players/history by replacing or forging its guest cookie with B's identifier or malformed values.
4. **Guest merge ownership:** Log in/sign up with a valid guest session and verify only that guest's records transfer. Repeat with another guest's capability, invalid capability, duplicate request, concurrent merge, and a duplicate normalized player name; verify no cross-owner transfer or partial merge.
5. **Account enumeration and throttling:** Compare unknown-user and wrong-password responses; both are generic. Exercise login/signup thresholds and verify throttling, retry behavior, and no lockout bypass through untrusted proxy headers.

### Authorization and tournament isolation

6. **Unknown/foreign participant IDs:** Submit nonexistent, malformed, duplicate, and another account's player IDs at tournament start. Each is rejected; no tournament or player/stat mutation occurs.
7. **Statistics ownership:** Submit a valid tournament for account A, then inspect account B's player records. B's stats are unchanged. Repeat with guest A vs guest B, and with a numeric identifier crafted to refer to an existing foreign player.
8. **Concurrent tournament sessions:** Start independent tournaments for two users and two guests; interleave reads, scores, next/previous, pause, skip, and finish. Assert no data or state crosses session boundaries.
9. **Multi-instance behavior:** Run the same scenarios against two app instances sharing the production persistence backend. State/ownership remains consistent without process affinity.
10. **History ownership:** Attempt direct history-detail access using another owner's tournament ID. No details are disclosed; behavior is a safe not-found/denied response.

### CSRF, validation, SQL, and availability

11. **CSRF:** Submit cross-origin/missing-token requests for every state-changing route (including account and tournament operations). Assert rejection and unchanged state; valid same-origin token requests succeed. Confirm state-changing GET requests no longer exist.
12. **Validation boundaries:** For every input schema, test missing fields, wrong JSON/form types, arrays vs scalars, empty and overlong strings, Unicode edge cases, invalid modes/actions, too many participants, negative/fractional/non-finite/oversized scores, and malformed pause IDs. Assert bounded 4xx responses, no partial writes, and no uncaught exceptions.
13. **SQL parameterization:** Use quote/metacharacter-like values in username/player fields and verify they remain data, cannot alter query meaning, and cannot read or mutate foreign records. Review all query construction for concatenated user-controlled values.
14. **Abuse/resource limits:** Exercise login, signup, player creation, tournament generation, and history access above configured limits. Assert bounded CPU/work, safe status/retry behavior, and normal service for unrelated clients.
15. **Database failure handling:** Force representative query/transaction failures. Assert rollback, safe client error, no secret-bearing logs, and continued pool usability.

### Browser security, logging, and persistence

16. **Response headers/CSP:** Check representative authenticated and anonymous HTML responses for required headers. Run the app under enforced CSP and verify no inline script/style violation is hidden by a broad unsafe directive; verify framing is denied.
17. **Cookie attributes / HTTPS:** Inspect cookies in production-like HTTPS mode for `Secure`, `HttpOnly`, explicit `SameSite`, `Path`, and expiry; confirm production does not issue authentication cookies over HTTP.
18. **Log redaction:** Trigger authentication failures, database errors, and merge errors using sentinel secrets. Search captured application/proxy logs and responses; assert no password, token, cookie, capability, or sensitive query data appears.
19. **Offline mode:** If supported, exercise simultaneous writes, interrupted writes, corrupt file behavior, file permissions, and mode selection. Verify unsupported production configuration fails closed.

## Security test implementation status

`tests/security/openapi-security.test.js` checks the merged OpenAPI contract for opaque session credentials, CSRF/same-origin requirements, mutation idempotency, absence of client-selected owner identifiers, schema bounds, roster uniqueness, score bounds, not-found semantics, and authentication throttling. Its credential assertions specifically require `RegisterCredentials` (12–72 characters) and `LoginCredentials` (1–72 characters), both documenting rejection above 72 UTF-8 bytes with no truncation. It verifies that the application mounts `createApiRouter`, has no global tournament state, does not expose the known state-changing tournament GET routes, and has no stale `app.js`/`auth.js` artifacts.

`tests/security/api-router-security.test.js` uses `createApiRouter` with a mock `ApiStore` and a loopback HTTP server. It exercises invalid/malformed session-cookie recovery, CSRF/origin/Fetch Metadata rejection without store mutations, owner-ID and unknown-field rejection, trusted-proxy forwarding-prefix handling and the readiness rate limit, 72-byte password boundaries including multibyte Unicode, and missing/short/valid production API session-secret configuration. It also verifies the legacy JWT utility has no usable fallback and rejects missing/weak production secrets. These tests support code-level secret handling, mounted API routing, and known legacy GET-route remediation. Mock-store tests do not prove persistence authorization or shared-store rate-limit atomicity.

Execution after rebasing onto integration commit `502d038`: `npm run test:security` reported **2 suites passed, 14 passed, 12 todo, 0 failed**. The no-legacy-GET and application-mount assertions pass. This result is limited to the contract/static checks and isolated API/config behavior; it is not a full security review or release sign-off.

Code-level status supported by the current suite: the v1 router is mounted in `createApplication`; the application no longer includes legacy EJS handlers or process-global tournament state; stale generated `web/src/app.js` and `web/src/lib/auth.js` are absent; the known legacy state-changing GETs are absent; and the legacy JWT utility has no fallback and rejects missing/weak production secrets. These narrow code-level items are remediated, not the broader R-01/R-03/R-05 acceptance criteria.

Explicitly pending integration/deployment evidence: PostgreSQL-backed owner predicates and unowned/foreign resource rejection; guest transfer ownership, collision policy, and retry safety; transaction rollback and idempotency replay/conflict behavior; multi-instance persistent rate-limit atomicity; importer validation, ownership, and bounded work; application/proxy log redaction; production secret provisioning/rotation, TLS/cookies, and actual proxy-hop configuration; and offline-mode restrictions. SQL hostile-name tests also require the real persistence adapter. The security TODOs identify these as unverified, not passed.

Mock-router tests verify forwarded-chain normalization and readiness throttling, but do not establish atomic persistent buckets or that deployed topology matches `API_TRUSTED_PROXY_HOPS`. No overall review status or release sign-off is granted until the pending PostgreSQL/offline and deployment checks are reviewed and rerun.

## Release-blocking requirements

The following are release blockers, not backlog recommendations:

1. Verify production secret provisioning/rotation and fail-closed deployment startup (R-01); removal of the legacy code fallback is covered by the current regression test.
2. Establish validated guest capability handling and prove guest data and merge isolation (R-02).
3. Prove durable owner-scoped tournament state and pass interleaved and multi-instance isolation tests (R-03); removal of process-global state from the mounted app is covered by the current regression test.
4. Enforce ownership for submitted participant IDs and all derived stats/history writes; pass cross-owner tampering tests (R-04).
5. Protect every cookie-authenticated state change from CSRF and remove state-changing GET behavior (R-05).
6. Add complete server-side validation and bounded request/score/participant inputs; pass malformed and boundary tests (R-06).
7. Provide effective authentication/resource rate limits (R-07).
8. Demonstrate parameterized SQL and ownership-scoped database writes, plus safe rollback behavior (R-10).
9. Verify production HTTPS, cookie settings, and minimum response security headers/CSP (cookie criteria in R-05; headers/CSP in R-09).
10. Complete a fresh post-implementation security review and record test evidence, residual risk owners, and any approved exceptions. A passing build or unit test suite alone is not security sign-off.

Any unresolved Critical risk blocks release. Any unresolved High risk blocks release unless a time-bound exception is explicitly approved by both the security owner and product owner, with compensating controls and a retest date. This pending review and its mock-store tests are not evidence of full remediation or approval.

## Retest requirements after implementation

- Review the actual remediation diff and configuration; update severity and status for every R-01 through R-12 item with evidence or an explicit accepted residual risk.
- Run the full required test matrix above against PostgreSQL and every supported persistence mode, using a supported Node/runtime and production-like environment settings.
- Add automated regression tests for all fixed Critical/High risks, including authorization and concurrency/isolation cases; preserve CI results with the release record.
- Test deployed cookies, headers, TLS/HSTS, proxy trust, secrets provisioning, and rate limits in the target hosting environment; source configuration alone is insufficient.
- Recheck database schema constraints/migrations, transaction rollback, merge collision behavior, logs, and error responses.
- Repeat tests after any material changes to authentication, session, ownership, tournament, or deployment code. Retest any failed or changed acceptance criteria before release.
- Record tester/date/build identifier, cases run, outcomes, failures fixed, and approved exceptions. Do not mark this review complete until that evidence exists.
