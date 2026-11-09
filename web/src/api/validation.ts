import { ApiProblem } from "./problem";

export type JsonObject = Record<string, unknown>;
export type Validator = (body: unknown) => JsonObject | undefined;

const validId = (value: unknown): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);

function invalid(pointer: string, code: string, detail: string): never {
	throw new ApiProblem(422, "validation-failed", "Unprocessable Content", "One or more fields are invalid.", [
		{ pointer, code, message: detail },
	]);
}

function object(value: unknown): JsonObject {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		invalid("", "type", "Expected a JSON object.");
	}
	return value as JsonObject;
}

function exact(value: JsonObject, allowed: readonly string[], required: readonly string[] = []): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) invalid(`/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, "unknown-field", "Unknown field.");
	}
	for (const key of required) {
		if (!(key in value)) invalid(`/${key}`, "required", "This field is required.");
	}
}

function boundedString(value: unknown, pointer: string, min: number, max: number): string {
	if (typeof value !== "string") invalid(pointer, "type", "Expected a string.");
	const normalized = value.normalize("NFKC").trim();
	if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
		invalid(pointer, "length", `Must contain ${min} to ${max} printable characters.`);
	}
	return normalized;
}

function ids(value: unknown, pointer: string, min: number, max: number): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) {
		invalid(pointer, "array-size", `Must contain between ${min} and ${max} IDs.`);
	}
	const result: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!validId(value[index])) invalid(`${pointer}/${index}`, "id", "Expected a valid opaque ID.");
		if (result.includes(value[index])) invalid(`${pointer}/${index}`, "duplicate", "IDs must be unique.");
		result.push(value[index]);
	}
	return result;
}

function name(value: unknown, pointer: string, max = 80): string {
	return boundedString(value, pointer, 1, max).replace(/\s+/gu, " ");
}

function noBody(raw: unknown): undefined {
	if (raw !== undefined) {
		const body = object(raw);
		exact(body, []);
	}
	return undefined;
}

export const bodyValidators: Readonly<Record<string, Validator>> = {
	"session.createGuest": noBody,
	"session.revoke": noBody,
	"auth.logout": noBody,
	"auth.login": (raw) => credentials(raw),
	"auth.register": (raw) => credentials(raw),
	"session.claimGuest": (raw) => {
		const body = object(raw);
		exact(body, ["renames"], ["renames"]);
		if (!Array.isArray(body.renames) || body.renames.length > 200) invalid("/renames", "array-size", "Expected at most 200 rename resolutions.");
		const renames = body.renames.map((entry, index) => {
			const row = object(entry);
			exact(row, ["resourceType", "guestResourceId", "newName"], ["resourceType", "guestResourceId", "newName"]);
			if (row.resourceType !== "player" && row.resourceType !== "team") invalid(`/renames/${index}/resourceType`, "enum", "Expected player or team.");
			if (!validId(row.guestResourceId)) invalid(`/renames/${index}/guestResourceId`, "id", "Expected a valid opaque ID.");
			return { resourceType: row.resourceType, guestResourceId: row.guestResourceId, newName: name(row.newName, `/renames/${index}/newName`) };
		});
		return { renames };
	},
	"players.create": (raw) => {
		const body = object(raw);
		exact(body, ["name"], ["name"]);
		return { name: name(body.name, "/name") };
	},
	"players.update": (raw) => {
		const body = object(raw);
		exact(body, ["name"], ["name"]);
		return { name: name(body.name, "/name") };
	},
	"players.delete": noBody,
	"teams.create": (raw) => {
		const body = object(raw);
		exact(body, ["name", "playerIds"], ["name", "playerIds"]);
		return { name: name(body.name, "/name"), playerIds: ids(body.playerIds, "/playerIds", 2, 2) };
	},
	"teams.update": (raw) => {
		const body = object(raw);
		exact(body, ["name", "playerIds"]);
		if (!Object.keys(body).length) invalid("", "min-properties", "At least one field is required.");
		const result: JsonObject = {};
		if ("name" in body) result.name = name(body.name, "/name");
		if ("playerIds" in body) result.playerIds = ids(body.playerIds, "/playerIds", 2, 2);
		return result;
	},
	"teams.delete": noBody,
	"tournaments.create": (raw) => {
		const body = object(raw);
		if (body.mode === "1v1" || body.mode === "2v2_rotating") {
			exact(body, ["name", "mode", "seed", "playerIds"], ["name", "mode", "playerIds"]);
			const roster = ids(body.playerIds, "/playerIds", body.mode === "1v1" ? 2 : 4, 32);
			return { name: name(body.name, "/name", 100), mode: body.mode, playerIds: roster, ...(body.seed === undefined ? {} : { seed: boundedString(body.seed, "/seed", 1, 128) }) };
		}
		if (body.mode === "2v2_fixed") {
			exact(body, ["name", "mode", "seed", "teamIds"], ["name", "mode", "teamIds"]);
			const teams = ids(body.teamIds, "/teamIds", 2, 16);
			return { name: name(body.name, "/name", 100), mode: body.mode, teamIds: teams, ...(body.seed === undefined ? {} : { seed: boundedString(body.seed, "/seed", 1, 128) }) };
		}
		invalid("/mode", "enum", "Mode must be 1v1, 2v2_fixed, or 2v2_rotating.");
	},
	"tournaments.deleteDraft": noBody,
	"tournaments.start": noBody,
	"tournaments.cancel": noBody,
	"tournaments.pause": noBody,
	"tournaments.resume": noBody,
	"tournaments.finish": noBody,
	"tournaments.updateAvailability": (raw) => {
		const body = object(raw);
		exact(body, ["pausedPlayerIds"], ["pausedPlayerIds"]);
		return { pausedPlayerIds: ids(body.pausedPlayerIds, "/pausedPlayerIds", 0, 32) };
	},
	"matches.start": noBody,
	"matches.pause": noBody,
	"matches.resume": noBody,
	"matches.skip": noBody,
	"matches.recordResult": (raw) => {
		const body = object(raw);
		exact(body, ["scores"], ["scores"]);
		if (!Array.isArray(body.scores) || body.scores.length !== 2) invalid("/scores", "array-size", "Exactly two scores are required.");
		const scores = body.scores.map((score, index) => {
			if (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0 || score > 1_000_000) {
				invalid(`/scores/${index}`, "integer-range", "Score must be an integer from 0 to 1000000.");
			}
			return score;
		});
		return { scores };
	},
};

export type TournamentMode = "1v1" | "2v2_fixed" | "2v2_rotating";

/** Validate roster fields against the persisted draft mode, not client mode claims. */
export function validateTournamentPatch(raw: unknown, mode: TournamentMode): JsonObject {
	const body = object(raw);
	exact(body, ["name", "playerIds", "teamIds"]);
	if (!Object.keys(body).length) invalid("", "min-properties", "At least one field is required.");
	const result: JsonObject = {};
	if ("name" in body) result.name = name(body.name, "/name", 100);
	if (mode === "2v2_fixed") {
		if ("playerIds" in body) invalid("/playerIds", "mode-field", "Fixed-team tournaments use teamIds.");
		if ("teamIds" in body) result.teamIds = ids(body.teamIds, "/teamIds", 2, 16);
	} else {
		if ("teamIds" in body) invalid("/teamIds", "mode-field", "Player-roster tournaments use playerIds.");
		if ("playerIds" in body) result.playerIds = ids(body.playerIds, "/playerIds", mode === "1v1" ? 2 : 4, 32);
	}
	return result;
}

function credentials(raw: unknown): JsonObject {
	const body = object(raw);
	exact(body, ["username", "password"], ["username", "password"]);
	const username = boundedString(body.username, "/username", 3, 64);
	if (!/^[\p{L}\p{N}_.@-]+$/u.test(username)) invalid("/username", "format", "Username contains unsupported characters.");
	if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
		invalid("/password", "length", "Password must contain 12 to 128 characters.");
	}
	return { username, password: body.password };
}

export function validateQuery(input: Record<string, unknown>, allowed: readonly string[]): Record<string, string | number | readonly string[]> {
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) invalid(`/${key}`, "unknown-query", "Unknown query parameter.");
	}
	const result: Record<string, string | number | readonly string[]> = {};
	if (input.limit !== undefined) {
		if (typeof input.limit !== "string" || !/^[1-9]\d{0,2}$/.test(input.limit)) invalid("/limit", "integer", "Limit must be an integer from 1 to 100.");
		const limit = Number(input.limit);
		if (limit > 100) invalid("/limit", "range", "Limit must be from 1 to 100.");
		result.limit = limit;
	}
	if (input.cursor !== undefined) {
		if (typeof input.cursor !== "string" || input.cursor.length > 512) invalid("/cursor", "length", "Cursor must be at most 512 characters.");
		result.cursor = input.cursor;
	}
	if (input.q !== undefined) {
		if (typeof input.q !== "string" || input.q.length > 100) invalid("/q", "length", "Search must be at most 100 characters.");
		result.q = input.q;
	}
	if (input.status !== undefined) {
		const values = (Array.isArray(input.status) ? input.status : [input.status]).flatMap((value) => typeof value === "string" ? value.split(",") : [value]);
		const allowedStatuses = ["draft", "active", "paused", "completed", "cancelled", "scheduled", "in_progress", "completed", "skipped"];
		if (values.some((value) => typeof value !== "string" || !allowedStatuses.includes(value))) invalid("/status", "enum", "Status contains an unsupported value.");
		if (new Set(values).size !== values.length || values.length > 6) invalid("/status", "unique", "Status values must be unique and bounded.");
		result.status = values as string[];
	}
	if (input.view !== undefined) {
		if (input.view !== "players" && input.view !== "teams") invalid("/view", "enum", "View must be players or teams.");
		result.view = input.view;
	}
	return result;
}
