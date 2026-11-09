# Upgrade Task Breakdown and Coordination

## Delivery gate: documents before application code

1. Review and merge `architecture.md`, API/OpenAPI contract, database schema and migration plan, scheduling invariants, rollout plan, and security threat model.
2. Resolve disagreements and freeze API/domain interfaces.
3. Establish shared workspace commands and CI foundation.
4. Begin implementation only after planning PRs are reviewed into `upgrade/tournament-v2`.

## Workstreams and ownership

| Workstream | Branch | Worktree | Exclusive writable paths |
|---|---|---|---|
| Engineering Lead / integration | `upgrade/tournament-v2` | `TournamentScheduler-worktrees/lead` | `architecture.md`, `docs/planning/**`, root manifests/config, `.gitignore`, `.env.example`, `README.md`, `AGENTS.md`, legacy `web/package*`, `web/tsconfig.json`, `web/src/app.ts`, `web/src/server.ts` |
| API Contracts | `upgrade/contracts` | `TournamentScheduler-worktrees/contracts` | `packages/contracts/**`, `docs/api/**` |
| Persistence | `upgrade/persistence` | `TournamentScheduler-worktrees/persistence` | `web/src/persistence/**`, `web/db/**`, `web/scripts/**`, `docs/database/**` |
| Scheduling & Standings | `upgrade/domain` | `TournamentScheduler-worktrees/domain` | `web/src/domain/**`, `docs/domain/**` |
| Backend API | `upgrade/backend-api` | `TournamentScheduler-worktrees/backend` | `web/src/api/**`, `web/src/services/**`, `web/src/auth/**`, `web/src/config/**` |
| Vue Frontend | `upgrade/vue-frontend` | `TournamentScheduler-worktrees/frontend` | `frontend/**`, `docs/frontend/**` |
| Quality | `upgrade/quality` | `TournamentScheduler-worktrees/quality` | `tests/integration/**`, `tests/e2e/**`, `tests/fixtures/**`, `tests/helpers/**`, `docs/testing/**`, `playwright.config.ts` |
| Platform & CI | `upgrade/platform-ci` | `TournamentScheduler-worktrees/platform` | `.github/**`, `infra/**`, `compose.yaml`, `web/vercel.json`, `docs/deployment/**` |
| Security Review | `upgrade/security-review` | `TournamentScheduler-worktrees/security` | `tests/security/**`, `docs/security/**` |

Branches are based on the integration branch. Agents may read all files but may not modify another workstream's paths. Unit tests stay with the code they test. Shared manifests and root configuration are lead-owned; agents request dependencies/configuration changes through the lead. Existing `web/src/lib/**`, `web/src/types/**`, `web/views/**`, `web/public/**`, and `web/database/**` are treated as legacy read-only until equivalent behavior is integrated and reviewed.

## Execution sequence

1. Planning docs (parallel, disjoint paths); lead reviews and integrates by PR.
2. Shared tooling, contract generation, test commands and CI baseline (lead/platform).
3. Implementation streams in parallel against frozen OpenAPI/repository/domain contracts: persistence, domain, backend, frontend.
4. Quality agent writes independent API/database/browser tests against integrated behavior; security agent writes adversarial regression tests and reviews implementation.
5. Resolve test/security findings with the owning code agent; rerun full checks.
6. Prepare release PR from integration to `main`, ready for merge with migration, deployment and review evidence.

## PR requirements

Every agent commits only on its branch and opens a PR targeting `upgrade/tournament-v2`. A PR must state scope, files, tests run, migration impact, contract changes and security considerations. Lead reviews ownership, API compatibility, test evidence, correctness and unresolved comments before merge. Security-sensitive changes also require security review. No agent merges directly to `main` or bypasses PR review.

## Definition of done

- All planning documents committed and mutually consistent.
- Backend-authoritative identity, validation, authorization, schedules, scores and standings.
- Persistent, owner-isolated active tournaments and migration/import path with reconciliation and rollback guidance.
- Vue frontend implements requested core journeys in Norwegian by default.
- Unit, integration, end-to-end and security tests pass.
- CI workflows pass and use least privilege.
- No unresolved critical/high security issue; report records reviewed commit and retest evidence.
- Final PR to `main` is ready to merge.
