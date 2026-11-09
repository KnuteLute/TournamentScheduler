# CI and rollout plan

## Scope and current state

This plan keeps the existing Vercel deployment target and PostgreSQL data store. The Platform & CI work adds workflow/configuration foundations, but repository branch-protection rules, Vercel project settings, and several canonical test commands remain operator/lead follow-ups; this document does not claim those external controls are active.

Repository observations at the start of this workstream:

- The application is under `web/`; `web/vercel.json` routes requests to `web/src/app.ts` using Vercel's Node builder.
- The application connects to PostgreSQL using `POSTGRES_URL`. Database initialization currently lives in `web/scripts/init-db.ts` and uses `CREATE TABLE IF NOT EXISTS`; there is not yet a versioned migration history.
- `web/package.json` defines `build` as `tsc`, but `test` is a placeholder that exits with an error. The root package has Jest dependencies and `jest.config.js`; a scheduler test exists at `web/src/lib/scheduler.test.ts`.
- There are no established lint, contract, integration, or browser E2E scripts. Add and verify these commands before making their checks required.

## Platform implementation status

The workflows in `.github/workflows/` run PR and push checks for `upgrade/tournament-v2` (including merge-queue `merge_group` requests), use read-only repository permissions except for the narrowly scoped CodeQL job, and do not receive production credentials. CodeQL and npm audits also run on the scheduled weekly cadence after the workflow is present on the repository's default branch. Dependency Review blocks newly introduced high-severity vulnerabilities. Dependabot proposes weekly GitHub Actions and npm dependency updates.

The currently executable checks use the repository's existing commands: `npm run build --prefix web`, the self-executing scheduler test (`npx ts-node src/lib/scheduler.test.ts` from `web/`), and the OpenAPI lint command documented in `docs/api/README.md`. Although the rollout plan proposed Jest, the current scheduler file registers no Jest tests and instead executes assertions at import/run time; use of Jest reports “suite must contain at least one test,” so the workflow runs its existing self-executing test directly until the lead defines the unit-test command. The `lint`, PostgreSQL integration, and E2E jobs deliberately report blockers instead of inventing scripts or pretending unimplemented tests passed. The PostgreSQL job has a disposable PostgreSQL 16.4 service; its test command remains blocked until the lead/persistence/quality workstreams define and verify a migration command and integration command. E2E remains blocked until the Vue frontend, Playwright harness, and canonical test command are present. Do not mark these checks required or treat this workflow as release-ready until those blockers are resolved and each job runs real checks. The workflow currently validates the Express build; the Vercel Vue build cannot be exercised in this checkout until `frontend/package.json` lands.

Initial local `npm audit --audit-level=high` checks of both committed lockfiles fail: the root lockfile reports 3 high and 1 critical advisories (among other lower severities), and the web lockfile reports 1 high and 1 critical (plus 1 moderate). These are dependency-owner/lead blockers and are intentionally not suppressed or auto-fixed in this platform-only workstream. The `security` job will remain red until the dependency owners resolve or explicitly document scoped, expiring exceptions.

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

`web/vercel.json` keeps the Express Node function as the API and legacy route target, routes `/api/**` to it, and maps `/app/**` to the static Vue SPA with `/app/` as the asset base and SPA-history fallback. The static build expects `frontend/package.json` to run a Vite-compatible `build` script and emit `dist/`. The current checkout does not contain that frontend yet, so the Vercel config cannot be validated until that workstream is integrated. Vercel must keep the `web` project root and allow build access to files outside the root directory so `../frontend` can be built. Do not promote a deployment with an unresolved missing frontend build. API/function routes must remain ahead of SPA fallback routes.

## GitHub Actions design

Use separate, named workflows (or clearly named jobs in a single workflow) so required-check names remain stable. Run CI for pull requests targeting the protected default branch and for pushes to that branch. Use `merge_group` if GitHub merge queues are enabled. Cancel superseded PR runs. Do not run deployment or migration steps from untrusted fork PRs.

### Pull-request checks

Run the following checks on every PR, in parallel where practical, and make all of them required after initial rollout:

| Check | Proposed work | Gate |
| --- | --- | --- |
| `lint` | Install the locked `web` dependencies with `npm ci`; run the chosen linter against maintained TypeScript/JavaScript sources. | No lint errors; warnings policy is explicit and non-bypassable. |
| `typecheck` | Run `npm run build` in `web/` (or a dedicated no-emit typecheck script if compilation output is separated). | TypeScript exits successfully. |
| `unit` | Run Jest in-band or with bounded workers against pure logic, including the scheduler suite. Replace the placeholder web test script and define one canonical command. | All unit tests pass; upload coverage as informational initially, then set a measured minimum once a baseline exists. |
| `contract` | Validate request/response behavior and compatibility for externally used routes and data shapes. Start with route/controller tests and committed fixtures; adopt an explicit schema/OpenAPI contract if one is introduced. | Contract fixtures and compatibility assertions pass. Do not treat compilation alone as a contract test. |
| `integration-postgres` | Start a disposable PostgreSQL service at a pinned major version; wait for health; apply migrations to an empty database; run repository and persistence tests against it; tear it down. | Schema bootstrap, CRUD/transaction behavior, and test cleanup pass. Use a unique database per job and never connect this job to deployed data. |
| `e2e` | Run the application with an isolated PostgreSQL database and test-only secrets, then exercise core browser flows (sign-in/session, tournament setup, match completion/history). Use a maintained browser harness such as Playwright after it is added and locked. | Core flows pass, test data is isolated, and logs/artifacts do not expose credentials. |
| `build` | Run the same production build that Vercel expects, with no production credentials. | Build succeeds and deployable output is generated. |

Tests needing a database must never rely on the local JSON/offline mode as a substitute for PostgreSQL integration. E2E should use a disposable database or isolated preview environment, not production. Avoid brittle tests that depend on third-party live services.

### Security checks

Run security checks on PRs and on a scheduled cadence (at least weekly), plus the default branch:

- Dependency review for newly introduced or upgraded packages, with high-severity vulnerable packages blocked unless a documented, time-limited exception is approved.
- `npm audit` (or an equivalent lockfile scanner) for the root and `web/` lockfiles. Start with high/critical as blocking; manage advisories with scoped exceptions that name an owner and expiry, rather than suppressing whole classes.
- Secret scanning and push protection at the GitHub repository level. Add a CI scanner if repository policy requires it; ensure generated test fixtures contain no credentials.
- CodeQL JavaScript/TypeScript analysis, with security alerts reviewed and high-confidence findings fixed or explicitly triaged.
- A workflow/configuration scanner for Actions and deployment configuration, where available.

Security jobs must use read-only repository permissions and must not receive Vercel or production database secrets. Do not run untrusted PR code in a `pull_request_target` job with secrets or write permissions.

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

- `POSTGRES_URL`: runtime database connection string. Separate preview/staging and production database URLs; CI gets an ephemeral local service URL. Do not copy production credentials into GitHub PR jobs.
- Auth signing/encryption secret(s) used by the app: independently generated values per environment, rotated with a planned overlap where supported. Never reuse development or CI values in production.
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
