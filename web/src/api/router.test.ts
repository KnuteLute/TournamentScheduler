import assert from "assert";
import bcrypt from "bcrypt";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApiRouter } from "./router";
import type { ApiConfig } from "../config/api";
import { csrfForSession, newOpaqueCredential, protectedHash } from "../auth/credentials";
import type { AccountCredential, ApiStore, RateLimitRequest, SessionRecord, StoreRequest } from "../services/ports";
import { createApiConfig } from "../config/api";
import { bodyValidators, validateLoginCredentials, validateRegisterCredentials } from "./validation";
import { ApiProblem } from "./problem";

const cases: Array<{ name: string; run: () => Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void {
	cases.push({ name, run });
}

function assertValidationFailure(run: () => unknown, fieldCode: string): void {
	assert.throws(run, (error: unknown) => error instanceof ApiProblem && error.errors?.some((issue) => issue.code === fieldCode) === true);
}

const config: ApiConfig = {
	origin: "http://localhost",
	production: false,
	sessionHashSecret: Buffer.alloc(32, 7),
	sessionLifetimeMs: 60_000,
	maxBodyBytes: 32 * 1024,
	rateLimitWindowMs: 60_000,
	rateLimitMax: 100,
	loginRateLimitMax: 10,
	bcryptRounds: 10,
	trustedProxyHops: 0,
};

interface TestResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

async function withApi<T>(store: ApiStore, work: (port: number) => Promise<T>, apiConfig: ApiConfig = config): Promise<T> {
	const app = express();
	app.use("/api/v1", createApiRouter(store, apiConfig));
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		return await work(address.port);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		request.on("error", reject);
		if (body !== undefined) request.write(body);
		request.end();
	});
}

function mockStore(options: { session?: SessionRecord; account?: AccountCredential | null; allowRate?: boolean; healthy?: boolean; value?: unknown } = {}): { store: ApiStore; operations: StoreRequest[]; rateRequests: RateLimitRequest[]; accountLookups: string[] } {
	const operations: StoreRequest[] = [];
	const rateRequests: RateLimitRequest[] = [];
	const accountLookups: string[] = [];
	const store: ApiStore = {
		lookupSessionByTokenHash: async () => options.session ?? null,
		findAccountByUsernameKey: async (usernameKey) => {
			accountLookups.push(usernameKey);
			return options.account ?? null;
		},
		consumeRateLimit: async (request) => {
			rateRequests.push(request);
			return { allowed: options.allowRate ?? true, retryAfterSeconds: 30 };
		},
		execute: async <T>(request: StoreRequest) => {
			operations.push(request);
			return { value: (options.value ?? { ok: true }) as T, etag: "v1" };
		},
		healthCheck: async () => options.healthy ?? true,
	};
	return { store, operations, rateRequests, accountLookups };
}

test("health is read-only and protected resources reject missing sessions", async () => {
	const { store, operations, rateRequests } = mockStore();
	await withApi(store, async (port) => {
		const live = await send(port, "GET", "/api/v1/health/live");
		assert.equal(live.status, 200);
		assert.deepEqual(JSON.parse(live.body), { status: "live" });
		assert.equal(live.headers["cache-control"], "no-store");
		assert.equal(rateRequests.length, 0);
		const ready = await send(port, "GET", "/api/v1/health/ready");
		assert.equal(ready.status, 200);
		assert.deepEqual(JSON.parse(ready.body), { status: "ready" });
		assert.equal(ready.headers["cache-control"], "no-store");
		assert.equal(rateRequests.length, 1);
		const players = await send(port, "GET", "/api/v1/players");
		assert.equal(players.status, 401);
		assert.equal(operations.length, 0);
	});
});

test("readiness failure returns only the documented not_ready status", async () => {
	const { store } = mockStore({ healthy: false });
	await withApi(store, async (port) => {
		const ready = await send(port, "GET", "/api/v1/health/ready");
		assert.equal(ready.status, 503);
		assert.deepEqual(JSON.parse(ready.body), { status: "not_ready" });
		assert.equal(ready.headers["cache-control"], "no-store");
		assert.doesNotMatch(ready.body, /database|connection|string|exception/i);
	});
});

test("liveness bypasses rate limits while readiness is rate limited", async () => {
	const { store, rateRequests } = mockStore({ allowRate: false });
	await withApi(store, async (port) => {
		const live = await send(port, "GET", "/api/v1/health/live");
		assert.equal(live.status, 200);
		assert.equal(rateRequests.length, 0);
		const ready = await send(port, "GET", "/api/v1/health/ready");
		assert.equal(ready.status, 429);
		assert.equal(ready.headers["retry-after"], "30");
		assert.equal(rateRequests.length, 1);
	});
});

test("rate limiting uses opaque TCP-peer buckets and production config fails closed", async () => {
	const { store, rateRequests } = mockStore({ allowRate: false });
	await withApi(store, async (port) => {
		const limited = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "203.0.113.44" });
		assert.equal(limited.status, 429);
		assert.equal(limited.headers["retry-after"], "30");
		const samePeer = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "198.51.100.72" });
		assert.equal(samePeer.status, 429);
		const ignoredHeader = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "not-an-ip" });
		assert.equal(ignoredHeader.status, 429);
		assert.equal(rateRequests.length, 3);
		assert.match(rateRequests[0]?.bucketHash ?? "", /^[a-f0-9]{64}$/);
		assert.equal(rateRequests[0]?.bucketHash.includes("203.0.113.44"), false);
		assert.equal(rateRequests[0]?.bucketHash, rateRequests[1]?.bucketHash);
		assert.equal(rateRequests[0]?.bucketHash, rateRequests[2]?.bucketHash);
	});
	assert.throws(() => createApiConfig({ NODE_ENV: "production", API_ORIGIN: "https://api.example.test" }), /API_SESSION_HASH_SECRET/);
	assert.equal(createApiConfig({}).trustedProxyHops, 0);
});

test("trusted proxy mode ignores forged left-most forwarding entries", async () => {
	const { store, rateRequests } = mockStore({ allowRate: false });
	const proxyConfig = { ...config, trustedProxyHops: 1 };
	await withApi(store, async (port) => {
		const first = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "203.0.113.8, 198.51.100.27" });
		const forged = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "192.0.2.99, 198.51.100.27" });
		assert.equal(first.status, 429);
		assert.equal(forged.status, 429);
		assert.equal(rateRequests[0]?.bucketHash, rateRequests[1]?.bucketHash);
		const changedClient = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "203.0.113.8, 198.51.100.28" });
		assert.equal(changedClient.status, 429);
		assert.notEqual(rateRequests[0]?.bucketHash, rateRequests[2]?.bucketHash);
		const mappedClient = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "203.0.113.8, ::ffff:198.51.100.27" });
		assert.equal(mappedClient.status, 429);
		assert.equal(rateRequests[0]?.bucketHash, rateRequests[3]?.bucketHash);
		const malformed = await send(port, "GET", "/api/v1/players", { "X-Forwarded-For": "203.0.113.8, not-an-ip" });
		assert.equal(malformed.status, 400);
		assert.equal(rateRequests.length, 4);
	}, proxyConfig);
});

test("invalid or expired presented session cookies are expired and never bootstrap", async () => {
	const { store } = mockStore();
	await withApi(store, async (port) => {
		for (const cookie of ["__Host-ts_session=bad", `__Host-ts_session=${newOpaqueCredential()}`]) {
			const response = await send(port, "POST", "/api/v1/sessions", { Cookie: cookie, Origin: config.origin });
			assert.equal(response.status, 401);
			const setCookie = response.headers["set-cookie"]?.[0] ?? "";
			assert.match(setCookie, /^__Host-ts_session=;/);
			assert.match(setCookie, /Expires=Thu, 01 Jan 1970/);
			assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
		}
	});
});

test("login and registration use distinct password length rules and bcrypt byte limits", async () => {
	const login = bodyValidators["auth.login"]!;
	const register = bodyValidators["auth.register"]!;
	assert.equal((login({ username: "legacy", password: "secret" }) as { password: string }).password, "secret");
	assertValidationFailure(() => register({ username: "newaccount", password: "12345678901" }), "length");
	assert.equal((validateRegisterCredentials({ username: "newaccount", password: "123456789012" }) as { password: string }).password, "123456789012");
	assert.equal((validateLoginCredentials({ username: "legacy", password: "é".repeat(36) }) as { password: string }).password.length, 36);
	assert.equal((validateRegisterCredentials({ username: "newaccount", password: "é".repeat(36) }) as { password: string }).password.length, 36);
	assertValidationFailure(() => validateLoginCredentials({ username: "legacy", password: "é".repeat(37) }), "bcrypt-byte-limit");
	assertValidationFailure(() => validateRegisterCredentials({ username: "newaccount", password: "é".repeat(37) }), "bcrypt-byte-limit");

	const { store, operations, accountLookups, rateRequests } = mockStore();
	await withApi(store, async (port) => {
		const headers = {
			Origin: config.origin,
			"Content-Type": "application/json",
			"Idempotency-Key": "password-boundary-test-001",
		};
		const shortLegacyLogin = await send(port, "POST", "/api/v1/auth/login", headers, JSON.stringify({ username: "legacy", password: "secret" }));
		assert.equal(shortLegacyLogin.status, 401);
		assert.deepEqual(accountLookups, ["legacy"]);
		const beforeRejectedPasswords = rateRequests.length;
		const bcryptMethods = bcrypt as unknown as {
			hash: (...args: unknown[]) => unknown;
			compare: (...args: unknown[]) => unknown;
		};
		const originalHash = bcryptMethods.hash;
		const originalCompare = bcryptMethods.compare;
		let hashCalls = 0;
		let compareCalls = 0;
		bcryptMethods.hash = (...args) => {
			hashCalls += 1;
			return originalHash(...args);
		};
		bcryptMethods.compare = (...args) => {
			compareCalls += 1;
			return originalCompare(...args);
		};
		try {
			const longUtf8Login = await send(port, "POST", "/api/v1/auth/login", headers, JSON.stringify({ username: "legacy", password: "é".repeat(37) }));
			assert.equal(longUtf8Login.status, 422);
			const longUtf8Registration = await send(port, "POST", "/api/v1/auth/register", headers, JSON.stringify({ username: "newaccount", password: "é".repeat(37) }));
			assert.equal(longUtf8Registration.status, 422);
			const shortRegistration = await send(port, "POST", "/api/v1/auth/register", headers, JSON.stringify({ username: "newaccount", password: "12345678901" }));
			assert.equal(shortRegistration.status, 422);
		} finally {
			bcryptMethods.hash = originalHash;
			bcryptMethods.compare = originalCompare;
		}
		assert.equal(hashCalls, 0);
		assert.equal(compareCalls, 0);
		assert.equal(accountLookups.length, 1);
		assert.equal(operations.length, 0);
		assert.equal(rateRequests.length, beforeRejectedPasswords + 3);
	});
});

test("server enforces roster caps and persisted-mode PATCH bounds", async () => {
	const token = newOpaqueCredential();
	const csrf = csrfForSession(token, config);
	const session: SessionRecord = {
		id: "session-roster",
		ownerId: "owner-roster",
		kind: "guest",
		account: null,
		csrfTokenHash: protectedHash(csrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 1,
	};
	const { store, operations } = mockStore({ session, value: { mode: "2v2_fixed" } });
	const ids = (prefix: string, count: number) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
	const headers = {
		Cookie: `__Host-ts_session=${token}`,
		Origin: config.origin,
		"X-CSRF-Token": csrf,
		"Content-Type": "application/json",
		"Idempotency-Key": "roster-validation-key-001",
		"If-Match": '"v1"',
	};
	await withApi(store, async (port) => {
		const tooManyPlayers = await send(port, "POST", "/api/v1/tournaments", headers, JSON.stringify({
			name: "Large roster", mode: "2v2_rotating", playerIds: ids("p", 33),
		}));
		assert.equal(tooManyPlayers.status, 422);
		const tooManyFixedTeams = await send(port, "POST", "/api/v1/tournaments", headers, JSON.stringify({
			name: "Large teams", mode: "2v2_fixed", teamIds: ids("t", 17),
		}));
		assert.equal(tooManyFixedTeams.status, 422);
		const patchHeaders = { ...headers, "Content-Type": "application/merge-patch+json" };
		const tooManyPaused = await send(port, "PATCH", "/api/v1/tournaments/t1/availability", patchHeaders, JSON.stringify({ pausedPlayerIds: ids("p", 33) }));
		assert.equal(tooManyPaused.status, 422);
		const tooManyPatchTeams = await send(port, "PATCH", "/api/v1/tournaments/t1", {
			...patchHeaders,
		}, JSON.stringify({ teamIds: ids("t", 17) }));
		assert.equal(tooManyPatchTeams.status, 422);
		assert.deepEqual(operations.map((request) => request.operation), ["tournaments.get"]);
		assert.equal(operations[0]?.actor?.ownerId, "owner-roster");
	});
});

test("pending claim details are owner-scoped, no-store, and use the session ETag", async () => {
	const token = newOpaqueCredential();
	const csrf = csrfForSession(token, config);
	const session: SessionRecord = {
		id: "session-claim",
		ownerId: "owner-claim",
		kind: "authenticated",
		account: { id: "account-1", username: "member" },
		csrfTokenHash: protectedHash(csrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: true,
		version: 9,
	};
	const { store, operations } = mockStore({
		session,
		value: {
			conflicts: [{ resourceType: "player", guestResourceId: "player-g", guestName: "Alex" }],
			ownerId: "must-not-leak",
		},
	});
	await withApi(store, async (port) => {
		const response = await send(port, "GET", "/api/v1/session/claim", { Cookie: `__Host-ts_session=${token}` });
		assert.equal(response.status, 200);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.equal(response.headers.etag, '"v9"');
		assert.equal(JSON.parse(response.body).ownerId, undefined);
		assert.deepEqual(operations.map((request) => request.operation), ["session.getClaimDetails"]);
		assert.equal(operations[0]?.actor?.ownerId, "owner-claim");
	});
	const otherToken = newOpaqueCredential();
	const otherCsrf = csrfForSession(otherToken, config);
	const noPendingStore = mockStore({
		session: {
			...session,
			id: "session-no-claim",
			ownerId: "owner-no-claim",
			csrfTokenHash: protectedHash(otherCsrf, config),
			pendingGuestClaim: false,
		},
		value: { conflicts: [{ guestName: "foreign detail" }] },
	});
	await withApi(noPendingStore.store, async (port) => {
		const response = await send(port, "GET", "/api/v1/session/claim", { Cookie: `__Host-ts_session=${otherToken}` });
		assert.equal(response.status, 404);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.equal(noPendingStore.operations.length, 0);
	});
});

test("guest bootstrap requires same-origin metadata and sets a secure opaque cookie", async () => {
	const { store, operations } = mockStore({
		value: {
			id: "internal-session-id",
			version: 8,
			ownerId: "internal-owner-id",
			sessionId: "internal-session-id",
			tokenHash: "must-not-leak",
			csrfTokenHash: "must-not-leak",
		},
	});
	await withApi(store, async (port) => {
		const rejected = await send(port, "POST", "/api/v1/sessions", { Origin: "https://attacker.invalid" });
		assert.equal(rejected.status, 403);
		assert.equal(operations.length, 0);
		const created = await send(port, "POST", "/api/v1/sessions", { Origin: config.origin });
		assert.equal(created.status, 201);
		assert.equal(operations[0]?.operation, "session.createGuest");
		assert.ok(operations[0]?.credentials?.sessionTokenHash instanceof Uint8Array);
		assert.equal("sessionToken" in (operations[0]?.credentials ?? {}), false);
		const cookie = created.headers["set-cookie"]?.[0] ?? "";
		assert.match(cookie, /^__Host-ts_session=[A-Za-z0-9_-]{43};/);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /Secure/);
		assert.match(cookie, /SameSite=Lax/);
		assert.match(cookie, /Path=\//);
		const response = JSON.parse(created.body);
		assert.equal(response.csrfToken.length, 43);
		assert.equal(created.headers.etag, '"v1"');
		assert.deepEqual(Object.keys(response).sort(), ["account", "csrfToken", "expiresAt", "kind", "pendingGuestClaim"]);
		assert.doesNotMatch(created.body, /version|ownerId|sessionId|tokenHash|csrfTokenHash/);
	});
});

test("session and login responses omit store-only session version and identifiers", async () => {
	const sessionToken = newOpaqueCredential();
	const sessionCsrf = csrfForSession(sessionToken, config);
	const currentSession: SessionRecord = {
		id: "internal-session-id",
		ownerId: "owner-1",
		kind: "authenticated",
		account: { id: "account-1", username: "legacy" },
		csrfTokenHash: protectedHash(sessionCsrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 12,
	};
	const internalSession = {
		id: "internal-session-id",
		sessionId: "internal-session-id",
		ownerId: "owner-1",
		version: 12,
		tokenHash: "must-not-leak",
		csrfTokenHash: "must-not-leak",
		passwordHash: "must-not-leak",
		kind: "authenticated",
		account: { id: "account-1", username: "legacy", passwordHash: "must-not-leak" },
		expiresAt: currentSession.expiresAt.toISOString(),
		pendingGuestClaim: false,
	};
	const { store } = mockStore({ session: currentSession, value: internalSession });
	await withApi(store, async (port) => {
		const response = await send(port, "GET", "/api/v1/session", { Cookie: `__Host-ts_session=${sessionToken}` });
		assert.equal(response.status, 200);
		assert.equal(response.headers.etag, '"v1"');
		const body = JSON.parse(response.body);
		assert.deepEqual(Object.keys(body).sort(), ["account", "csrfToken", "expiresAt", "kind", "pendingGuestClaim"]);
		assert.equal(body.account.passwordHash, undefined);
		assert.doesNotMatch(response.body, /version|ownerId|sessionId|tokenHash|csrfTokenHash|passwordHash/);
	});

	const passwordHash = await bcrypt.hash("legacy-password", config.bcryptRounds);
	const account: AccountCredential = {
		id: "account-1",
		ownerId: "owner-1",
		username: "legacy",
		usernameKey: "legacy",
		passwordHash,
	};
	const { store: loginStore } = mockStore({
		account,
		value: {
			version: 99,
			ownerId: "top-level-owner",
			session: internalSession,
			transfer: { status: "none", playersTransferred: 0, teamsTransferred: 0, tournamentsTransferred: 0, conflicts: [] },
		},
	});
	await withApi(loginStore, async (port) => {
		const response = await send(port, "POST", "/api/v1/auth/login", {
			Origin: config.origin,
			"Content-Type": "application/json",
			"Idempotency-Key": "session-response-login-key",
		}, JSON.stringify({ username: "legacy", password: "legacy-password" }));
		assert.equal(response.status, 200);
		assert.equal(response.headers.etag, '"v1"');
		const body = JSON.parse(response.body);
		assert.deepEqual(Object.keys(body).sort(), ["session", "transfer"]);
		assert.deepEqual(Object.keys(body.session).sort(), ["account", "csrfToken", "expiresAt", "kind", "pendingGuestClaim"]);
		assert.equal(body.session.pendingGuestClaim, false);
		assert.equal(body.session.account.passwordHash, undefined);
		assert.doesNotMatch(response.body, /version|ownerId|sessionId|tokenHash|csrfTokenHash|passwordHash/);
	});
});

test("cookie writes require session-bound CSRF and a strong If-Match", async () => {
	const token = newOpaqueCredential();
	const csrf = csrfForSession(token, config);
	const session: SessionRecord = {
		id: "session-1",
		ownerId: "owner-1",
		kind: "guest",
		account: null,
		csrfTokenHash: protectedHash(csrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 1,
	};
	const { store, operations } = mockStore({ session });
	await withApi(store, async (port) => {
		const common = {
			Cookie: `__Host-ts_session=${token}`,
			Origin: config.origin,
			"Content-Type": "application/merge-patch+json",
			"Idempotency-Key": "valid-client-generated-key-1",
			"If-Match": '"v1"',
		};
		const noCsrf = await send(port, "PATCH", "/api/v1/players/player-1", common, JSON.stringify({ name: "Alex" }));
		assert.equal(noCsrf.status, 403);
		assert.equal(operations.length, 0);
		const noPrecondition = await send(port, "PATCH", "/api/v1/players/player-1", {
			...common,
			"X-CSRF-Token": csrf,
			"If-Match": "",
		}, JSON.stringify({ name: "Alex" }));
		assert.equal(noPrecondition.status, 428);
		assert.equal(operations.length, 0);
		const accepted = await send(port, "PATCH", "/api/v1/players/player-1", {
			...common,
			"X-CSRF-Token": csrf,
			"Content-Type": "application/merge-patch+json",
		}, JSON.stringify({ name: "Alex" }));
		assert.equal(accepted.status, 200);
		assert.equal(operations.length, 1);
		assert.equal(operations[0]?.actor?.ownerId, "owner-1");
		assert.equal(operations[0]?.expectedETag, '"v1"');
		assert.equal(operations[0]?.idempotency?.anchor, "actor-owner");
	});
});

test("unknown write fields and unsupported query parameters are rejected before persistence", async () => {
	const token = newOpaqueCredential();
	const csrf = csrfForSession(token, config);
	const session: SessionRecord = {
		id: "session-2",
		ownerId: "owner-2",
		kind: "guest",
		account: null,
		csrfTokenHash: protectedHash(csrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 1,
	};
	const { store, operations } = mockStore({ session });
	await withApi(store, async (port) => {
		const headers = {
			Cookie: `__Host-ts_session=${token}`,
			Origin: config.origin,
			"X-CSRF-Token": csrf,
			"Content-Type": "application/json",
			"Idempotency-Key": "another-valid-client-key",
		};
		const unknownField = await send(port, "POST", "/api/v1/players", headers, JSON.stringify({ name: "Alex", ownerId: "foreign" }));
		assert.equal(unknownField.status, 422);
		const unknownQuery = await send(port, "GET", "/api/v1/players?ownerId=foreign", { Cookie: `__Host-ts_session=${token}` });
		assert.equal(unknownQuery.status, 422);
		assert.equal(operations.length, 0);
	});
});

test("resource responses omit persistence-only ownership and credential fields", async () => {
	const token = newOpaqueCredential();
	const csrf = csrfForSession(token, config);
	const session: SessionRecord = {
		id: "session-3",
		ownerId: "owner-3",
		kind: "guest",
		account: null,
		csrfTokenHash: protectedHash(csrf, config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 1,
	};
	const { store } = mockStore({
		session,
		value: { id: "player-1", name: "Alex", ownerId: "owner-3", passwordHash: "must-not-leak" },
	});
	await withApi(store, async (port) => {
		const response = await send(port, "GET", "/api/v1/players/player-1", { Cookie: `__Host-ts_session=${token}` });
		assert.equal(response.status, 200);
		assert.deepEqual(JSON.parse(response.body), { id: "player-1", name: "Alex" });
	});
});

void (async () => {
	for (const item of cases) {
		await item.run();
		console.log(`ok - ${item.name}`);
	}
})().catch((error: unknown) => {
	console.error("API router test failed");
	throw error;
});
