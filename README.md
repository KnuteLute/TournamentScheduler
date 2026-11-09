# Tournament Scheduler

A Norwegian-first tournament scheduler being upgraded from the legacy Express/EJS application to a Vue 3 frontend and an owner-scoped, versioned REST API. See [architecture.md](architecture.md), the [OpenAPI contract](docs/api/openapi.yaml), and the [database/migration plan](docs/database/migration-plan.md).

## Features

- Create tournaments; manage players and reusable doubles teams.
- Generate 1v1 and fixed-team round-robin schedules and live rotating 2v2 matches.
- Record results, pauses, skips, history, and independently computed player/team standings.
- Use as a guest or register/sign in to transfer guest data to an account.
- Vue 3 + TypeScript web app at `/app/`; Express REST API at `/api/v1`.

Fixed 2v2 remains supported by the backend but is intentionally omitted from the mode chooser; rotating 2v2 appears first.

## Local development

Requirements: Node.js 22+, npm, and Docker Compose for PostgreSQL.

1. Copy `.env.example` to `.env` in the repository root. Generate a unique local API secret, for example:

   ```sh
   openssl rand -hex 32
   ```

   Set the resulting value as `API_SESSION_HASH_SECRET`; do not commit `.env` or reuse production secrets.

2. Start the disposable local PostgreSQL service:

   ```sh
   docker compose up -d postgres
   ```

3. Install dependencies, apply local migrations, and start Express:

   ```sh
   npm ci
   npm run db:migrate --prefix web
   npm run build
   npm start --prefix web
   ```

   The API server listens on `127.0.0.1:3000` by default.

4. In another terminal, start Vue/Vite:

   ```sh
   npm run dev --prefix frontend
   ```

   Open `http://localhost:5173/app/`. Vite proxies `/api` to Express and preserves the browser `Origin`; set local `API_ORIGIN=http://localhost:5173` in `.env`. For a production/static deployment, `API_ORIGIN` must be the exact public HTTPS site origin.

The v2 API requires PostgreSQL. The old local JSON database is not an API storage adapter. Do not select an offline mode in production.

## Database and optional legacy data

For the simplest V2 rollout, provision a **new empty PostgreSQL database** and point `POSTGRES_URL` at it. The V1 database can remain untouched and available for manual/reference access; V2 does not need an in-place conversion or a destructive reset. Migrations never drop or wipe an existing database.

- `npm run db:migrate:status --prefix web` inspects migration state without writes.
- `npm run db:migrate --prefix web` explicitly applies versioned schema migrations. It is not run at application startup.
- Legacy import is optional. `npm run db:import:legacy --prefix web -- --source postgres --dry-run` produces an inventory/reconciliation summary without writes. The importer quarantines unverifiable guest ownership; it never grants access based on a raw legacy guest cookie.
- Only if legacy data is explicitly needed: take and test a backup, review the dry-run, and follow the checkpoint/quarantine steps in [database operations](docs/database/persistence-operations.md). Do not point V2 at an old database and assume its legacy records become available automatically. CI uses disposable databases only.

## Verification commands

```sh
npm run lint
npm run typecheck
npm run contract:check
npm run test:unit
npm run test:integration   # requires isolated PostgreSQL + test API server env
npm run test:security
npm run test:e2e           # requires isolated PostgreSQL + local app + Playwright Chromium
npm run build
```

Integration/E2E helpers reject non-loopback or non-test database/API URLs. Never point them at production or shared developer databases.

## Production configuration

Vercel receives environment values through its protected project settings, not this repository. Required runtime values include:

- `POSTGRES_URL` — managed PostgreSQL URL with TLS (`sslmode=require` or stricter).
- `API_SESSION_HASH_SECRET` — independently generated secret of at least 32 bytes; there is no production fallback.
- `API_ORIGIN` — exact public HTTPS origin used for same-origin/CSRF checks.
- `API_TRUSTED_PROXY_HOPS=1` only after verifying the Vercel proxy chain for the deployed project; otherwise leave proxy trust disabled.

Do not run schema migration/import commands from a Vercel preview or function startup. Apply production migrations as an explicit, backed-up, reviewed operation. See the [security review](docs/security/review.md) and [deployment plan](docs/deployment/ci-and-rollout-plan.md).
