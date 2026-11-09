# Testing the Tournament Scheduler v2 API and browser journeys

The root workspace now contains the API, Vue application, and test tooling. The integration suite exercises the HTTP API through Supertest against a locally running server configured with PostgreSQL; Playwright exercises the built SPA at the same origin. The test target is the contract in `docs/api/openapi.yaml` and the domain rules in `docs/domain/scheduling-and-standings.md`.

## Available workspace tooling

Run commands from the repository root. The root workspace requires Node `>=22.12.0`; `npm ci` installs the locked workspaces (`web`, `frontend`, and `packages/contracts`). Root test dependencies include Jest `^29.7.0` / ts-jest `^29.4.9`, Supertest `^7.1.1` / `@types/supertest` `^6.0.3`, PostgreSQL `pg` `^8.20.0` / `@types/pg` `^8.20.0`, and Playwright `@playwright/test` `^1.52.0`. The Playwright project is Chromium-only; install its browser where needed with `npx playwright install chromium` (CI may use its approved pinned browser image).

Current root scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | Build contracts, web server, and Vue SPA; the frontend build targets `web/public/app`. |
| `npm run typecheck` | Typecheck each workspace. |
| `npm run test:unit` | Root Jest plus web and frontend unit suites. |
| `npm run test:integration` | Run `jest.integration.config.js` in-band, then `web`'s `test:api-store` and `test:rate-limit-postgres` PostgreSQL checks. |
| `npm run test:security` | Run the security regression suite. |
| `npm run test:e2e` | Run `playwright.config.ts` against the loopback app origin. |
| `npm test` | Run unit, integration, security, and E2E suites. |
| `npm run lint` | Lint maintained web/API/domain/service, frontend, and contracts sources. |
| `npm run contract:check` | Lint the OpenAPI contract. |

In `web/package.json`, `npm run db:migrate --prefix web` is the migration-apply command; it invokes `ts-node scripts/migrate.ts --apply`. The server command is `npm start --prefix web`, which starts `dist/server.js`. Build before starting so the server and SPA assets are present.

## Local test configuration and safe run order

The app loads the repository-root `.env`. Create a local ignored `.env` for this run; do not copy production values or print the file. Configure the following names with disposable test values:

- `NODE_ENV=test`, `DB_MODE=postgres`, and `PORT=4173` (optionally `HOST=127.0.0.1`; that is also the server default).
- `POSTGRES_URL` must connect to a disposable, loopback PostgreSQL database. `TEST_DATABASE_NAME` must exactly match its database name, with a delimited `test`, `tests`, or `ci` marker. The integration preflight requires PostgreSQL 14 or newer.
- `POSTGRES_TEST_DATABASE_URL` and `RATE_LIMIT_TEST_DATABASE_URL` must point to that same disposable database; the web-side PostgreSQL integration scripts read these dedicated names.
- `API_ORIGIN=http://127.0.0.1:4173` so same-origin checks match the browser/API origin.
- `API_SESSION_HASH_SECRET` must be a test-only value of at least 32 bytes (hex or base64url). Never reuse a production or shared secret.
- `API_TRUSTED_PROXY_HOPS=0` for this directly bound local server; do not set a trusted proxy hop for local tests.
- `TEST_API_ORIGIN` and `E2E_BASE_URL` must both be the loopback origin `http://127.0.0.1:4173` (no path, credentials, query, or fragment).
- `TEST_ACCOUNT_PASSWORD` is an injected synthetic test credential of at least 12 characters. It is read from the test environment and is not embedded in source.

The integration and Playwright configs reject non-test mode, remote API/database hosts, and database names that do not match `TEST_DATABASE_NAME` and the test-name marker. Use a fresh database for each job/run. Tests create unique synthetic records and do not truncate tables or run cleanup SQL. Do not run these suites against a developer-shared, preview, or production database.

After the PostgreSQL service and disposable database are provisioned, the intended sequence is:

```sh
npm ci
npm run build
npm run db:migrate --prefix web
PORT=4173 npm start --prefix web
```

With that server running, execute in a separate terminal with the same test-only environment:

```sh
npm run test:integration
npm run test:e2e
```

The root `.env` supplies the server's `POSTGRES_URL`, `API_ORIGIN`, and session/proxy settings. `TEST_API_ORIGIN`, `E2E_BASE_URL`, `POSTGRES_TEST_DATABASE_URL`, `RATE_LIMIT_TEST_DATABASE_URL`, `TEST_DATABASE_NAME`, and `TEST_ACCOUNT_PASSWORD` are test-runner settings and must point to/use the same disposable test setup. The SPA is served below `/app/`; Playwright uses the origin root and follows the server's redirect to `/app/`.

## Persistence integration status and limits

`web/src/app.ts` mounts `/api/v1` and serves the SPA; it delegates PostgreSQL operations to `./persistence/api-store`. The PostgreSQL ApiStore, migration runner, and migrations `0001`–`0004` are present. `npm run db:migrate --prefix web` invokes `ts-node scripts/migrate.ts --apply`; the read-only status command reported versions 1–4 applied in the supplied test database. Do not substitute the legacy `web/scripts/init-db.ts` for this versioned migration path.

**Latest local integration attempt:** the root Jest REST suite compiled and ran but all 11 tests failed during guest bootstrap: `POST /api/v1/sessions` returned `500 internal-error`. A direct isolated ApiStore `session.createGuest` call returned PostgreSQL SQLSTATE `42P08` (ambiguous parameter type). The standalone `web` ApiStore PostgreSQL script also failed with its sanitized failure message. The PostgreSQL rate-limit script failed as well; a concurrent probe observed all 20 attempts allowed at a configured maximum of 5 while the stored counter stopped at 5. These are backend/persistence defects for the owning team to resolve; the QA assertions have not been weakened.

Because session bootstrap fails, the REST suite did not verify session/owner writes, player/team/tournament/match operations, idempotency, transaction rollback, ETag/concurrent-write behavior, account transfer, derived standings, or restart-safe isolation. The API router tests use mocked `ApiStore` implementations and are not evidence of successful PostgreSQL integration. Rerun the root `npm run test:integration` after the ApiStore/session audit insert and rate-limit admission behavior are corrected.

Do not report integration or E2E checks as passing unless they have been run against the disposable PostgreSQL service and running app. Keep browser recordings disabled; the Playwright config disables traces, screenshots, and video to avoid retaining session material or synthetic account details.

## REST integration coverage

`tests/integration/rest-api.integration.test.ts` currently covers guest session bootstrap/cookie properties, CSRF rejection and no-side-effect behavior, validation and canonical-name uniqueness, player and team ownership, ETags, fixed-team tournament snapshots, schedule and match reads, start/pause/resume/score/skip transitions, standings/history scope, idempotency replay and payload conflicts, concurrent mutations, guest-to-account transfer/claim conflicts, and simultaneous guest tournaments.

`tests/helpers/api-client.ts` checks that `POSTGRES_URL` is a loopback connection to the named disposable test database and verifies PostgreSQL version before the suite proceeds. API requests use the loopback `TEST_API_ORIGIN`; session cookie values are kept in test memory only and are not logged.

## Browser journeys and verified frontend selectors

The current Vue source does **not** define `data-testid` or `data-status` attributes. Browser tests use the accessible roles/names and existing DOM class hooks visible in `frontend/src/App.vue` and `frontend/src/views/*.vue`; they do not depend on invented test IDs.

Selectors used by `tests/helpers/browser.ts` and `tests/e2e/critical-journeys.spec.ts` were checked against the current frontend:

| Journey element | Current selector / accessible name |
| --- | --- |
| App shell and language | `nav[aria-label="Hovedmeny"]`, `html[lang="nb"]`; Norwegian copy is present in the page body. |
| Player management | Link `Spillere og lag`; label `Navn på ny spiller`; button `Legg til`; `.person-row`. |
| Tournament setup | Link `Oversikt`; link text `Opprett turnering` or `Lag din første turnering`; label `Turneringsnavn`; role `radio` named `2 mot 2 · roterende lag`; player checkbox labels are their player names; button `Opprett kladd`. The rotating option is first in the current `modes` array and selected by default. |
| Tournament detail and controls | Heading is the tournament name; start button `Start turneringen`; pause/resume buttons `Ⅱ Pause turnering` / `Fortsett turnering`; status `.hero-status .status-pill` uses `Pågår`, `Satt på pause`, or `Ferdig`. |
| Match controls and score | Match cards `.match-card`; start `Start kamp`; pause/resume `Ⅱ Pause` / `Fortsett kamp`; score fields `.score-form input[type=number]`; save `Lagre resultat`; skip `Hopp over`; match status `.match-card .status-pill` includes `Pause`, `Ferdig`, or `Hoppet over`. |
| Standings/history | `.standings-card tbody tr`; nav link `Historikk`; history entries `.history-item`. |
| Guest-to-account transfer | Link `Logg inn`; auth switch button `Ny her? Opprett konto`; labels `Brukernavn` and `Passord`; submit button `Opprett konto`; signed-in username `.account-label`. |

The browser suite covers a guest tournament with pause/score/skip and standings/history, preservation of a guest player through registration, and isolation across two independent guest browser contexts. These selectors reflect the currently read Vue templates; if the frontend changes its accessible copy or structure, update the tests to match the reviewed UI rather than introducing selectors that are not present.
