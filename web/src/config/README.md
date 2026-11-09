# API proxy and health configuration

`API_TRUSTED_PROXY_HOPS` defaults to `0`. In direct mode, API rate-limit keys use the normalized TCP peer address and ignore all forwarding headers.

Set `API_TRUSTED_PROXY_HOPS=1` for Vercel only after platform/security review confirms that exactly one trusted proxy hop reaches Express and that the proxy appends or replaces `X-Forwarded-For` with the actual peer address. The API reads a bounded, right-to-left chain and selects the address at the configured hop boundary; malformed or too-short chains are rejected. Do not set this value based only on the presence of the header. The setting is bounded to `0..8`.

Health routes are `/health/live` (process liveness only) and `/health/ready` (read-only persistence readiness). When this router is mounted at `/api/v1`, their full paths are `/api/v1/health/live` and `/api/v1/health/ready`.
