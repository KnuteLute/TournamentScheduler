import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api";

export const SESSION_COOKIE = "__Host-ts_session";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newOpaqueCredential(): string {
	return randomBytes(32).toString("base64url");
}

export function isOpaqueCredential(value: string): boolean {
	return TOKEN_PATTERN.test(value);
}

export function protectedHash(value: string, config: ApiConfig): Uint8Array {
	return createHmac("sha256", config.sessionHashSecret).update(value).digest();
}

/** Stable, session-bound CSRF proof; only its protected hash is persisted. */
export function csrfForSession(sessionCredential: string, config: ApiConfig): string {
	return createHmac("sha256", config.sessionHashSecret)
		.update("csrf-token:")
		.update(sessionCredential)
		.digest("base64url");
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function readSessionCookie(cookieHeader: string | undefined): { present: boolean; value?: string } {
	if (!cookieHeader) return { present: false };
	const parts = cookieHeader.split(";");
	let found: string | undefined;
	let count = 0;
	for (const part of parts) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
		count += 1;
		found = part.slice(separator + 1).trim();
	}
	if (count === 0) return { present: false };
	if (count !== 1 || !found || !isOpaqueCredential(found)) return { present: true };
	return { present: true, value: found };
}

export function sessionCookie(value: string, expiresAt: Date): string {
	return `${SESSION_COOKIE}=${value}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}
