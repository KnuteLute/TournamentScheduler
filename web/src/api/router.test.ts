import assert from "assert";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApiRouter } from "./router";
import type { ApiConfig } from "../config/api";
import { csrfForSession, newOpaqueCredential, protectedHash } from "../auth/credentials";
import type { ApiStore, RateLimitRequest, SessionRecord, StoreRequest } from "../services/ports";
import { createApiConfig } from "../config/api";

const cases: Array<{ name: string; run: () => Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void {
	cases.push({ name, run });
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
};

interface TestResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

async function withApi<T>(store: ApiStore, work: (port: number) => Promise<T>): Promise<T> {
	const app = express();
	app.use("/api/v1", createApiRouter(store, config));
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

function mockStore(options: { session?: SessionRecord; allowRate?: boolean; value?: unknown } = {}): { store: ApiStore; operations: StoreRequest[]; rateRequests: RateLimitRequest[] } {
	const operations: StoreRequest[] = [];
	const rateRequests: RateLimitRequest[] = [];
	const store: ApiStore = {
		lookupSessionByTokenHash: async () => options.session ?? null,
		findAccountByUsernameKey: async () => null,
		consumeRateLimit: async (request) => {
			rateRequests.push(request);
			return { allowed: options.allowRate ?? true, retryAfterSeconds: 30 };
		},
		execute: async <T>(request: StoreRequest) => {
			operations.push(request);
			return { value: (options.value ?? { ok: true }) as T, etag: "v1" };
		},
		healthCheck: async () => true,
	};
	return { store, operations, rateRequests };
}

test("health is read-only and protected resources reject missing sessions", async () => {
	const { store, operations } = mockStore();
	await withApi(store, async (port) => {
		const health = await send(port, "GET", "/api/v1/health");
		assert.equal(health.status, 200);
		const players = await send(port, "GET", "/api/v1/players");
		assert.equal(players.status, 401);
		assert.equal(operations.length, 0);
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
		assert.equal(rateRequests.length, 2);
		assert.match(rateRequests[0]?.bucketHash ?? "", /^[a-f0-9]{64}$/);
		assert.equal(rateRequests[0]?.bucketHash.includes("203.0.113.44"), false);
		assert.equal(rateRequests[0]?.bucketHash, rateRequests[1]?.bucketHash);
	});
	assert.throws(() => createApiConfig({ NODE_ENV: "production", API_ORIGIN: "https://api.example.test" }), /API_SESSION_HASH_SECRET/);
});

test("guest bootstrap requires same-origin metadata and sets a secure opaque cookie", async () => {
	const { store, operations } = mockStore();
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
		assert.equal(JSON.parse(created.body).csrfToken.length, 43);
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
