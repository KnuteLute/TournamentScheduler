const assert = require("node:assert/strict");
const { createServer, request: httpRequest } = require("node:http");

require("ts-node/register/transpile-only");

const express = require("express");
const { createApiRouter } = require("../../web/src/api/router.ts");
const { validateLoginCredentials, validateRegisterCredentials } = require("../../web/src/api/validation.ts");
const { csrfForSession, newOpaqueCredential, protectedHash } = require("../../web/src/auth/credentials.ts");
const { createApiConfig } = require("../../web/src/config/api.ts");

const config = {
	origin: "http://localhost",
	production: false,
	sessionHashSecret: Buffer.alloc(32, 19),
	sessionLifetimeMs: 60_000,
	maxBodyBytes: 32 * 1024,
	rateLimitWindowMs: 60_000,
	rateLimitMax: 100,
	loginRateLimitMax: 10,
	bcryptRounds: 10,
	trustedProxyHops: 0,
};

function sessionFor(token, ownerId = "owner-test") {
	return {
		id: "session-test",
		ownerId,
		kind: "guest",
		account: null,
		csrfTokenHash: protectedHash(csrfForSession(token, config), config),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		pendingGuestClaim: false,
		version: 1,
	};
}

function mockStore(options = {}) {
	const operations = [];
	const rateRequests = [];
	const store = {
		lookupSessionByTokenHash: async () => options.session ?? null,
		findAccountByUsernameKey: async () => null,
		consumeRateLimit: async (rateRequest) => {
			rateRequests.push(rateRequest);
			return { allowed: options.allowRate ?? true, retryAfterSeconds: 30 };
		},
		execute: async (operation) => {
			operations.push(operation);
			return { value: { ok: true }, etag: "v1" };
		},
		healthCheck: async () => true,
	};
	return { store, operations, rateRequests };
}

async function withApi(store, work, apiConfig = config) {
	const app = express();
	app.use("/api/v1", createApiRouter(store, apiConfig));
	const server = createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	try {
		return await work(address.port);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

function send(port, method, url, headers = {}, body) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ hostname: "127.0.0.1", port, method, path: url, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({
				status: res.statusCode ?? 0,
				headers: res.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const cases = {
	"invalid-cookie": async () => {
		const { store, operations } = mockStore();
		await withApi(store, async (port) => {
			for (const cookie of ["__Host-ts_session=bad", `__Host-ts_session=${newOpaqueCredential()}`]) {
				const response = await send(port, "POST", "/api/v1/sessions", { Cookie: cookie, Origin: config.origin });
				assert.equal(response.status, 401);
				const expired = response.headers["set-cookie"]?.[0] ?? "";
				assert.match(expired, /^__Host-ts_session=;/);
				assert.match(expired, /Expires=Thu, 01 Jan 1970/);
				assert.match(expired, /HttpOnly; Secure; SameSite=Lax/);
			}
			const recovered = await send(port, "POST", "/api/v1/sessions", { Origin: config.origin });
			assert.equal(recovered.status, 201);
			assert.match(recovered.headers["set-cookie"]?.[0] ?? "", /^__Host-ts_session=[A-Za-z0-9_-]{43};/);
		});
		assert.deepEqual(operations.map((operation) => operation.operation), ["session.createGuest"]);
	},
	"csrf-origin": async () => {
		const token = newOpaqueCredential();
		const csrf = csrfForSession(token, config);
		const { store, operations } = mockStore({ session: sessionFor(token) });
		const base = {
			Cookie: `__Host-ts_session=${token}`,
			"Content-Type": "application/merge-patch+json",
			"Idempotency-Key": "security-test-csrf-key-01",
			"If-Match": '"v1"',
		};
		await withApi(store, async (port) => {
			const noToken = await send(port, "PATCH", "/api/v1/players/player-1", { ...base, Origin: config.origin }, JSON.stringify({ name: "Alex" }));
			assert.equal(noToken.status, 403);
			const foreignOrigin = await send(port, "PATCH", "/api/v1/players/player-1", {
				...base, Origin: "https://attacker.invalid", "X-CSRF-Token": csrf,
			}, JSON.stringify({ name: "Alex" }));
			assert.equal(foreignOrigin.status, 403);
			const crossSite = await send(port, "PATCH", "/api/v1/players/player-1", {
				...base, Origin: config.origin, "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": csrf,
			}, JSON.stringify({ name: "Alex" }));
			assert.equal(crossSite.status, 403);
		});
		assert.equal(operations.length, 0);
	},
	"owner-input": async () => {
		const token = newOpaqueCredential();
		const csrf = csrfForSession(token, config);
		const { store, operations } = mockStore({ session: sessionFor(token) });
		const headers = {
			Cookie: `__Host-ts_session=${token}`,
			Origin: config.origin,
			"X-CSRF-Token": csrf,
			"Content-Type": "application/json",
			"Idempotency-Key": "security-test-owner-key-01",
		};
		await withApi(store, async (port) => {
			const body = await send(port, "POST", "/api/v1/players", headers, JSON.stringify({ name: "Alex", ownerId: "foreign-owner" }));
			assert.equal(body.status, 422);
			assert.match(body.body, /unknown-field/);
			const query = await send(port, "GET", "/api/v1/players?ownerId=foreign-owner", { Cookie: `__Host-ts_session=${token}` });
			assert.equal(query.status, 422);
			assert.match(query.body, /unknown-query/);
		});
		assert.equal(operations.length, 0);
	},
	"forwarded-rate-limit": async () => {
		const { store, rateRequests } = mockStore({ allowRate: false });
		const trustedProxyConfig = { ...config, trustedProxyHops: 1 };
		await withApi(store, async (port) => {
			assert.equal((await send(port, "GET", "/api/v1/health/live")).status, 200);
			assert.equal(rateRequests.length, 0);
			const first = await send(port, "GET", "/api/v1/health/ready", { "X-Forwarded-For": "203.0.113.8, 198.51.100.27" });
			assert.equal(first.status, 429);
			assert.equal(first.headers["retry-after"], "30");
			const forgedPrefix = await send(port, "GET", "/api/v1/health/ready", { "X-Forwarded-For": "192.0.2.99, 198.51.100.27" });
			assert.equal(forgedPrefix.status, 429);
			const changedClient = await send(port, "GET", "/api/v1/health/ready", { "X-Forwarded-For": "203.0.113.8, 198.51.100.28" });
			assert.equal(changedClient.status, 429);
			const malformed = await send(port, "GET", "/api/v1/health/ready", { "X-Forwarded-For": "203.0.113.8, not-an-ip" });
			assert.equal(malformed.status, 400);
		}, trustedProxyConfig);
		assert.equal(rateRequests.length, 3);
		assert.match(rateRequests[0].bucketHash, /^[a-f0-9]{64}$/);
		assert.equal(rateRequests[0].bucketHash, rateRequests[1].bucketHash);
		assert.notEqual(rateRequests[0].bucketHash, rateRequests[2].bucketHash);
		assert.equal(rateRequests[0].bucketHash.includes("198.51.100.27"), false);
	},
	"password-byte-limit": async () => {
		const atByteLimit = "é".repeat(36);
		assert.equal(Buffer.byteLength(atByteLimit, "utf8"), 72);
		assert.equal(validateRegisterCredentials({ username: "new-user", password: atByteLimit }).password, atByteLimit);
		assert.equal(validateLoginCredentials({ username: "legacy-user", password: atByteLimit }).password, atByteLimit);
		const hasByteLimitIssue = (error) => error.errors?.some((issue) => issue.code === "bcrypt-byte-limit" && /72 UTF-8 bytes/.test(issue.message));
		assert.throws(() => validateRegisterCredentials({ username: "new-user", password: "é".repeat(37) }), hasByteLimitIssue);
		assert.throws(() => validateLoginCredentials({ username: "legacy-user", password: "é".repeat(37) }), hasByteLimitIssue);
		assert.equal(Buffer.byteLength("😀".repeat(18), "utf8"), 72);
		assert.equal(validateLoginCredentials({ username: "legacy-user", password: "😀".repeat(18) }).password, "😀".repeat(18));
		assert.throws(() => validateLoginCredentials({ username: "legacy-user", password: "😀".repeat(19) }), hasByteLimitIssue);
	},
	"production-secret": async () => {
		const env = { NODE_ENV: "production", API_ORIGIN: "https://api.example.test" };
		assert.throws(() => createApiConfig(env), /API_SESSION_HASH_SECRET must be configured in production/);
		assert.throws(() => createApiConfig({
			...env,
			API_SESSION_HASH_SECRET: Buffer.alloc(16, 1).toString("base64url"),
		}), /API_SESSION_HASH_SECRET must contain at least 32 bytes/);
		const valid = createApiConfig({
			...env,
			API_SESSION_HASH_SECRET: Buffer.alloc(32, 2).toString("base64url"),
		});
		assert.equal(valid.production, true);
		assert.equal(valid.sessionHashSecret.byteLength, 32);

		const legacyAuthPath = require.resolve("../../web/src/lib/auth.ts");
		delete require.cache[legacyAuthPath];
		process.env.NODE_ENV = "production";
		delete process.env.JWT_SECRET;
		assert.throws(() => require(legacyAuthPath), /JWT_SECRET must be configured with at least 32 bytes/);
		delete require.cache[legacyAuthPath];
		process.env.JWT_SECRET = "weak-secret";
		assert.throws(() => require(legacyAuthPath), /JWT_SECRET must be configured with at least 32 bytes/);
		delete require.cache[legacyAuthPath];
		process.env.JWT_SECRET = "s".repeat(32);
		const { AuthUtils } = require(legacyAuthPath);
		const token = AuthUtils.generateToken(1);
		assert.ok(token);
		assert.equal(AuthUtils.verifyToken(token).userId, 1);
	},
};

async function main() {
	const name = process.argv[2];
	if (!Object.hasOwn(cases, name)) throw new Error("Unknown security test case");
	await cases[name]();
	process.stdout.write("ok\n");
}

main().catch((error) => {
	process.stderr.write(`${error.stack ?? error}\n`);
	process.exitCode = 1;
});
