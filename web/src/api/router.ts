import bcrypt from "bcrypt";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ApiConfig } from "../config/api";
import {
	constantTimeEqual,
	csrfForSession,
	expiredSessionCookie,
	newOpaqueCredential,
	protectedHash,
	readSessionCookie,
	sessionCookie,
} from "../auth/credentials";
import {
	ApiProblem,
	problemMiddleware,
	sendProblem,
} from "./problem";
import { bodyValidators, validateQuery, validateTournamentPatch, type JsonObject, type TournamentMode } from "./validation";
import { StoreUnavailableError } from "../services/ports";
import type {
	ApiStore,
	SessionRecord,
	StoreIdempotency,
	StoreOperation,
	StoreRequest,
	StoreResult,
	VerifiedActor,
} from "../services/ports";

declare global {
	namespace Express {
		interface Request {
			apiSession?: SessionRecord;
			apiCredential?: string;
			apiCookiePresent?: boolean;
			traceId?: string;
		}
	}
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function actorFrom(session: SessionRecord): VerifiedActor {
	return {
		sessionId: session.id,
		ownerId: session.ownerId,
		kind: session.kind,
		account: session.account,
	};
}

function fail(status: number, code: string, title: string, detail = title): never {
	throw new ApiProblem(status, code, title, detail);
}

function requireSession(req: Request): SessionRecord {
	if (!req.apiSession) fail(401, "unauthorized", "Unauthorized", "A valid session is required.");
	return req.apiSession;
}

function expectedETag(req: Request, required: boolean): string | undefined {
	const value = req.get("If-Match");
	if (!value) {
		if (required) fail(428, "precondition-required", "Precondition Required", "If-Match is required.");
		return undefined;
	}
	if (value.length > 200 || value.startsWith("W/") || value === "*" || !/^"[A-Za-z0-9._:-]+"$/.test(value)) {
		fail(400, "invalid-if-match", "Bad Request", "If-Match must contain one strong entity tag.");
	}
	return value;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requestHash(req: Request, config: ApiConfig, body: unknown): string {
	return createHmac("sha256", config.sessionHashSecret)
		.update(req.method)
		.update("\n")
		.update(req.path)
		.update("\n")
		.update(stableJson(body ?? null))
		.digest("hex");
}

function idempotency(req: Request, operation: StoreOperation, config: ApiConfig, body: unknown, anchor: StoreIdempotency["anchor"] = "actor-owner"): StoreIdempotency {
	const key = req.get("Idempotency-Key");
	if (!key || key.length < 16 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
		fail(400, "idempotency-key-required", "Bad Request", "A valid Idempotency-Key is required.");
	}
	return { key, requestHash: requestHash(req, config, body), anchor };
}

function setETag(res: Response, result: StoreResult<unknown>): void {
	if (result.etag) {
		const tag = result.etag.startsWith('"') ? result.etag : `"${result.etag}"`;
		if (/^"[A-Za-z0-9._:-]+"$/.test(tag)) res.set("ETag", tag);
		return;
	}
	const value = result.value as { version?: unknown } | null;
	if (value && typeof value === "object" && Number.isSafeInteger(value.version) && Number(value.version) > 0) {
		res.set("ETag", `"v${String(value.version)}"`);
	}
}

const PRIVATE_RESPONSE_FIELDS = new Set([
	"owner", "ownerid", "ownerscope", "internalowner", "userid", "accountid", "guestid", "guestsessionid", "sessionid",
	"password", "passwordhash", "token", "rawtoken", "tokenhash", "csrfhash",
	"csrftokenhash", "csrftoken", "sessiontoken", "authorization", "__proto__", "constructor", "prototype",
]);

function publicRepresentation(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) return undefined;
	if (Array.isArray(value)) return value.map((item) => publicRepresentation(item));
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (PRIVATE_RESPONSE_FIELDS.has(key.toLocaleLowerCase("en-US").replace(/[_-]/g, ""))) continue;
		const safeValue = publicRepresentation(item);
		if (safeValue !== undefined) result[key] = safeValue;
	}
	return result;
}

const SESSION_RESPONSE_FIELDS = ["kind", "account", "csrfToken", "expiresAt", "pendingGuestClaim"] as const;

function publicSessionRepresentation(value: unknown): Record<string, unknown> {
	const safeValue = publicRepresentation(value);
	if (safeValue === null || typeof safeValue !== "object" || Array.isArray(safeValue)) return {};
	const session: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const field of SESSION_RESPONSE_FIELDS) {
		if (!(field in safeValue)) continue;
		const fieldValue = (safeValue as Record<string, unknown>)[field];
		if (field === "account") {
			if (fieldValue === null) session.account = null;
			else if (fieldValue !== null && typeof fieldValue === "object" &&
				typeof (fieldValue as Record<string, unknown>).id === "string" &&
				typeof (fieldValue as Record<string, unknown>).username === "string") {
				session.account = {
					id: (fieldValue as Record<string, string>).id,
					username: (fieldValue as Record<string, string>).username,
				};
			}
			continue;
		}
		session[field] = fieldValue;
	}
	return session;
}

function queryObject(req: Request): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(req.query)) result[key] = value;
	return result;
}

function validatePathId(value: string | undefined, field: string): string {
	if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
		fail(400, "invalid-id", "Bad Request", `${field} is not a valid opaque ID.`);
	}
	return value;
}

function ensureSameOrigin(req: Request, config: ApiConfig): void {
	const fetchSite = req.get("Sec-Fetch-Site");
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
		fail(403, "csrf-rejected", "Forbidden", "Cross-site requests are not allowed.");
	}
	const origin = req.get("Origin");
	if (origin) {
		if (origin === "null" || origin !== config.origin) fail(403, "csrf-rejected", "Forbidden", "Request origin is not allowed.");
		return;
	}
	const referer = req.get("Referer");
	if (referer) {
		let refererOrigin: string;
		try {
			refererOrigin = new URL(referer).origin;
		} catch {
			fail(403, "csrf-rejected", "Forbidden", "Request origin is not allowed.");
		}
		if (refererOrigin !== config.origin) fail(403, "csrf-rejected", "Forbidden", "Request origin is not allowed.");
		return;
	}
	fail(403, "csrf-rejected", "Forbidden", "Origin or same-origin Referer is required.");
}

function csrfCheck(req: Request, config: ApiConfig, optionalBootstrap: boolean): void {
	ensureSameOrigin(req, config);
	if (!req.apiCookiePresent && optionalBootstrap) return;
	const session = requireSession(req);
	const token = req.get("X-CSRF-Token");
	if (!token || token.length < 32 || token.length > 256) fail(403, "csrf-rejected", "Forbidden", "A valid CSRF token is required.");
	const actual = protectedHash(token, config);
	if (!constantTimeEqual(actual, session.csrfTokenHash)) fail(403, "csrf-rejected", "Forbidden", "A valid CSRF token is required.");
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
	return (req: Request, res: Response, next: NextFunction) => {
		void handler(req, res, next).catch(next);
	};
}

function parseIpv6Bytes(value: string): number[] | undefined {
	if (value.includes("%")) return undefined;
	let address = value.toLowerCase();
	if (address.includes(".")) {
		const separator = address.lastIndexOf(":");
		if (separator < 0) return undefined;
		const ipv4 = address.slice(separator + 1);
		if (isIP(ipv4) !== 4) return undefined;
		const octets = ipv4.split(".").map(Number);
		const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
		const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
		address = `${address.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
	}
	const marker = address.indexOf("::");
	let groups: string[];
	if (marker >= 0) {
		if (address.indexOf("::", marker + 2) >= 0) return undefined;
		const left = address.slice(0, marker).split(":").filter(Boolean);
		const right = address.slice(marker + 2).split(":").filter(Boolean);
		const zeros = 8 - left.length - right.length;
		if (zeros < 1) return undefined;
		groups = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
	} else {
		groups = address.split(":");
		if (groups.length !== 8) return undefined;
	}
	if (groups.length !== 8 || groups.some((group) => !/^[a-f\d]{1,4}$/.test(group))) return undefined;
	const bytes: number[] = [];
	for (const group of groups) {
		const number = Number.parseInt(group, 16);
		bytes.push((number >> 8) & 0xff, number & 0xff);
	}
	return bytes;
}

function normalizeIpAddress(value: string): string | undefined {
	const address = value.trim();
	const family = isIP(address);
	if (family === 4) return address;
	if (family !== 6) return undefined;
	const bytes = parseIpv6Bytes(address);
	if (!bytes) return undefined;
	const ipv4Mapped = bytes.slice(0, 10).every((part) => part === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	if (ipv4Mapped) return bytes.slice(12).join(".");
	const groups: string[] = [];
	for (let index = 0; index < 16; index += 2) {
		groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
	}
	return groups.join(":");
}

function rateLimitClientAddress(req: Request, trustedProxyHops: number): string {
	const peer = normalizeIpAddress(req.socket.remoteAddress ?? "");
	if (!peer) fail(400, "invalid-client-address", "Bad Request", "The network peer address is invalid.");
	if (trustedProxyHops === 0) return peer;
	const forwardedFor = req.get("X-Forwarded-For");
	if (!forwardedFor || forwardedFor.length > 2048) {
		fail(400, "invalid-forwarded-chain", "Bad Request", "The trusted proxy chain is missing or too long.");
	}
	const chain = forwardedFor.split(",").map((address) => address.trim());
	if (chain.length > 32 || chain.length < trustedProxyHops) {
		fail(400, "invalid-forwarded-chain", "Bad Request", "The trusted proxy chain has an invalid number of hops.");
	}
	// Proxies append to the right; ignore any untrusted left-most prefix by
	// counting the configured trusted hop boundary from the right edge.
	const client = normalizeIpAddress(chain[chain.length - trustedProxyHops] ?? "");
	if (!client) fail(400, "invalid-forwarded-chain", "Bad Request", "The trusted proxy chain contains an invalid address.");
	return client;
}

function addRateLimit(router: Router, store: ApiStore, config: ApiConfig): void {
	router.use((req, res, next) => {
		if (req.path === "/health/live") {
			next();
			return;
		}
		let peer: string;
		try {
			peer = rateLimitClientAddress(req, config.trustedProxyHops);
		} catch (error) {
			next(error);
			return;
		}
		const auth = req.path === "/auth/login" || req.path === "/auth/register";
		const bucketHash = createHmac("sha256", config.sessionHashSecret)
			.update(`rate-network:${auth ? "auth" : "api"}:${peer}`)
			.digest("hex");
		void store.consumeRateLimit({
			bucketHash,
			now: new Date(),
			windowMs: config.rateLimitWindowMs,
			maximum: auth ? config.loginRateLimitMax : config.rateLimitMax,
		}).then((decision) => {
			if (typeof decision.allowed !== "boolean" || !Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 0) {
				throw new Error("Invalid rate-limit decision");
			}
			if (!decision.allowed) {
				res.set("Retry-After", String(Math.max(1, decision.retryAfterSeconds)));
				sendProblem(res, new ApiProblem(429, "rate-limited", "Too Many Requests", "Request rate limit exceeded."), req.traceId);
				return;
			}
			next();
		}).catch(next);
	});
}

/** Create a mountable router; mount this only beneath `/api/v1` in the host app. */
export function createApiRouter(store: ApiStore, config: ApiConfig): Router {
	if (!store || typeof store.lookupSessionByTokenHash !== "function" || typeof store.findAccountByUsernameKey !== "function" || typeof store.consumeRateLimit !== "function" || typeof store.execute !== "function") {
		throw new Error("A complete API store implementation is required");
	}
	if (!config || config.sessionHashSecret.byteLength < 32) {
		throw new Error("API store and a strong session hash secret are required");
	}
	let configuredOrigin: URL;
	try {
		configuredOrigin = new URL(config.origin);
	} catch {
		throw new Error("A valid API origin is required");
	}
	if (configuredOrigin.origin !== config.origin || (config.production && configuredOrigin.protocol !== "https:")) {
		throw new Error("API origin must be canonical and use HTTPS in production");
	}
	if (!Number.isSafeInteger(config.sessionLifetimeMs) || config.sessionLifetimeMs < 60_000 ||
		config.sessionLifetimeMs > 1000 * 60 * 60 * 24 * 90 ||
		!Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1024 || config.maxBodyBytes > 1024 * 1024 ||
		!Number.isSafeInteger(config.rateLimitWindowMs) || config.rateLimitWindowMs < 1000 || config.rateLimitWindowMs > 60 * 60 * 1000 ||
		!Number.isSafeInteger(config.rateLimitMax) || config.rateLimitMax < 1 || config.rateLimitMax > 10_000 ||
		!Number.isSafeInteger(config.loginRateLimitMax) || config.loginRateLimitMax < 1 || config.loginRateLimitMax > 1000 ||
		!Number.isSafeInteger(config.trustedProxyHops) || config.trustedProxyHops < 0 || config.trustedProxyHops > 8 ||
		!Number.isSafeInteger(config.bcryptRounds) || config.bcryptRounds < 10 || config.bcryptRounds > 15) {
		throw new Error("Invalid API security limits");
	}
	const router = express.Router();
	const authHashSlots = { active: 0 };
	const dummyPasswordHash = bcrypt.hashSync(randomUUID(), config.bcryptRounds);
	router.use((_req, res, next) => {
		res.set("X-Content-Type-Options", "nosniff");
		res.set("X-Frame-Options", "DENY");
		res.set("Referrer-Policy", "no-referrer");
		res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		if (config.production) res.set("Strict-Transport-Security", "max-age=31536000");
		next();
	});
	router.use((req, _res, next) => {
		req.traceId = randomUUID();
		next();
	});
	addRateLimit(router, store, config);
	router.use((req, _res, next) => {
		const hasBody = Number(req.get("Content-Length") ?? 0) > 0 || Boolean(req.get("Transfer-Encoding"));
		if ((req.method === "GET" || req.method === "HEAD") && hasBody) {
			next(new ApiProblem(400, "unexpected-body", "Bad Request", "Read-only requests do not accept a request body."));
			return;
		}
		if (hasBody && req.get("Content-Encoding") && req.get("Content-Encoding") !== "identity") {
			next(new ApiProblem(415, "unsupported-content-encoding", "Unsupported Media Type", "Compressed request bodies are not accepted."));
			return;
		}
		if (MUTATING_METHODS.has(req.method) && hasBody) {
			const isAvailabilityPatch = req.method === "PATCH" && /^\/tournaments\/[^/]+\/availability\/?$/.test(req.path);
			const mediaType = req.method === "PATCH" && !isAvailabilityPatch
				? "application/merge-patch+json"
				: "application/json";
			if (!req.is(mediaType)) {
				next(new ApiProblem(415, "unsupported-media-type", "Unsupported Media Type", `Use ${mediaType}.`));
				return;
			}
		}
		next();
	});
	router.use(express.json({
		limit: config.maxBodyBytes,
		strict: true,
		type: ["application/json", "application/merge-patch+json"],
	}));
	router.use(asyncRoute(async (req, res, next) => {
		if (req.path === "/health/live" || req.path === "/health/ready") {
			next();
			return;
		}
		const parsed = readSessionCookie(req.headers.cookie);
		req.apiCookiePresent = parsed.present;
		if (parsed.value) req.apiCredential = parsed.value;
		if (parsed.present && !parsed.value) {
			res.set("Set-Cookie", expiredSessionCookie());
			// An invalid/present credential is never treated as an anonymous bootstrap.
			if (req.path === "/auth/login" || req.path === "/auth/register" || req.path === "/sessions") {
				fail(401, "unauthorized", "Unauthorized", "The supplied session is invalid.");
			}
		}
		if (parsed.value) {
			const found = await store.lookupSessionByTokenHash(protectedHash(parsed.value, config), new Date());
			if (!found || found.revokedAt || found.expiresAt.getTime() <= Date.now()) {
				res.set("Set-Cookie", expiredSessionCookie());
				if (req.path === "/auth/login" || req.path === "/auth/register" || req.path === "/sessions") {
					fail(401, "unauthorized", "Unauthorized", "The supplied session is invalid.");
				}
			} else {
				req.apiSession = found;
			}
		}
		next();
	}));

	const run = async <T>(req: Request, operation: StoreOperation, settings: {
		body?: JsonObject;
		query?: Record<string, string | number | readonly string[]>;
		resourceId?: string;
		matchId?: string;
		mutating?: boolean;
		precondition?: boolean;
		status?: number;
		anchor?: StoreIdempotency["anchor"];
		credentials?: StoreRequest["credentials"];
	} = {}): Promise<StoreResult<T>> => {
		if (operation !== "session.createGuest" && operation !== "auth.login" && operation !== "auth.register" && !req.apiSession) {
			fail(401, "unauthorized", "Unauthorized", "A valid session is required.");
		}
		let idem: StoreIdempotency | undefined;
		let tag: string | undefined;
		if (settings.mutating) {
			csrfCheck(req, config, operation === "auth.login" || operation === "auth.register" || operation === "session.createGuest");
			if (operation !== "session.createGuest") {
				idem = idempotency(req, operation, config, settings.body, settings.anchor);
			}
		}
		if (settings.precondition) tag = expectedETag(req, true);
		const actor = req.apiSession ? actorFrom(req.apiSession) : null;
		const request: StoreRequest = {
			operation,
			actor,
			...(settings.resourceId === undefined ? {} : { resourceId: settings.resourceId }),
			...(settings.matchId === undefined ? {} : { matchId: settings.matchId }),
			...(settings.query === undefined ? {} : { query: settings.query }),
			...(settings.body === undefined ? {} : { input: settings.body }),
			...(tag === undefined ? {} : { expectedETag: tag }),
			...(idem === undefined ? {} : { idempotency: idem }),
			...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
		};
		return store.execute<T>(request);
	};

	const sendResult = (res: Response, result: StoreResult<unknown>, status = result.status ?? 200, requireETag = false) => {
		setETag(res, result);
		if (requireETag && !res.getHeader("ETag")) throw new StoreUnavailableError();
		if (status === 204) {
			res.status(204).end();
			return;
		}
		res.status(status).json(publicRepresentation(result.value));
	};

	const resource = (method: "get" | "post" | "patch" | "delete", path: string, operation: StoreOperation, options: {
		mutating?: boolean;
		precondition?: boolean;
		body?: boolean;
		query?: readonly string[];
		requiredQuery?: string;
		status?: number;
		resourceParam?: string;
		matchParam?: string;
		noContent?: boolean;
		requireETag?: boolean;
	} = {}) => {
		router[method](path, asyncRoute(async (req, res) => {
			requireSession(req);
			if (options.mutating) csrfCheck(req, config, false);
			if (options.body && req.body === undefined) fail(400, "body-required", "Bad Request", "A JSON request body is required.");
			const resourceId = options.resourceParam ? validatePathId(req.params[options.resourceParam], options.resourceParam) : undefined;
			const matchId = options.matchParam ? validatePathId(req.params[options.matchParam], options.matchParam) : undefined;
			const bodyValidator = bodyValidators[operation];
			let input: JsonObject | undefined;
			if (operation === "tournaments.updateDraft") {
				if (!resourceId) fail(500, "internal-error", "Internal Server Error");
				expectedETag(req, true);
				const tournament = await run<{ mode?: unknown }>(req, "tournaments.get", { resourceId });
				if (tournament.value.mode !== "1v1" && tournament.value.mode !== "2v2_fixed" && tournament.value.mode !== "2v2_rotating") {
					throw new StoreUnavailableError();
				}
				input = validateTournamentPatch(req.body, tournament.value.mode as TournamentMode);
			} else {
				input = bodyValidator ? bodyValidator(req.body) : undefined;
			}
			if (options.body && !bodyValidator && operation !== "tournaments.updateDraft") fail(500, "internal-error", "Internal Server Error");
			const query = options.query ? validateQuery(queryObject(req), options.query) : undefined;
			if (query?.status) {
				const values = query.status as readonly string[];
				const allowed = operation === "tournaments.list"
					? ["draft", "active", "paused", "completed", "cancelled"]
					: ["scheduled", "in_progress", "paused", "completed", "skipped"];
				if (values.some((value) => !allowed.includes(value))) {
					fail(400, "invalid-query", "Bad Request", "Status contains a value not supported by this resource.");
				}
			}
			if (options.requiredQuery && (!query || query[options.requiredQuery] === undefined)) {
				fail(400, "missing-query", "Bad Request", `${options.requiredQuery} is required.`);
			}
			if (query && options.query && options.query.includes("limit") && query.limit === undefined) query.limit = 25;
			const result = await run(req, operation, {
				...(input === undefined ? {} : { body: input }),
				...(query === undefined ? {} : { query }),
				...(resourceId === undefined ? {} : { resourceId }),
				...(matchId === undefined ? {} : { matchId }),
				...(options.mutating ? { mutating: true } : {}),
				...(options.precondition ? { precondition: true } : {}),
			});
			if (options.noContent) {
				res.status(204).end();
				return;
			}
			sendResult(res, result, options.status, options.requireETag);
		}));
	};

	router.get("/health/live", (_req, res) => {
		res.set("Cache-Control", "no-store").status(200).json({ status: "live" });
	});
	router.get("/health/ready", asyncRoute(async (_req, res) => {
		const healthy = store.healthCheck ? await store.healthCheck() : false;
		res.set("Cache-Control", "no-store");
		if (!healthy) {
			res.status(503).json({ status: "not_ready" });
			return;
		}
		res.status(200).json({ status: "ready" });
	}));

	router.post("/sessions", asyncRoute(async (req, res) => {
		csrfCheck(req, config, true);
		if (req.apiCookiePresent) fail(409, "session-exists", "Conflict", "A session cookie is already present.");
		bodyValidators["session.createGuest"]!(req.body);
		const token = newOpaqueCredential();
		const csrfToken = csrfForSession(token, config);
		const expiresAt = new Date(Date.now() + config.sessionLifetimeMs);
		const result = await run<Record<string, unknown>>(req, "session.createGuest", {
			mutating: true,
			credentials: {
				sessionTokenHash: protectedHash(token, config),
				csrfTokenHash: protectedHash(csrfToken, config),
				sessionExpiresAt: expiresAt,
			},
		});
		res.set("Set-Cookie", sessionCookie(token, expiresAt));
		res.set("Cache-Control", "no-store");
		setETag(res, result);
		const session = { ...publicSessionRepresentation(result.value), kind: "guest", account: null, csrfToken, expiresAt: expiresAt.toISOString(), pendingGuestClaim: false };
		res.status(201).json(session);
	}));

	router.get("/session", asyncRoute(async (req, res) => {
		const session = requireSession(req);
		const result = await run<Record<string, unknown>>(req, "session.get");
		res.set("Cache-Control", "no-store");
		setETag(res, { ...result, etag: result.etag ?? `v${session.version}` });
		const csrfToken = req.apiCredential ? csrfForSession(req.apiCredential, config) : "";
		if (!constantTimeEqual(protectedHash(csrfToken, config), session.csrfTokenHash)) {
			fail(401, "unauthorized", "Unauthorized", "The supplied session is invalid.");
		}
		res.json({ ...publicSessionRepresentation(result.value), kind: session.kind, account: session.account, csrfToken, expiresAt: session.expiresAt.toISOString(), pendingGuestClaim: session.pendingGuestClaim });
	}));

	router.get("/session/claim", asyncRoute(async (req, res) => {
		const session = requireSession(req);
		res.set("Cache-Control", "no-store");
		if (session.kind !== "authenticated" || !session.pendingGuestClaim) {
			fail(404, "not-found", "Not Found", "No pending claim is available for this session.");
		}
		const result = await run(req, "session.getClaimDetails");
		sendResult(res, { ...result, etag: `v${session.version}` }, result.status ?? 200, true);
	}));

	const revoke = asyncRoute(async (req, res) => {
		const result = await run(req, req.path === "/auth/logout" ? "auth.logout" : "session.revoke", { mutating: true });
		res.set("Set-Cookie", expiredSessionCookie());
		res.status(204).end();
		void result;
	});
	router.delete("/session", revoke);
	router.post("/auth/logout", revoke);

	const auth = (kind: "register" | "login") => asyncRoute(async (req, res) => {
		csrfCheck(req, config, true);
		const input = bodyValidators[`auth.${kind}`]!(req.body) as { username: string; password: string };
		const idem = idempotency(req, `auth.${kind}`, config, { username: input.username, password: input.password }, kind === "register" ? "new-owner" : "verified-owner");
		const usernameKey = input.username.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
		const accountRateKey = createHmac("sha256", config.sessionHashSecret).update(`auth-account:${usernameKey}`).digest("hex");
		const accountLimit = await store.consumeRateLimit({
			bucketHash: accountRateKey,
			now: new Date(),
			windowMs: config.rateLimitWindowMs,
			maximum: config.loginRateLimitMax,
		});
		if (typeof accountLimit.allowed !== "boolean" || !Number.isSafeInteger(accountLimit.retryAfterSeconds) || accountLimit.retryAfterSeconds < 0) {
			throw new Error("Invalid account rate-limit decision");
		}
		if (!accountLimit.allowed) {
			res.set("Retry-After", String(Math.max(1, accountLimit.retryAfterSeconds)));
			fail(429, "rate-limited", "Too Many Requests", "Authentication rate limit exceeded.");
		}
		let account;
		let passwordHash: string | undefined;
		const hashSlot = authHashSlots;
		if (hashSlot.active >= 8) {
			res.set("Retry-After", "1");
			fail(429, "rate-limited", "Too Many Requests", "Authentication work is temporarily busy.");
		}
		hashSlot.active += 1;
		try {
			if (kind === "login") {
				account = await store.findAccountByUsernameKey(usernameKey);
				let passwordMatches = false;
				try {
					passwordMatches = await bcrypt.compare(input.password, account?.passwordHash ?? dummyPasswordHash);
				} catch {
					passwordMatches = false;
				}
				if (!account || !passwordMatches) fail(401, "invalid-credentials", "Unauthorized", "Username or password is incorrect.");
			} else {
				passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
			}
		} finally {
			hashSlot.active -= 1;
		}
		const token = newOpaqueCredential();
		const csrfToken = csrfForSession(token, config);
		const expiresAt = new Date(Date.now() + config.sessionLifetimeMs);
		const safeInput = { username: input.username, usernameKey };
		const request: StoreRequest = {
			operation: `auth.${kind}`,
			actor: req.apiSession ? actorFrom(req.apiSession) : null,
			input: safeInput,
			idempotency: idem,
			credentials: {
				sessionTokenHash: protectedHash(token, config),
				csrfTokenHash: protectedHash(csrfToken, config),
				sessionExpiresAt: expiresAt,
				...(passwordHash ? { passwordHash } : {}),
			},
		};
		const result = await store.execute<Record<string, unknown>>(request);
		res.set("Set-Cookie", sessionCookie(token, expiresAt));
		res.set("Cache-Control", "no-store");
		setETag(res, result);
		const payload = (publicRepresentation(result.value) as Record<string, unknown> | null) ?? {};
		const sessionValue = publicSessionRepresentation(payload.session);
		res.status(kind === "register" ? 201 : 200).json({
			session: { ...sessionValue, kind: "authenticated", account: account ? { id: account.id, username: account.username } : sessionValue.account, csrfToken, expiresAt: expiresAt.toISOString() },
			...(payload.transfer === undefined ? {} : { transfer: payload.transfer }),
		});
	});
	router.post("/auth/register", auth("register"));
	router.post("/auth/login", auth("login"));

	router.post("/session/claim", asyncRoute(async (req, res) => {
		const session = requireSession(req);
		if (session.kind !== "authenticated") fail(409, "claim-unavailable", "Conflict", "An authenticated session is required to claim guest data.");
		csrfCheck(req, config, false);
		const input = bodyValidators["session.claimGuest"]!(req.body) as JsonObject;
		const result = await run(req, "session.claimGuest", { body: input, mutating: true, precondition: true });
		res.set("Cache-Control", "no-store");
		sendResult(res, result, result.status ?? 200, true);
	}));

	resource("get", "/players", "players.list", { query: ["limit", "cursor", "q"] });
	resource("post", "/players", "players.create", { body: true, mutating: true, status: 201, requireETag: true });
	resource("get", "/players/:playerId", "players.get", { resourceParam: "playerId", requireETag: true });
	resource("patch", "/players/:playerId", "players.update", { body: true, mutating: true, precondition: true, resourceParam: "playerId", requireETag: true });
	resource("delete", "/players/:playerId", "players.delete", { mutating: true, precondition: true, resourceParam: "playerId", noContent: true });

	resource("get", "/teams", "teams.list", { query: ["limit", "cursor"] });
	resource("post", "/teams", "teams.create", { body: true, mutating: true, status: 201, requireETag: true });
	resource("get", "/teams/:teamId", "teams.get", { resourceParam: "teamId", requireETag: true });
	resource("patch", "/teams/:teamId", "teams.update", { body: true, mutating: true, precondition: true, resourceParam: "teamId", requireETag: true });
	resource("delete", "/teams/:teamId", "teams.delete", { mutating: true, precondition: true, resourceParam: "teamId", noContent: true });

	resource("get", "/tournaments", "tournaments.list", { query: ["limit", "cursor", "status"] });
	resource("post", "/tournaments", "tournaments.create", { body: true, mutating: true, status: 201, requireETag: true });
	resource("get", "/tournaments/:tournamentId", "tournaments.get", { resourceParam: "tournamentId", requireETag: true });
	resource("patch", "/tournaments/:tournamentId", "tournaments.updateDraft", { body: true, mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("delete", "/tournaments/:tournamentId", "tournaments.deleteDraft", { mutating: true, precondition: true, resourceParam: "tournamentId", noContent: true });
	resource("post", "/tournaments/:tournamentId/start", "tournaments.start", { mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/cancel", "tournaments.cancel", { mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/pause", "tournaments.pause", { mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/resume", "tournaments.resume", { mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/finish", "tournaments.finish", { mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("patch", "/tournaments/:tournamentId/availability", "tournaments.updateAvailability", { body: true, mutating: true, precondition: true, resourceParam: "tournamentId", requireETag: true });
	resource("get", "/tournaments/:tournamentId/matches", "tournaments.listMatches", { query: ["limit", "cursor", "status"], resourceParam: "tournamentId" });
	resource("get", "/tournaments/:tournamentId/schedule", "tournaments.getSchedule", { resourceParam: "tournamentId", requireETag: true });
	resource("get", "/tournaments/:tournamentId/standings", "tournaments.getStandings", { query: ["view"], requiredQuery: "view", resourceParam: "tournamentId", requireETag: true });
	resource("get", "/standings", "standings.getOverall", { query: ["view"], requiredQuery: "view", requireETag: true });
	resource("get", "/tournaments/:tournamentId/matches/:matchId", "matches.get", { resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/matches/:matchId/start", "matches.start", { mutating: true, precondition: true, resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/matches/:matchId/pause", "matches.pause", { mutating: true, precondition: true, resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/matches/:matchId/resume", "matches.resume", { mutating: true, precondition: true, resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/matches/:matchId/result", "matches.recordResult", { body: true, mutating: true, precondition: true, resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });
	resource("post", "/tournaments/:tournamentId/matches/:matchId/skip", "matches.skip", { mutating: true, precondition: true, resourceParam: "tournamentId", matchParam: "matchId", requireETag: true });

	router.use((req, res) => {
		res.status(404).type("application/problem+json").json({
			type: "https://api.tournament-scheduler.invalid/problems/not-found",
			title: "Not Found",
			status: 404,
			detail: "The requested API route was not found.",
			code: "not-found",
			instance: req.path,
			traceId: req.traceId ?? randomUUID(),
		});
	});
	router.use(problemMiddleware);
	return router;
}
