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

The Vite development server serves the SPA at `/app/`; API requests stay same-origin at `/api/v1`. The production build uses base `/app/` and writes to `../web/public/app`, matching the existing Express/Vercel static path. The frontend agent does not own `web/**`; verify the integration server's static mount and SPA fallback before release.

## Root workspace coordination

Root manifests and `README.md` are lead-owned and intentionally unchanged. The integration owner should add the frontend install/test/typecheck/build commands to the root `README.md` and decide whether root npm workspaces are appropriate. The frontend currently has its own `package.json` and committed lockfile; it does not depend on root workspace hoisting or modify the existing `web/package.json`.

## API contract notes

- The client sends `credentials: 'same-origin'`, disables cached API reads, and sends the current session CSRF token on cookie-authenticated mutations.
- Mutations use a new `Idempotency-Key`. The guest-session bootstrap is the documented exception.
- Create requests do not send `If-Match`. Before editing/deleting an existing player or team, the client GETs that resource and uses its latest ETag. Before tournament lifecycle/availability commands and match commands/results, it GETs the tournament and uses the parent tournament ETag. Guest claim similarly GETs `/session` for its ETag.
- The frontend does not generate schedules, calculate standings, or authorize actions. It renders server responses and reloads after accepted mutations. Form constraints are usability hints only; API validation and authorization remain authoritative.
- RFC problem responses are surfaced with localized status guidance for session/authentication (401), CSRF/origin rejection (403), conflicts (409), stale preconditions (412), field validation (422), and rate limiting (429).

## Contract limitation to resolve

`GET /session` exposes `pendingGuestClaim` as a boolean but no pending guest conflict details. The conflict list is returned only by the login/register `AuthResult.transfer`. A user whose browser reloads after a pending guest claim cannot reconstruct which resources need names from the current contract. The UI can resolve conflicts during the authentication response flow; after reload it reports the limitation rather than guessing names or IDs. Consider adding an owner-authorized pending-claim details operation or including safe conflict summaries in the session representation.

## Accessibility and scope

The app defaults to Norwegian, includes semantic navigation/landmarks, visible keyboard focus, form labels, status/error live regions, responsive layouts, and reduced-motion handling. Fixed 2v2 teams can be created, renamed, and managed, but fixed mode is deliberately omitted from tournament mode selection as required by the domain contract.
