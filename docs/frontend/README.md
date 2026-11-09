# Vue frontend

The Vue 3 + TypeScript SPA is self-contained in `frontend/`. It uses Vite, Vue Router, Pinia, and Vitest. No generated OpenAPI TypeScript package is present on the frontend workstream base, so `frontend/src/api/types.ts` and `frontend/src/api/client.ts` define a narrow typed client aligned to `docs/api/openapi.yaml`.

## Local commands

Run these commands from `frontend/`:

```sh
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

### Local development servers

Run the API server and Vite in separate terminals from the repository root. Start the API server with the Vite browser origin allowed by the backend's origin/CSRF checks:

```sh
API_ORIGIN=http://localhost:5173 npm run dev --prefix web
npm run dev --prefix frontend
```

The API server listens on `127.0.0.1:3000` (keep that port available); open the frontend at `http://localhost:5173/app/`. Vite's development-only `/api` proxy forwards to `http://127.0.0.1:3000` with `changeOrigin: false` and does not rewrite the path or `Origin` header. The API therefore validates the actual browser origin `http://localhost:5173`; the proxy target is not an allowed-origin setting. Do not configure the proxy to replace or trust `Origin`. If the backend origin/port changes, update the frontend proxy and the backend `API_ORIGIN` deliberately.

The production build uses base `/app/` and writes to `../web/public/app`, matching the existing Express/Vercel static path. The Vite proxy is not included in production; verify the integration server's static mount and SPA fallback before release.

## Root workspace coordination

Root manifests and `README.md` are lead-owned and intentionally unchanged. The integration owner should add the frontend install/test/typecheck/build commands to the root `README.md` and decide whether root npm workspaces are appropriate. Dependency overrides are root-owned; the frontend package and lockfile intentionally contain no overrides. The frontend currently has its own `package.json` and committed lockfile and does not modify the existing `web/package.json`.

The standalone lockfile retains the toolchain's declared dependency ranges. Apply the root-owned `minimatch` override in the repository workspace install; do not copy it into this package manifest.

## API contract notes

- The client sends `credentials: 'same-origin'`, disables cached API reads, and sends the current session CSRF token on cookie-authenticated mutations.
- Mutations use a new `Idempotency-Key`. The guest-session bootstrap is the documented exception.
- Create requests do not send `If-Match`. Before editing/deleting an existing player or team, the client GETs that resource and uses its latest ETag. Before tournament lifecycle/availability commands and match commands/results, it GETs the tournament and uses the parent tournament ETag. For guest claim, the client GETs `/session/claim` to load pending conflict summaries and uses its session ETag for the CSRF-protected, idempotent POST.
- The frontend does not generate schedules, calculate standings, or authorize actions. It renders server responses and reloads after accepted mutations. Form constraints are usability hints only; API validation and authorization remain authoritative.
- RFC problem responses are surfaced with localized status guidance for session/authentication (401), CSRF/origin rejection (403), conflicts (409), stale preconditions (412), field validation (422), and rate limiting (429).

## Guest-claim resume flow

When `GET /session` reports `pendingGuestClaim: true`, the Pinia session store fetches authenticated `GET /session/claim`, keeps its conflict summaries and ETag in memory, and renders the explicit rename form after a reload. Conflict summaries use `entityKind`, `resourceId`, `displayName`, and `collisionNames`; the POST maps these to the contract's `resourceType`, `guestResourceId`, and `newName` fields. Submission refreshes `/session/claim` for the current session ETag, then sends the requested names with CSRF and an idempotency key. A stale `412` is surfaced safely and the form can be submitted again using a fresh ETag.

## Accessibility and scope

The app defaults to Norwegian, includes semantic navigation/landmarks, visible keyboard focus, form labels, status/error live regions, responsive layouts, and reduced-motion handling. Fixed 2v2 teams can be created, renamed, and managed, but fixed mode is deliberately omitted from tournament mode selection as required by the domain contract.
