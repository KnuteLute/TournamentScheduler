import { randomBytes, randomUUID } from "node:crypto";

const request = require("supertest");
const { Pool } = require("pg");

const postgresUrl = process.env.POSTGRES_URL;
const databaseName = process.env.TEST_DATABASE_NAME;
const apiOrigin = process.env.TEST_API_ORIGIN;
const testPassword = process.env.TEST_ACCOUNT_PASSWORD;
const localPostgresApiEnabled = Boolean(
  process.env.NODE_ENV === "test" && postgresUrl && databaseName && apiOrigin && testPassword,
);
const describeLocalPostgresApi = localPostgresApiEnabled
  ? describe
  : (describe as unknown as { skip: typeof describe }).skip;

function origin(): string {
  if (!apiOrigin) throw new Error("TEST_API_ORIGIN is required for the local API security tests");
  const parsed = new URL(apiOrigin);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || parsed.pathname !== "/") {
    throw new Error("Security integration tests may only call a loopback API origin");
  }
  return parsed.origin;
}

function key(): string {
  return randomUUID();
}

async function registerOwner(): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const base = origin();
  if (!testPassword) throw new Error("TEST_ACCOUNT_PASSWORD is required");
  const response = await request(base)
    .post("/api/v1/auth/register")
    .set("Origin", base)
    .set("Sec-Fetch-Site", "same-origin")
    .set("Idempotency-Key", key())
    .send({ username: `security_${randomUUID().replace(/-/g, "").slice(0, 20)}`, password: testPassword });
  expect(response.status).toBe(201);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = cookies.find((value: string) => value.startsWith("__Host-ts_session="));
  if (!header) throw new Error("Registration did not set an authenticated session cookie");
  return {
    cookie: header.split(";", 1)[0],
    csrf: response.body.session.csrfToken,
    accountId: response.body.session.account.id,
  };
}

function mutate(client: { cookie: string; csrf: string }, method: "post" | "patch" | "delete", path: string, body?: unknown) {
  const base = origin();
  let test = request(base)[method](`/api/v1${path}`)
    .set("Cookie", client.cookie)
    .set("Origin", base)
    .set("Sec-Fetch-Site", "same-origin")
    .set("X-CSRF-Token", client.csrf)
    .set("Idempotency-Key", key());
  if (body !== undefined) test = test.send(body);
  return test;
}

async function createPlayer(client: { cookie: string; csrf: string }, name: string) {
  const response = await mutate(client, "post", "/players", { name });
  expect(response.status).toBe(201);
  return response.body;
}

describeLocalPostgresApi("security checks against the isolated PostgreSQL API", () => {
  jest.setTimeout(30_000);

  beforeAll(async () => {
    if (process.env.NODE_ENV !== "test" || !postgresUrl || !databaseName) {
      throw new Error("Local security API tests require NODE_ENV=test and a disposable TEST_DATABASE_NAME");
    }
    const parsedDatabase = new URL(postgresUrl);
    const actualName = decodeURIComponent(parsedDatabase.pathname.replace(/^\//, ""));
    if (
      !["postgres:", "postgresql:"].includes(parsedDatabase.protocol) ||
      !["localhost", "127.0.0.1", "::1"].includes(parsedDatabase.hostname) ||
      actualName !== databaseName ||
      !/(^|[_-])(test|tests|ci)([_-]|$)/i.test(actualName)
    ) {
      throw new Error("Refusing security integration tests outside the named loopback test database");
    }
    const pool = new Pool({ connectionString: postgresUrl, max: 1 });
    try {
      const result = await pool.query("SELECT current_database() AS database_name, current_setting('server_version') AS server_version");
      expect(result.rows[0]?.database_name).toBe(databaseName);
      expect(Number(result.rows[0]?.server_version.split(".")[0])).toBeGreaterThanOrEqual(14);
    } finally {
      await pool.end();
    }
    await request(origin()).get("/api/v1/health/ready").expect(200);
  });

  test("foreign player and tournament IDs remain hidden between real account sessions", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();
    const foreignPlayer = await createPlayer(ownerA, `Security A ${key()}`);
    const secondForeignPlayer = await createPlayer(ownerA, `Security A ${key()}`);
    const ownPlayer = await createPlayer(ownerB, `Security B ${key()}`);
    const foreignTournament = await mutate(ownerA, "post", "/tournaments", {
      name: `Foreign tournament ${key()}`,
      mode: "1v1",
      playerIds: [foreignPlayer.id, secondForeignPlayer.id],
      seed: key(),
    });
    expect(foreignTournament.status).toBe(201);

    expect((await request(origin()).get(`/api/v1/players/${foreignPlayer.id}`).set("Cookie", ownerB.cookie)).status).toBe(404);
    expect((await request(origin()).get(`/api/v1/tournaments/${foreignTournament.body.id}`).set("Cookie", ownerB.cookie)).status).toBe(404);

    const rosterTamper = await mutate(ownerB, "post", "/teams", {
      name: `Foreign roster ${key()}`,
      playerIds: [foreignPlayer.id, ownPlayer.id],
    });
    expect(rosterTamper.status).toBe(404);

    const visibleToB = await request(origin()).get("/api/v1/players").set("Cookie", ownerB.cookie);
    expect(visibleToB.status).toBe(200);
    expect(visibleToB.body.items.map((item: { id: string }) => item.id)).toEqual([ownPlayer.id]);

    const unchangedForA = await request(origin()).get(`/api/v1/players/${foreignPlayer.id}`).set("Cookie", ownerA.cookie);
    expect(unchangedForA.status).toBe(200);
    expect(unchangedForA.body.name).toBe(foreignPlayer.name);
  });

  test("fabricated capabilities cannot authenticate; revoked real account cookies cannot be replayed", async () => {
    const base = origin();
    const fabricated = randomBytes(32).toString("base64url");
    const forged = await request(base)
      .post("/api/v1/sessions")
      .set("Origin", base)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", `__Host-ts_session=${fabricated}`);
    expect(forged.status).toBe(401);
    expect(forged.headers["set-cookie"]?.[0]).toMatch(/^__Host-ts_session=;/);
    expect(forged.body).not.toHaveProperty("csrfToken");

    const session = await registerOwner();
    const revoked = await request(base)
      .delete("/api/v1/session")
      .set("Cookie", session.cookie)
      .set("Origin", base)
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-CSRF-Token", session.csrf)
      .set("Idempotency-Key", key())
      .expect(204);
    expect(revoked.headers["set-cookie"]?.[0]).toMatch(/^__Host-ts_session=;/);

    const replay = await request(base).get("/api/v1/session").set("Cookie", session.cookie);
    expect(replay.status).toBe(401);
    expect(replay.headers["set-cookie"]?.[0]).toMatch(/^__Host-ts_session=;/);
  });

  test("a guest bootstrap creates and persists a server-issued capability", async () => {
    const base = origin();
    const created = await request(base)
      .post("/api/v1/sessions")
      .set("Origin", base)
      .set("Sec-Fetch-Site", "same-origin");
    expect(created.status).toBe(201);
    const cookie = (created.headers["set-cookie"] as string[]).find((value) => value.startsWith("__Host-ts_session="));
    expect(cookie).toBeDefined();
    const session = await request(base).get("/api/v1/session").set("Cookie", cookie!.split(";", 1)[0]);
    expect(session.status).toBe(200);
    expect(session.body.kind).toBe("guest");
    expect(session.body).not.toHaveProperty("ownerId");
  });

  test("login identity is selected only after the backend password verifier accepts the credential", async () => {
    if (!testPassword || testPassword.length < 12) throw new Error("A disposable test account password is required");
    const base = origin();
    const username = `security_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const registration = await request(base)
      .post("/api/v1/auth/register")
      .set("Origin", base)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Idempotency-Key", key())
      .send({ username, password: testPassword });
    expect(registration.status).toBe(201);

    const login = () => request(base)
      .post("/api/v1/auth/login")
      .set("Origin", base)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Idempotency-Key", key());
    const rejected = await login().send({ username, password: `${testPassword}-wrong` });
    expect(rejected.status).toBe(401);
    expect(rejected.headers["set-cookie"]).toBeUndefined();

    const accepted = await login().send({ username, password: testPassword });
    expect(accepted.status).toBe(200);
    expect(accepted.body.session.account.id).toBe(registration.body.session.account.id);
    expect(accepted.body.session.account.username).toBe(username);
  });
});
