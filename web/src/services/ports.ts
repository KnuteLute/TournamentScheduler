/**
 * Persistence boundary for the v1 API.
 *
 * Implementations must scope all resource queries by `actor.ownerId`, must not
 * treat input IDs as authority, and must execute mutations together with their
 * idempotency record in one database transaction. Scope each idempotency
 * operation by operation and route/resource ID. A repeated key and request
 * hash returns the prior logical result; a repeated key with a different hash
 * rejects with `StoreConflictError`. `new-owner` idempotency is anchored to the
 * owner created by registration, not to caller input.
 */

export type SessionKind = "guest" | "authenticated";

export interface SessionRecord {
	id: string;
	ownerId: string;
	kind: SessionKind;
	account: { id: string; username: string } | null;
	csrfTokenHash: Uint8Array;
	expiresAt: Date;
	revokedAt: Date | null;
	pendingGuestClaim: boolean;
	version: number;
}

/** Only values created from a successfully looked-up session may be actors. */
export interface VerifiedActor {
	sessionId: string;
	ownerId: string;
	kind: SessionKind;
	account: { id: string; username: string } | null;
}

export interface AccountCredential {
	id: string;
	ownerId: string;
	username: string;
	usernameKey: string;
	passwordHash: string;
}

export type StoreOperation =
	| "session.createGuest"
	| "session.get"
	| "session.revoke"
	| "session.claimGuest"
	| "auth.register"
	| "auth.login"
	| "auth.logout"
	| "players.list"
	| "players.get"
	| "players.create"
	| "players.update"
	| "players.delete"
	| "teams.list"
	| "teams.get"
	| "teams.create"
	| "teams.update"
	| "teams.delete"
	| "tournaments.list"
	| "tournaments.get"
	| "tournaments.create"
	| "tournaments.updateDraft"
	| "tournaments.deleteDraft"
	| "tournaments.start"
	| "tournaments.cancel"
	| "tournaments.pause"
	| "tournaments.resume"
	| "tournaments.finish"
	| "tournaments.updateAvailability"
	| "tournaments.listMatches"
	| "tournaments.getSchedule"
	| "tournaments.getStandings"
	| "matches.get"
	| "matches.start"
	| "matches.pause"
	| "matches.resume"
	| "matches.recordResult"
	| "matches.skip"
	| "standings.getOverall";

export type IdempotencyAnchor = "actor-owner" | "verified-owner" | "new-owner";

export interface StoreIdempotency {
	key: string;
	requestHash: string;
	anchor: IdempotencyAnchor;
}

/**
 * A validated application operation. `input` contains only fields accepted by
 * the matching operation schema; `resourceId` is an untrusted lookup key and
 * must always be combined with the verified actor's owner scope in persistence.
 */
export interface StoreRequest {
	operation: StoreOperation;
	actor: VerifiedActor | null;
	resourceId?: string;
	matchId?: string;
	query?: Readonly<Record<string, string | number | readonly string[]>>;
	input?: Readonly<Record<string, unknown>>;
	expectedETag?: string;
	idempotency?: StoreIdempotency;
	/** Secret material is supplied only for the current transaction and never persisted raw. */
	credentials?: {
		sessionTokenHash?: Uint8Array;
		csrfTokenHash?: Uint8Array;
		sessionExpiresAt?: Date;
		passwordHash?: string;
	};
}

export interface StoreResult<T = unknown> {
	status?: number;
	value: T;
	/** Strong opaque validator, without HTTP quote delimiters; required for resource responses and mutations. */
	etag?: string;
}

export interface RateLimitRequest {
	/** HMAC-derived bucket identifier; never a raw IP address or username. */
	bucketHash: string;
	now: Date;
	windowMs: number;
	maximum: number;
}

export interface RateLimitDecision {
	allowed: boolean;
	retryAfterSeconds: number;
}

export interface ApiStore {
	/** Resolve an active, unexpired, non-revoked row by hash of the opaque cookie. */
	lookupSessionByTokenHash(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null>;
	/** Credential lookup is for login only; normalize/canonicalize username in the adapter. */
	findAccountByUsernameKey(usernameKey: string): Promise<AccountCredential | null>;
	/**
	 * Atomically increment/check an expiring counter shared across app instances.
	 * Retain buckets only for the active retry window plus bounded cleanup time;
	 * the API sends an HMAC bucket key, never a raw network/account identifier.
	 */
	consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision>;
	/**
	 * Execute one owner-scoped query or mutation. Mutations with idempotency must
	 * atomically claim/complete their idempotency record alongside all domain
	 * writes. On a retried login/registration, it must establish a fresh session
	 * row from the newly supplied hashes; it must never replay a raw old secret.
	 * The adapter owns SQL transactions, constraints, and domain-level
	 * authorization checks; it must never use process-global state as a fallback.
	 */
	execute<T = unknown>(request: StoreRequest): Promise<StoreResult<T>>;
	/** Lightweight, read-only dependency check used only by the API health route. */
	healthCheck?(): Promise<boolean>;
}

export class StoreNotFoundError extends Error {
	constructor() {
		super("Resource not found");
		this.name = "StoreNotFoundError";
	}
}

export class StoreConflictError extends Error {
	constructor() {
		super("Operation conflicts with current state");
		this.name = "StoreConflictError";
	}
}

export interface StoreValidationIssue {
	pointer: string;
	code: string;
	message: string;
}

export class StoreValidationError extends Error {
	constructor(readonly issues: StoreValidationIssue[]) {
		super("Request violates a domain constraint");
		this.name = "StoreValidationError";
	}
}

export class StorePreconditionFailedError extends Error {
	constructor() {
		super("Resource version is stale");
		this.name = "StorePreconditionFailedError";
	}
}

export class StoreUnavailableError extends Error {
	constructor() {
		super("API persistence is not configured");
		this.name = "StoreUnavailableError";
	}
}
