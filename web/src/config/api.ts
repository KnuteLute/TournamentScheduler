import { randomBytes } from "node:crypto";

export interface ApiConfig {
	origin: string;
	production: boolean;
	sessionHashSecret: Uint8Array;
	sessionLifetimeMs: number;
	maxBodyBytes: number;
	rateLimitWindowMs: number;
	rateLimitMax: number;
	loginRateLimitMax: number;
	bcryptRounds: number;
}

const decodeSecret = (value: string): Uint8Array => {
	if (/^[a-f\d]+$/i.test(value) && value.length % 2 === 0) {
		return Buffer.from(value, "hex");
	}
	return Buffer.from(value, "base64url");
};

/** Build validated API settings. Production has no built-in secret fallback. */
export function createApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const production = env.NODE_ENV === "production";
	const secretValue = env.API_SESSION_HASH_SECRET;
	if (production && !secretValue) {
		throw new Error("API_SESSION_HASH_SECRET must be configured in production");
	}
	const sessionHashSecret = secretValue
		? decodeSecret(secretValue)
		: randomBytes(32);
	if (sessionHashSecret.byteLength < 32) {
		if (production) {
			throw new Error("API_SESSION_HASH_SECRET must contain at least 32 bytes");
		}
		throw new Error("API_SESSION_HASH_SECRET must contain at least 32 bytes");
	}

	const configuredOrigin = env.API_ORIGIN ?? env.PUBLIC_ORIGIN;
	if (production && !configuredOrigin) throw new Error("API_ORIGIN must be configured in production");
	const origin = configuredOrigin ? new URL(configuredOrigin).origin : "http://localhost";
	if (production && !origin.startsWith("https://")) throw new Error("API_ORIGIN must use HTTPS in production");
	const numberSetting = (key: string, fallback: number, min: number, max: number) => {
		const parsed = env[key] ? Number(env[key]) : fallback;
		if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
			throw new Error(`${key} is outside the permitted range`);
		}
		return parsed;
	};

	return {
		origin,
		production,
		sessionHashSecret,
		sessionLifetimeMs: numberSetting("API_SESSION_LIFETIME_MS", 1000 * 60 * 60 * 24 * 14, 60_000, 1000 * 60 * 60 * 24 * 90),
		maxBodyBytes: numberSetting("API_MAX_BODY_BYTES", 32 * 1024, 1024, 1024 * 1024),
		rateLimitWindowMs: numberSetting("API_RATE_WINDOW_MS", 60_000, 1000, 60 * 60 * 1000),
		rateLimitMax: numberSetting("API_RATE_MAX", 120, 1, 10_000),
		loginRateLimitMax: numberSetting("API_AUTH_RATE_MAX", 10, 1, 1000),
		bcryptRounds: numberSetting("API_BCRYPT_ROUNDS", production ? 12 : 10, 10, 15),
	};
}
