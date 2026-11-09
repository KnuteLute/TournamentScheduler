import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import {
	StoreConflictError,
	StoreNotFoundError,
	StorePreconditionFailedError,
	StoreUnavailableError,
	StoreValidationError,
} from "../services/ports";

export interface FieldIssue {
	pointer: string;
	code: string;
	message: string;
}

export class ApiProblem extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly title: string,
		detail = title,
		readonly errors?: FieldIssue[],
	) {
		super(detail);
		this.name = "ApiProblem";
	}
}

export function sendProblem(res: Response, problem: ApiProblem, traceId: string = randomUUID()): void {
	const body: Record<string, unknown> = {
		type: `https://api.tournament-scheduler.invalid/problems/${problem.code}`,
		title: problem.title,
		status: problem.status,
		detail: problem.message,
		code: problem.code,
		instance: res.req.path,
		traceId,
	};
	if (problem.errors) body.errors = problem.errors;
	res.status(problem.status).type("application/problem+json").json(body);
}

export function problemMiddleware(
	error: unknown,
	req: Request,
	res: Response,
	_next: NextFunction,
): void {
	if (res.headersSent) return;
	if (error instanceof ApiProblem) {
		sendProblem(res, error, req.traceId);
		return;
	}
	if (error instanceof StoreNotFoundError) {
		sendProblem(res, new ApiProblem(404, "not-found", "Not Found", "The requested resource was not found."), req.traceId);
		return;
	}
	if (error instanceof StoreConflictError) {
		sendProblem(res, new ApiProblem(409, "conflict", "Conflict", "The operation conflicts with current state."), req.traceId);
		return;
	}
	if (error instanceof StoreValidationError) {
		sendProblem(res, new ApiProblem(422, "validation-failed", "Unprocessable Content", "One or more domain constraints were not met.", error.issues), req.traceId);
		return;
	}
	if (error instanceof StorePreconditionFailedError) {
		sendProblem(res, new ApiProblem(412, "precondition-failed", "Precondition Failed", "Fetch the latest resource and retry."), req.traceId);
		return;
	}
	if (error instanceof StoreUnavailableError) {
		sendProblem(res, new ApiProblem(503, "service-unavailable", "Service Unavailable", "The API data service is unavailable."), req.traceId);
		return;
	}
	const parserError = error as { type?: string; status?: number };
	if (parserError?.type === "entity.too.large") {
		sendProblem(res, new ApiProblem(413, "request-too-large", "Content Too Large", "The request body exceeds the allowed size."), req.traceId);
		return;
	}
	if (parserError?.type === "entity.parse.failed") {
		sendProblem(res, new ApiProblem(400, "malformed-json", "Bad Request", "The JSON request body is malformed."), req.traceId);
		return;
	}
	if (parserError?.type === "charset.unsupported" || parserError?.type === "encoding.unsupported") {
		sendProblem(res, new ApiProblem(415, "unsupported-media-type", "Unsupported Media Type", "The request encoding is not supported."), req.traceId);
		return;
	}
	if (parserError?.type === "request.aborted" || parserError?.type === "request.size.invalid") {
		sendProblem(res, new ApiProblem(400, "invalid-request-body", "Bad Request", "The request body could not be read."), req.traceId);
		return;
	}
	sendProblem(res, new ApiProblem(500, "internal-error", "Internal Server Error", "The request could not be completed."), req.traceId);
}
