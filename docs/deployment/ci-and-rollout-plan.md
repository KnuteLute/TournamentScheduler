# CI and rollout plan

## Scope and current state

This plan keeps Vercel as the hosting target and PostgreSQL as the production data store. CI calls the root workspace scripts and does not deploy or run production migrations. Repository branch protection and Vercel project/environment settings still require operator configuration; this document does not claim those external controls are active.

The root workspace provides the requested lint, typecheck, unit, integration, security, E2E, contract, and build scripts, and its lockfile is synchronized. CI runs those commands after `npm ci`. The remaining cross-PR dependencies in this worktree are the persistence-owned `web/scripts/migrate.ts` and `db:migrate` script plus the persistence test file invoked by `web`'s unit script; the Quality/security integration fixtures, security tests, and Playwright config/specs are also pending their worktree PRs. CI calls `npm run db:migrate --prefix web`, `npm run test:integration`, `npm run test:security`, and `npm run test:e2e` directly; these are real gates, not always-failing placeholder steps, and must be verified once the respective PRs merge.

## Platform implementation status

The workflows in `.github/workflows/` run PR checks for and pushes to both `upgrade/tournament-v2` (integration) and `main` (the final release PR), including `merge_group` requests. Jobs have read-only repository permissions except for the narrowly scoped CodeQL upload job; no PR/test job receives production credentials. CodeQL and the root lockfile audit also run weekly after the workflow is present on the repository's default branch. Dependency Review blocks newly introduced high-severity vulnerabilities. Dependabot proposes weekly GitHub Actions and npm dependency updates.

The CI jobs run the named root commands: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run contract:check`, `npm run test:integration`, `npm run test:e2e`, and `npm run build`. Separate `security-audit` and `security-tests` jobs run `npm audit --audit-level=high` on the root lockfile and `npm run test:security`. The root audit is independent of installation, so lockfile findings are reported even if another job's `npm ci` fails. Local verification on the current integration baseline: `npm ci`, lint, typecheck, contract check, build, and root/web high-severity audits pass (lint has two warnings; contract lint has two warnings; root audit has 7 low findings and web has none). `npm run test:unit` passes the domain/app, legacy scheduler, and API router suites, then stops because the referenced persistence test file is not merged. Integration/security report no tests, E2E lacks `playwright.config.ts`, and `db:migrate` is not present yet. These gates depend on the persistence, Quality, and security PRs; do not mark the affected checks green or required before they run successfully after merge.

Integration and E2E use isolated PostgreSQL services, test-only credentials, `npm run db:migrate --prefix web`, a local `npm start --prefix web` server bound to `127.0.0.1:4173` (the server defaults to loopback), and a readiness probe to `/api/v1/health/ready`. E2E installs Playwright Chromium with system dependencies. Logs are not printed or uploaded. Both jobs use a synthetic base64url `API_SESSION_HASH_SECRET`, a 41-character ASCII-only `TEST_ACCOUNT_PASSWORD` for guest registration/account-transfer flows, `API_TRUSTED_PROXY_HOPS=0`, `TEST_DATABASE_NAME`, `TEST_API_ORIGIN`, and `E2E_BASE_URL`; these disposable values are not Actions secrets or production credentials.

GitHub Actions are pinned to full SHAs. Current pin sources, resolved from the upstream repositories' GitHub commit/tag API and retained as inline release comments:

| Action | Release | Commit | Upstream tag-to-commit source |
| --- | --- | --- | --- |
| `actions/checkout` | v6.1.0 | `d23441a48e516b6c34aea4fa41551a30e30af803` | [GitHub API](https://api.github.com/repos/actions/checkout/commits/v6.1.0) |
| `actions/setup-node` | v6.5.0 | `249970729cb0ef3589644e2896645e5dc5ba9c38` | [GitHub API](https://api.github.com/repos/actions/setup-node/commits/v6.5.0) |
| `actions/dependency-review-action` | v5.0.0 | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | [GitHub API](https://api.github.com/repos/actions/dependency-review-action/commits/v5.0.0) |
| `github/codeql-action` | v4.39.0 | `6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee` | [GitHub API](https://api.github.com/repos/github/codeql-action/commits/v4.39.0) |

The CodeQL init/analyze steps intentionally share one commit. PR analysis does not upload findings, avoiding a need for write permissions on untrusted fork PRs; trusted pushes, manual runs, and the schedule upload to GitHub code scanning. npm audit, dependency review, CodeQL, and PR build/test jobs do not use Vercel/database production secrets.

`compose.yaml` starts only a local PostgreSQL 16.4 database, binds it to loopback, and uses clearly synthetic local credentials. It is not a production or deployment template. Start/stop it with `docker compose up -d postgres` and `docker compose down` (use a separate deliberate volume removal only when local data may be discarded).

### Vercel and SPA/API routing

`frontend/vite.config.ts` builds the SPA at `web/public/app` with base `/app/`. `web/vercel.json` uses the Vercel static builder for those assets, maps `/app/assets/**` and SPA history requests under `/app/**` to the static output, and sends `/api/v1/**` (plus legacy routes) through the Express function at `src/app.ts`. Vercel applies the reviewed CSP, `nosniff`, frame denial, referrer policy, permissions policy, and HSTS headers to both `/app` and `/app/**`; these headers match the Express policy. The SPA build emits external scripts/styles and currently has no inline script or style blocks/attributes, so `script-src 'self'` and `style-src 'self'` remain compatible without unsafe allowances. The Node build includes `public/**` for legacy static assets. Configure the Vercel project root as `web` and enable access to files outside the root directory for `../frontend`. Verify API routing, SPA history fallback, headers, and static assets before promotion; Vercel does not run database migrations.

## GitHub Actions design

Use separate, named workflows (or clearly named jobs in a single workflow) so required-check names remain stable. CI runs for pull requests targeting `upgrade/tournament-v2` and pushes to that integration branch, plus `merge_group`. Cancel superseded PR runs. Migrations in CI run only against disposable PostgreSQL services; never deploy or migrate production from a PR workflow.

### Pull-request checks

Run the following checks on every PR, in parallel where practical, and make all of them required after initial rollout:

| Check | Proposed work | Gate |
| --- | --- | --- |
| `lint` | `npm ci`; `npm run lint`. | No lint errors; warnings policy is explicit and non-bypassable. |
| `typecheck` | `npm ci`; `npm run typecheck`. | TypeScript exits successfully. |
| `unit` | `npm ci`; `npm run test:unit`. | All unit tests pass; upload coverage as informational initially, then set a measured minimum once a baseline exists. |
| `contract` | `npm ci`; `npm run contract:check`. | OpenAPI contract validation passes; do not treat compilation alone as a contract test. |
| `integration-postgres` | Start a disposable PostgreSQL service; set the isolated test environment; run `npm run db:migrate --prefix web`, build, start the app, probe readiness, and run `npm run test:integration`. | Schema bootstrap, CRUD/transaction behavior, and test cleanup pass. Never connect this job to deployed data. The migration command is referenced but not yet present in this worktree; the job is blocked until persistence integration merges it. |
| `e2e` | Start an isolated PostgreSQL service; run migration/build/start/readiness; install Playwright Chromium with OS dependencies; run `npm run test:e2e`. | Browser journeys pass with synthetic credentials; logs/artifacts do not expose credentials. |
| `build` | `npm ci`; `npm run build` (contracts, Express API, and Vue static output) without production credentials. | Build succeeds and deployable output is generated. |

Tests needing a database must never rely on the local JSON/offline mode as a substitute for PostgreSQL integration. E2E should use a disposable database or isolated preview environment, not production. Avoid brittle tests that depend on third-party live services.

### Security checks

Run security checks on PRs and on a scheduled cadence (at least weekly), plus the default branch:

- Dependency review for newly introduced or upgraded packages, with high-severity vulnerable packages blocked unless a documented, time-limited exception is approved.
- `npm audit --audit-level=high` for the root lockfile; high and critical findings block. Manage advisories with scoped exceptions that name an owner and expiry, rather than suppressing whole classes.
- Secret scanning and push protection at the GitHub repository level. Add a CI scanner if repository policy requires it; ensure generated test fixtures contain no credentials.
- CodeQL JavaScript/TypeScript analysis, with security alerts reviewed and high-confidence findings fixed or explicitly triaged.
- A workflow/configuration scanner for Actions and deployment configuration, where available.

Security jobs use read-only repository permissions except for CodeQL's `security-events: write` upload permission on the CodeQL analysis job. PR analysis disables upload, and no security job receives Vercel or production database secrets. Do not run untrusted PR code in a `pull_request_target` job with secrets or write permissions.

## Workflow hardening

- Pin every third-party GitHub Action to a reviewed full commit SHA (not a mutable tag); add a comment with the corresponding release/version for maintainability. Keep pins updated via reviewed automation (for example, Dependabot) and verify upstream provenance before updating.
- Set workflow-level `permissions: {}` and grant only job-specific permissions. PR test jobs generally need `contents: read`; security upload jobs should receive only the narrowly required security-events permission. Grant `id-token: write` only to an approved deployment job if Vercel OIDC is deliberately configured.
- Use `actions/checkout` with least privilege and avoid persisting credentials unless required. Do not print environment values or enable shell tracing around secrets.
- Use `npm ci` with committed lockfiles, a pinned supported Node LTS version, and a consistent npm version. Cache only package-manager data keyed by lockfile; never cache credentials or mutable build artifacts across trust boundaries.
- Set job timeouts, concurrency groups, and explicit `if` conditions. Pin PostgreSQL service image to a supported major/minor or digest. Set `NODE_ENV=test` and test-only database values explicitly.
- Protect workflow changes with CODEOWNERS/review. Treat changes to `.github/workflows/**`, deployment settings, migration scripts, and security suppressions as sensitive.
- Keep artifacts short-lived and minimal. Do not upload `.env`, database dumps, cookies, or raw logs that could contain user data.

## Branch protection and merge constraints

Protect the default branch (and any release branch that can deploy) with a ruleset:

1. Require pull requests; require at least one approving review and dismiss stale approvals after new commits. Require CODEOWNER approval for workflows, deployment configuration, and migrations.
2. Require all named CI checks above, including the security policy gate, and require branches to be up to date (or use a merge queue that reruns checks on the merge group).
3. Require conversation resolution. Block force pushes and branch deletion. Restrict direct pushes; permit only approved maintainers/bots under a documented exception.
4. Do not allow routine administrator bypass of checks. Any emergency bypass must be recorded with rationale and followed by a remediation PR.
5. Do not make a check required until it is consistently emitted with the final stable name for all relevant PRs. When renamed, transition old/new required checks deliberately to avoid a deadlock or an unprotected gap.

## Vercel deployment and environment boundaries

Keep Vercel as the hosting and deployment platform; do not introduce a second production host in this work. Preserve the existing Vercel project/build configuration unless an explicitly reviewed change is needed. CI should validate the app build without production credentials; Vercel remains responsible for creating deployments.

- **Pull requests:** Vercel preview deployments may be created by the existing Vercel-Git integration. Keep preview secrets and database access isolated from production. Fork previews must either have no secrets and no writable database or be disabled. Never run schema migrations from an automatic preview deployment.
- **Production:** deploy only commits merged to the protected production branch through the Vercel integration. Require Vercel's production environment protection/approval where available, and restrict who can change project settings, domains, environment variables, and deployment promotion.
- **Promotion:** prefer promoting the already built, reviewed artifact/commit to production rather than rebuilding from a different source state. Smoke-test the promoted deployment and retain the prior known-good Vercel deployment for rapid application rollback.
- **Runtime limits:** confirm Vercel Node runtime compatibility, function duration/concurrency, and PostgreSQL connection limits. Use the provider's recommended pooled connection endpoint where needed; size `pg` pool limits for serverless scaling and close/test connections appropriately. Monitor for connection exhaustion. Do not assume a process-local pool is shared across Vercel instances.
- Keep health checks lightweight and non-mutating. They must not expose environment details or run destructive database initialization.

## Secrets and access

Store secrets in Vercel's environment settings for runtime use and in GitHub Environments only when a trusted CI/deployment job genuinely requires them. Use separate credentials per environment and least-privilege database roles.

Expected values and handling:

- `POSTGRES_URL`: runtime database connection string. Separate preview/staging and production database URLs; CI gets an ephemeral local service URL. Production uses the provider TLS endpoint with `sslmode=require` (prefer `verify-full` where provider certificates permit). Do not copy production credentials into GitHub PR jobs.
- `API_SESSION_HASH_SECRET`: generate a high-entropy secret of at least 32 bytes independently for each environment and store it only in the corresponding Vercel environment. Rotate after suspected exposure; never use the synthetic CI value in a deployed environment.
- `API_ORIGIN`: configure the exact public origin using `https://` in production (no path). Local CI uses `http://127.0.0.1:4173` only.
- `API_TRUSTED_PROXY_HOPS`: keep at `0` unless the actual Vercel request/proxy chain has been verified for the deployed project. Set to `1` only after confirming Vercel presents exactly one trusted proxy hop and forwarded-header behavior; do not infer this setting from local tests.
- Runtime app settings are Vercel environment values, not GitHub Action secrets. CI uses only disposable PostgreSQL credentials and a synthetic `API_SESSION_HASH_SECRET`.
- Vercel deployment credential: preferably use the Vercel Git integration or short-lived OIDC-based authentication if supported and approved. If a token is unavoidable, scope it to the project/team, place it in a protected GitHub Environment, restrict job and branch access, and rotate it.
- Any test credentials must be synthetic and disposable. Put no secrets in source, workflow YAML, command-line logs, artifacts, PR comments, or database snapshots.

Document each secret's owner, purpose, environment, rotation procedure, and recovery contact in the team's secret inventory (not with the secret value). Rotate immediately after suspected exposure and review access after staff or vendor changes.

## Database migrations, backups, and rollback

### Before rollout

1. Replace one-off schema evolution with an ordered, versioned migration system. The current `init-db.ts` creates tables with `IF NOT EXISTS` but does not track applied versions and is not sufficient for controlled upgrades. Establish a single migration command and a migration ledger before the first production schema change.
2. Make migrations explicit, reviewable, idempotent where safe, and compatible with the currently running application. Avoid destructive changes in the same release that stops using the old schema.
3. Run migrations in CI against an empty PostgreSQL database and, for upgrade safety, against a representative database snapshot with sensitive data removed. Verify failure behavior and migration locking.
4. Configure the managed PostgreSQL provider's automated backups and point-in-time recovery (PITR). Set and verify a retention period that meets product recovery objectives. Document RPO/RTO, access controls, and provider-specific restore steps.
5. Before each production migration, verify the latest successful backup/PITR window, record the restore point, and ensure someone authorized is available to monitor the deployment.

### Production sequence

1. Deploy additive, backward-compatible schema changes first (expand); do not remove or rename columns still read/written by the current app.
2. Verify migration status and a small set of non-sensitive read/write smoke checks.
3. Deploy the application version that uses the new schema, then monitor errors, latency, DB connections, and data integrity.
4. After the compatibility window and verification, remove obsolete schema in a separate reviewed migration (contract).

Run production migrations exactly once using a dedicated, auditable step with a migration-owner credential—not from every Vercel function startup, preview build, or parallel serverless instance. Serialize migration execution. Production migration approval should be separate from ordinary CI and linked to the commit/deployment.

### Recovery

- **Application-only regression:** use Vercel to restore/promote the last known-good deployment. Confirm compatibility with any schema change before rollback; rollback does not automatically undo a migration.
- **Schema/data issue:** prefer a reviewed forward-fix when safe. If restoration is required, pause writes or place the app in a controlled maintenance mode, restore to a new database/PITR point, validate counts and representative records, then switch the protected connection configuration and smoke-test. Do not overwrite the only production database before validation.
- Do not assume every migration has a safe `down` migration. Destructive or lossy changes require a backup/PITR plan, explicit approval, and a documented recovery decision before execution.
- After recovery, record the incident, timeline, affected data window, validation results, and follow-up actions. Re-enable writes only after the data owner approves.

## Rollout and adoption order

1. Add and verify canonical lint, typecheck, unit, contract, PostgreSQL integration, build, and E2E commands locally; replace the test placeholder and prove each check against the actual codebase.
2. Introduce the workflows in advisory mode. Fix baseline failures, verify security tools and test data isolation, then stabilize check names.
3. Enable branch protection and required checks; configure Vercel preview/production environment protections and secret separation.
4. Establish the migration ledger and test backup/PITR restore procedures before production schema changes.
5. Deploy through Vercel with an additive migration, run smoke tests, monitor, and promote/rollback using the procedures above.
6. Review CI duration, flaky tests, security exceptions, database connection usage, and recovery objectives at least quarterly and after any production incident.
