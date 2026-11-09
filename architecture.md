# Tournament Scheduler Upgrade Architecture

## Goals

Upgrade the existing Express/TypeScript Tournament Scheduler into a secure, restart-safe application with a versioned REST API and a modern Vue frontend. Preserve the existing user/guest workflows, scheduler modes and tournament history while making server-side ownership and validation authoritative.

## Existing application

The current application is an Express + TypeScript server rendering EJS. PostgreSQL and a local JSON adapter back users, players, matches and tournament history. Scheduling lives in `web/src/lib/scheduler.ts`; routes and tournament state are in `web/src/app.ts`. Important existing issues include process-global active tournament state, insecure fallback JWT secret, guest identity accepted directly from a cookie, missing API/CSRF/rate-limit boundaries, non-atomic duplicate checks and swallowed database failures. The project currently has no functioning test command or CI workflow.

## Target architecture

```text
Vue 3 / TypeScript SPA
  └── versioned REST API (/api/v1)
       ├── authentication + owner context + CSRF protection
       ├── request validation + authorization + rate limits
       ├── application services (tournaments, players, teams, matches)
       ├── domain (scheduling, scoring, standings, lifecycle rules)
       └── repository interfaces
            ├── PostgreSQL + versioned SQL migrations (production)
            └── local adapter (development/offline compatibility)
```

The backend is authoritative for identity, ownership, scheduling constraints, scores and standings. The frontend is a client only; no client-supplied owner ID, guest ID, standings, schedule validity, or match state is trusted. The REST API and rendered application must use the same application services.

## Target repository layout

```text
packages/contracts/          OpenAPI source and generated TypeScript contracts
web/src/api/                 Express routers, validation, problem responses
web/src/auth/                Session authentication, authorization, CSRF
web/src/services/            Application use cases
web/src/domain/              Scheduling, standings and lifecycle rules
web/src/persistence/         Repository ports and adapters
web/db/migrations/           Additive, versioned PostgreSQL migrations
frontend/                    Vue 3 + Vite + TypeScript application
tests/integration/           API/database tests
tests/e2e/                   Playwright browser journeys
tests/security/              Security regression tests
docs/                        API, schema, rollout, testing and security docs
.github/workflows/           CI, integration, e2e and security checks
```

Legacy routes and templates remain until equivalent frontend journeys are verified. No legacy data is discarded as part of the migration.

## Identity, sessions and ownership

All records belong to an internal owner scope. Authenticated owners map to users; guest owners map to a server-issued, opaque, high-entropy session credential whose hash is stored server-side with expiry and revocation. A cookie is only a transport for the credential, never an arbitrary owner identifier. Every repository operation is scoped by the owner from verified server context; IDs from request bodies cannot override that scope.

Cookies are HttpOnly, Secure in production, and SameSite=Lax or stricter. Mutating cookie-authenticated requests require CSRF verification. Login, signup, guest issuance and sensitive mutations are rate-limited. Production startup fails closed when session secrets are absent or weak. Account claim/guest transfer is transactional and resolves normalized-name collisions explicitly without data loss.

## Persistence and migration

PostgreSQL is the source of truth in production. Migrations are additive, ordered, repeatable where feasible, and have documented backup/rollback procedures. Existing users, players, tournaments and match JSON are retained and imported with ownership mappings and reconciliation output. The offline adapter must satisfy the same repository behavior contract and must write atomically. Active tournaments are persisted; no process-global mutable state is used.

The normalized player-name uniqueness rule is enforced by database constraints, scoped to owner and defined locale/normalization behavior. Mutations that affect multiple rows use transactions. Match changes use versions/ETags to reject stale edits. Standings are derived from valid completed matches so corrections cannot double-count player statistics.

## API and validation

The OpenAPI 3.1 document under `docs/api/openapi.yaml` is the canonical API contract. Endpoints are versioned under `/api/v1`, return ISO-8601 UTC timestamps, validate bounded input at the server, and return `application/problem+json` errors with stable codes. API resources are owner-scoped; cross-owner reads and writes do not leak existence. Mutations that may be retried support idempotency keys; conflicting updates use optimistic concurrency.

The contract covers users/guest sessions, players, teams, tournaments, participants, matches, schedules, standings and health checks. Tournament modes are `1v1`, `2v2_fixed`, and `2v2_rotating`; UI defaults to rotating 2v2 above fixed 2v2, while fixed mode remains supported server-side.

## Scheduling and standings

Scheduling rules are documented in `docs/domain/`. The domain layer is deterministic under an injected seed and validates player/court overlaps, participant minimums, byes, pause status, match lifecycle and time constraints. Scores and rosters are validated server-side. Skipped and unplayed matches do not contribute standings. Standings use wins, score difference and score-for unless explicit tournament rules choose another policy; sporting ties share rank.

## Frontend

The Vue 3 TypeScript SPA uses Vite, Vue Router and Pinia. It consumes generated contract types and the same-origin API using secure cookies and CSRF tokens. The app preserves Norwegian as its default language, with accessible keyboard/mobile flows for tournament creation, player/team management, scheduling, match scoring, pause/skip, standings and history.

## Quality and delivery

Vitest covers domain logic and Vue components, Supertest covers API/repository integration with PostgreSQL, and Playwright covers critical user journeys. CI runs lint, type checks, contract-generation drift checks, tests, builds, dependency/security checks and migrations. GitHub Actions use least privilege, pinned third-party action revisions and no production credentials on untrusted PRs. Deployment and schema rollback are documented for the existing Vercel target; PostgreSQL is provisioned separately.

## Release-blocking security requirements

- No default/fallback production signing secret.
- No guest identity derived from an unverified caller-selected ID.
- No global tournament state; all active state persists and is owner-isolated.
- CSRF protection, secure cookie flags, bounded input and request rate limits.
- Server-side authorization on every resource operation.
- Parameterized SQL, transaction boundaries and database-level uniqueness.
- High-severity findings fixed and security regression tests passing before release.

See `docs/security/threat-model.md` and `docs/security/review.md` for the detailed threat model and review evidence.
