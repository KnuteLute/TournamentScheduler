# Testing the Tournament Scheduler v2 API and browser journeys

These tests target the frozen API in `docs/api/openapi.yaml` and the domain behavior in `docs/domain/scheduling-and-standings.md`. They are deliberately independent of implementation internals: REST requests are made through Supertest and state is persisted/read through the API backed by PostgreSQL. Playwright exercises the browser UI with separate browser contexts for guest owners.

## Current integration dependencies

The quality worktree currently has no `/api/v1` router, no `frontend/` application, no `web/db/migrations/`, no HTTP server export for the target API, and no integration/browser test scripts. The only server is the legacy EJS `web/src/app.ts`; the API/database/browser tests cannot pass against it. The root manifest currently contains Jest and ts-jest only, and `web/package.json` still has a placeholder test script.

The lead/platform owner needs to add and lock these root test dependencies (or explicitly approve equivalent versions/locations):

- `supertest` and `@types/supertest` for REST integration requests.
- `pg` and `@types/pg` for disposable PostgreSQL identity/version verification. `pg` is currently a web-only dependency and is not declared at the repository root where the Jest suite runs.
- `@playwright/test` for browser journeys; install the Chromium browser in CI with `npx playwright install --with-deps chromium` (or the platform-approved pinned image).

Suggested root scripts, once the app launch/migration commands are established:

```json
{
  "test:integration": "jest --runInBand tests/integration",
  "test:e2e": "playwright test --config=playwright.config.ts"
}
```

The application workstream must provide a test-mode API server on a configurable loopback port and serve the frontend at that same origin. Do not bind test automation to the legacy EJS routes or add test-only production endpoints. The API server must read `POSTGRES_URL`, use the normal migration path, and fail closed for missing session secrets outside test mode.

## Safe local/CI setup

Use a unique disposable PostgreSQL database for every job/run. Apply the actual migrations before starting the API. Never use a developer shared database, preview/production URL, or production secret. The integration harness refuses to run unless all of these are true:

- `NODE_ENV=test`.
- `POSTGRES_URL` connects to the same database name set in `TEST_DATABASE_NAME`, and its host is loopback-only.
- The database name contains a delimited `test`, `tests`, or `ci` marker, and PostgreSQL is version 14 or newer.
- `TEST_API_ORIGIN` is a loopback URL (for example `http://127.0.0.1:4173`); remote hosts are rejected.

For browser tests set `E2E_BASE_URL` to the same loopback application. Inject `TEST_ACCOUNT_PASSWORD` (at least 12 characters) and the app's disposable test-only session secret from the runner environment; do not put values in source, shell transcripts, artifacts, or logs. Browser contexts are isolated, and test recording is disabled to avoid retaining cookies or personal data. Tests create unique synthetic records and assume the database is disposable; they do not truncate tables or run cleanup SQL.

The expected sequence after the lead adds the server/migration scripts is:

1. Create a fresh database such as `tournament_quality_test_<run-id>` and set matching `TEST_DATABASE_NAME` / `POSTGRES_URL` values.
2. Run the normal migration command against that database.
3. Start the API + frontend in test mode bound to `127.0.0.1` with a synthetic test-only secret.
4. Run `npm run test:integration` with `TEST_API_ORIGIN` set.
5. Run `npm run test:e2e` with `E2E_BASE_URL` set.
6. Stop the service and discard the entire disposable database using the CI service lifecycle, never a production or shared database command.

The exact migration, server-start, and test-secret environment variable names remain integration dependencies because those commands/configuration are lead/backend-owned and do not yet exist in this worktree.

## API coverage

`tests/integration/rest-api.integration.test.ts` covers:

- Missing session, guest bootstrap cookie properties, CSRF rejection, and no mutation after rejection.
- Server-side owner isolation for player, team, tournament, and overall-history reads; foreign resources are expected to look absent (`404`).
- Strict body/query validation, normalized-name uniqueness, player ETags (`428` missing / `412` stale), and team roster ownership/uniqueness.
- Idempotent concurrent player creation and changed-payload conflict for a reused key.
- Tournament start, persisted schedule/matches, match start/pause/resume/score, skip behavior, computed tournament and overall standings, and exclusion of skipped matches.
- Concurrent state transitions and score retries, guest-to-account transfer/claim collision handling, and independent simultaneous guest tournaments.

The suite deliberately verifies API-visible outcomes, not repository table names or implementation SQL. PostgreSQL is verified by an isolated connection check; the application under test must use the same `POSTGRES_URL`.

## Browser journeys and selector contract

The Playwright tests use Norwegian-default UI text and stable `data-testid` selectors so labels can evolve without relying on CSS or translated copy. The frontend integration must expose these selectors (including the actions represented by them):

`app-shell`, `player-name-input`, `add-player-button`, `player-row`, `new-tournament-button`, `tournament-name-input`, `mode-option` (with `data-mode`), `mode-2v2_rotating`, `tournament-player-option`, `create-tournament-button`, `tournament-detail`, `start-tournament-button`, `tournament-status`, `tournament-pause-button`, `tournament-resume-button`, `match-start-button`, `match-pause-button`, `match-status`, `match-resume-button`, `score-side-1-input`, `score-side-2-input`, `submit-score-button`, `skip-next-match-button`, `latest-match-status`, `finish-tournament-button`, `nav-standings`, `standings-player-row`, `nav-history`, `history-tournament-row`, `register-link`, `username-input`, `password-input`, `register-submit`, `account-menu`, `transfer-status`, and `tournament-row`.

Status markers expose machine values via `data-status` (`draft`, `active`, `paused`, `completed`, or `skipped`). The browser helper also asserts a Norwegian `no`/`nb` document language and visible Norwegian tournament/player/match text; the mode chooser's first option must be `2v2_rotating`.

The current frontend is not present in this worktree. The Vue/frontend owner should align accessible controls and test IDs with this list or coordinate a contract update before quality checks are wired as required CI gates.
