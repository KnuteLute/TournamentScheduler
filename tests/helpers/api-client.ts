import { randomUUID } from "node:crypto";
import { expect } from "@jest/globals";
import request from "supertest";
import type { Test } from "supertest";
import { syntheticPassword } from "./testing-env";

export { syntheticPassword } from "./testing-env";

const apiPrefix = "/api/v1";

export type JsonRecord = Record<string, unknown>;

export interface ResourceRecord extends JsonRecord {
  id: string;
  name: string;
}

export interface TournamentRecord extends ResourceRecord {
  __etag: string;
}

export interface SessionRepresentation {
  kind: "guest" | "authenticated";
  account: { id: string; username: string } | null;
  csrfToken: string;
  expiresAt: string;
  pendingGuestClaim: boolean;
}

export interface AuthResult {
  session: SessionRepresentation;
  transfer: { status: "none" | "transferred" | "pending_conflicts" };
}

export function testOrigin(): string {
  const origin = process.env.TEST_API_ORIGIN;
  if (!origin) throw new Error("TEST_API_ORIGIN must point to a local test server");

  const parsed = new URL(origin);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/") {
    throw new Error("TEST_API_ORIGIN must be a loopback HTTP(S) origin without a path");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Integration tests may only call a loopback TEST_API_ORIGIN");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("TEST_API_ORIGIN must not contain credentials, a query, or a fragment");
  }
  return parsed.origin;
}

export async function assertDisposablePostgres(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("PostgreSQL integration tests require NODE_ENV=test");
  }

  const connectionString = process.env.POSTGRES_URL;
  const expectedDatabase = process.env.TEST_DATABASE_NAME;
  if (!connectionString || !expectedDatabase) {
    throw new Error("POSTGRES_URL and TEST_DATABASE_NAME are required for integration tests");
  }

  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    throw new Error("Integration tests may only connect to a loopback PostgreSQL service");
  }
  const actualDatabase = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    actualDatabase !== expectedDatabase ||
    !/(^|[_-])(test|tests|ci)([_-]|$)/i.test(actualDatabase)
  ) {
    throw new Error(
      "Refusing PostgreSQL integration tests unless POSTGRES_URL names the explicit disposable TEST_DATABASE_NAME",
    );
  }

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ database_name: string; server_version: string }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version",
    );
    if (result.rows[0]?.database_name !== expectedDatabase) {
      throw new Error("PostgreSQL connected to a database other than TEST_DATABASE_NAME");
    }
    if (Number(result.rows[0].server_version.split(".")[0]) < 14) {
      throw new Error("Integration PostgreSQL must be version 14 or newer");
    }
  } finally {
    await pool.end();
  }
}

export class ApiClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken = "";
  sessionEtag = "";
  private sessionCookie = "";

  private constructor(private readonly origin: string) {
    this.agent = request.agent(origin);
  }

  static create(): ApiClient {
    return new ApiClient(testOrigin());
  }

  private path(path: string): string {
    return `${apiPrefix}${path}`;
  }

  private captureSessionCookie(response: { headers: Record<string, string | string[] | undefined> }): void {
    const header = response.headers["set-cookie"];
    const values = Array.isArray(header) ? header : header ? [header] : [];
    const cookie = values.find((value) => value.startsWith("__Host-ts_session="));
    if (cookie) this.sessionCookie = cookie.split(";", 1)[0];
  }

  get(path: string): Test {
    return this.withSessionCookie(this.agent.get(this.path(path)));
  }

  withSessionCookie(test: Test): Test {
    if (this.sessionCookie) test.set("Cookie", this.sessionCookie);
    return test;
  }

  async bootstrapGuest(): Promise<SessionRepresentation> {
    const response = await this.agent
      .post(this.path("/sessions"))
      .set("Origin", this.origin)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "application/json");
    expect(response.status).toBe(201);
    this.captureSessionCookie(response);
    this.csrfToken = response.body.csrfToken;
    expect(typeof this.csrfToken).toBe("string");
    expect(this.csrfToken.length).toBeGreaterThanOrEqual(32);
    await this.refreshSession();
    return response.body;
  }

  async refreshSession(): Promise<SessionRepresentation> {
    const response = await this.get("/session");
    expect(response.status).toBe(200);
    this.csrfToken = response.body.csrfToken;
    this.sessionEtag = response.headers.etag;
    expect(this.sessionEtag).toBeTruthy();
    return response.body;
  }

  async register(username = syntheticUsername()): Promise<AuthResult> {
    const response = await this.mutate("post", "/auth/register", {
      username,
      password: syntheticPassword(),
    });
    expect(response.status).toBe(201);
    this.captureSessionCookie(response);
    this.csrfToken = response.body.session.csrfToken;
    await this.refreshSession();
    return response.body;
  }

  async login(username: string, password = syntheticPassword()): Promise<AuthResult> {
    const response = await this.mutate("post", "/auth/login", { username, password });
    expect(response.status).toBe(200);
    this.captureSessionCookie(response);
    this.csrfToken = response.body.session.csrfToken;
    await this.refreshSession();
    return response.body;
  }

  mutate(
    method: "post" | "patch" | "delete",
    path: string,
    body?: JsonRecord,
    options: { ifMatch?: string; idempotencyKey?: string; contentType?: string } = {},
  ): Test {
    const test = this.agent[method](this.path(path));
    test
      .set("Origin", this.origin)
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-CSRF-Token", this.csrfToken)
      .set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
    this.withSessionCookie(test);
    if (options.ifMatch) test.set("If-Match", options.ifMatch);
    if (options.contentType) test.set("Content-Type", options.contentType);
    if (body !== undefined) test.send(body);
    return test;
  }

  async createPlayer(name: string): Promise<ResourceRecord> {
    const response = await this.mutate("post", "/players", { name });
    expect(response.status).toBe(201);
    return response.body;
  }

  async createPlayers(names: string[]): Promise<ResourceRecord[]> {
    return Promise.all(names.map((name) => this.createPlayer(name)));
  }

  async createTournament(
    playerIds: string[],
    mode: "1v1" | "2v2_rotating" = "1v1",
    name = `Synthetic cup ${randomUUID()}`,
  ): Promise<TournamentRecord> {
    const response = await this.mutate("post", "/tournaments", {
      name,
      mode,
      playerIds,
      seed: randomUUID(),
    });
    expect(response.status).toBe(201);
    return tournamentFromResponse(response);
  }

  async startTournament(tournament: TournamentRecord): Promise<{ body: JsonRecord; etag: string }> {
    const response = await this.mutate("post", `/tournaments/${tournament.id}/start`, undefined, {
      ifMatch: this.sessionEtagForTournament(tournament),
    });
    expect(response.status).toBe(200);
    return { body: response.body, etag: response.headers.etag };
  }

  private sessionEtagForTournament(tournament: TournamentRecord): string {
    return tournament.__etag;
  }
}

export function tournamentFromResponse(response: { body: ResourceRecord; headers: Record<string, string> }): TournamentRecord {
  const etag = response.headers.etag;
  if (!etag) throw new Error("Tournament create response must include an ETag");
  return { ...response.body, __etag: etag };
}

export function syntheticUsername(): string {
  return `qa_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function freshKey(): string {
  return randomUUID();
}

export function mutationRequest(
  client: ApiClient,
  method: "post" | "patch" | "delete",
  path: string,
  body?: JsonRecord,
  options: { ifMatch?: string; idempotencyKey?: string; contentType?: string } = {},
): Test {
  return client.mutate(method, path, body, options);
}
