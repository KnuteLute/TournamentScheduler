# Repository Contribution Rules

## Change isolation

This upgrade is coordinated in branch `upgrade/tournament-v2` with one agent branch and worktree per workstream. Each contributor may edit only their exclusive ownership paths in `docs/planning/task-breakdown.md`. Read access is unrestricted. Do not edit the legacy Express files or another workstream's paths unless explicitly reassigned by the Engineering Lead.

All agent work must be committed on its assigned branch and submitted as a pull request targeting `upgrade/tournament-v2`. Do not push commits directly to the integration branch or `main`. The Engineering Lead reviews changes and integrates through PRs. Keep commits scoped and never discard another contributor's changes. The lead may make explicit integration/security cleanup changes on the integration branch; document the scope and keep those changes separate from agent PR ownership.

## Planning gate

Do not implement application code until the architecture, OpenAPI/API contracts, database schema/migration plan, scheduling invariants, rollout plan and security threat model have been reviewed and merged into the integration branch. If documents disagree, stop and request a lead decision rather than implementing a private interpretation.

## Backend verification requirements

The server is authoritative. Never accept user/owner IDs, guest session IDs, tournament ownership, standings, roster eligibility, schedule conflict checks, scores or lifecycle transitions as trusted client assertions. Resolve identity from a validated server-side session and authorize each resource operation against that identity.

Every request body and query parameter must be schema-validated and bounded. Mutating cookie-authenticated requests require CSRF checks. Sessions/cookies must be secure, revocable and expire. Production must fail closed if required secrets are absent. SQL must be parameterized. Ownership/uniqueness constraints must also be enforced in persistence, not only in UI or preflight checks. Multi-row mutations must be transactional and retry-safe where applicable.

## Quality and security

Before a PR is ready, run relevant tests, lint, type-check and build commands and include actual results in the PR. Add regression tests for fixed issues. Never claim checks passed if they were not run. Do not log passwords, tokens, cookies, or sensitive payloads. Security findings and limitations must be recorded in `docs/security/review.md`; critical/high findings block release.

## Explicit lead security-cleanup scope

After the replacement API/authentication routes are mounted, the Engineering Lead owns the targeted removal of the unused legacy JWT fallback in `web/src/lib/auth.ts` and stale generated auth/app JavaScript artifacts that could otherwise be executed as an alternate unsafe entry point. Do not modify those legacy paths from another workstream; report new findings to the lead.
