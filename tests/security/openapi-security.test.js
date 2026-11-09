const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "../..");
const contract = yaml.load(
  fs.readFileSync(path.join(root, "docs/api/openapi.yaml"), "utf8"),
);

function resolve(value) {
  if (!value || typeof value !== "object" || !value.$ref) return value;

  const resolved = value.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((current, key) => current && current[key], contract);
  if (!resolved) throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
  return resolved;
}

function operationParameters(operation, pathItem) {
  return [...(pathItem.parameters || []), ...(operation.parameters || [])].map(resolve);
}

function requestSchema(operation) {
  const body = operation.requestBody && resolve(operation.requestBody);
  if (!body) return undefined;
  const media = body.content["application/json"] || body.content["application/merge-patch+json"];
  return media && resolve(media.schema);
}

function allRequestProperties(schema, prefix = "") {
  schema = resolve(schema);
  if (!schema || typeof schema !== "object") return [];

  const properties = Object.entries(schema.properties || {}).flatMap(([name, value]) => {
    const currentPath = prefix ? `${prefix}.${name}` : name;
    return [currentPath, ...allRequestProperties(value, currentPath)];
  });
  return [
    ...properties,
    ...(schema.allOf || []).flatMap((part) => allRequestProperties(part, prefix)),
    ...(schema.oneOf || []).flatMap((part) => allRequestProperties(part, prefix)),
    ...(schema.anyOf || []).flatMap((part) => allRequestProperties(part, prefix)),
    ...(schema.items ? allRequestProperties(schema.items, `${prefix}[]`) : []),
  ];
}

function operations() {
  return Object.entries(contract.paths).flatMap(([route, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({ route, method, operation, pathItem })),
  );
}

describe("OpenAPI security contract", () => {
  test("uses an opaque secure cookie capability, never a client-selected owner ID", () => {
    const scheme = contract.components.securitySchemes.sessionCookie;
    expect(scheme).toMatchObject({ type: "apiKey", in: "cookie", name: "__Host-ts_session" });
    expect(scheme.description).toMatch(/opaque random session secret/i);
    expect(scheme.description).toMatch(/stores a one-way hash/i);
    expect(scheme.description).toMatch(/rotates the secret on authentication/i);
    expect(scheme.description).toMatch(/Secure,\s*HttpOnly,\s*SameSite=Lax/i);

    for (const { route, method, operation, pathItem } of operations()) {
      const bodySchema = requestSchema(operation);
      if (bodySchema) {
        const fields = allRequestProperties(bodySchema);
        expect(fields).not.toEqual(expect.arrayContaining([
          expect.stringMatching(/(^|\.)(ownerId|accountId|guestSessionId|sessionId)$/i),
        ]));
      }
      const queryOwnerParameters = operationParameters(operation, pathItem)
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name);
      expect(queryOwnerParameters).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(ownerId|accountId|guestSessionId|sessionId)$/i)]),
      );

      if (method === "post" && route === "/sessions") continue;
      if (["post", "put", "patch", "delete"].includes(method)) {
        const parameterNames = operationParameters(operation, pathItem).map((parameter) => parameter.name);
        if (["/auth/login", "/auth/register"].includes(route)) {
          expect(parameterNames).toContain("X-CSRF-Token");
          expect(operation.description).toMatch(/same-origin\/Origin and Fetch Metadata/i);
        } else {
          expect(parameterNames).toContain("X-CSRF-Token");
        }
      }
    }
  });

  test("requires CSRF/origin protection and idempotency for state-changing operations", () => {
    for (const { route, method, operation, pathItem } of operations()) {
      if (!["post", "put", "patch", "delete"].includes(method)) continue;
      const parameters = operationParameters(operation, pathItem);
      const names = parameters.map((parameter) => parameter.name);

      if (method === "post" && route === "/sessions") {
        expect(operation.description).toMatch(/same-origin\/Origin and Fetch Metadata checks/i);
        expect(operation.description).toMatch(/rate limits/i);
        expect(names).not.toContain("Idempotency-Key");
      } else {
        expect(names).toContain("Idempotency-Key");
        if (["/auth/login", "/auth/register"].includes(route)) {
          expect(names).toContain("X-CSRF-Token");
        } else {
          expect(names).toContain("X-CSRF-Token");
        }
      }
    }
  });

  test("bounds credentials, names, pagination, roster IDs, and scores in the schemas", () => {
    const schemas = contract.components.schemas;
    const registration = requestSchema(contract.paths["/auth/register"].post);
    const login = requestSchema(contract.paths["/auth/login"].post);
    expect(contract.paths["/auth/register"].post.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/RegisterCredentials");
    expect(contract.paths["/auth/login"].post.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/LoginCredentials");
    expect(registration.properties.password).toMatchObject({ minLength: 12, maxLength: 72 });
    expect(login.properties.password).toMatchObject({ minLength: 1, maxLength: 72 });
    for (const credentialSchema of [registration, login]) {
      expect(credentialSchema.properties.password.description).toMatch(/rejects passwords over 72 UTF-8 bytes/i);
      expect(credentialSchema.properties.password.description).toMatch(/no truncation/i);
      expect(credentialSchema.properties.username).toMatchObject({ minLength: 3, maxLength: 64 });
    }
    expect(resolve(schemas.PlayerInput).properties.name).toMatchObject({ minLength: 1, maxLength: 80 });
    expect(resolve(schemas.Id)).toMatchObject({ minLength: 1, maxLength: 128 });
    expect(resolve(contract.components.parameters.Limit).schema).toMatchObject({ minimum: 1, maximum: 100 });
    expect(resolve(contract.components.parameters.Cursor).schema.maxLength).toBe(512);
    expect(resolve(schemas.TeamInput).properties.playerIds).toMatchObject({ minItems: 2, maxItems: 2, uniqueItems: true });
    expect(resolve(schemas.CreateTournament).oneOf[0].properties.playerIds).toMatchObject({ minItems: 2, uniqueItems: true });
    expect(resolve(schemas.CreateTournament).oneOf[2].properties.playerIds).toMatchObject({ minItems: 4, uniqueItems: true });
    expect(resolve(schemas.RecordResult).properties.scores).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(resolve(schemas.RecordResult).properties.scores.items).toMatchObject({ type: "integer", minimum: 0, maximum: 1_000_000 });
  });

  test("requires ownership-safe not-found behavior and documents roster ownership checks", () => {
    const apiReadme = fs.readFileSync(path.join(root, "docs/api/README.md"), "utf8");
    expect(apiReadme).toMatch(/foreign-owned resource is indistinguishable from an absent resource \(`404`\)/i);
    expect(apiReadme).toMatch(/Reject unknown, malformed, duplicate, or foreign IDs/i);
    expect(apiReadme).toMatch(/Never accept `ownerId`, `accountId`, guest IDs, or session IDs/i);
    expect(apiReadme).toMatch(/Apply owner predicates to every read, join, update, and delete/i);
  });

  test("defines session revocation and credential rotation in the lifecycle contract", () => {
    const logout = contract.paths["/auth/logout"].post;
    const revoke = contract.paths["/session"].delete;
    expect(logout.summary).toMatch(/revoke/i);
    expect(contract.paths["/auth/login"].post.description).toMatch(/rotate the\s+cookie/i);
    expect(contract.paths["/auth/register"].post.description).toMatch(/rotate the\s+cookie/i);
    expect(revoke.summary).toMatch(/revoke/i);
    expect(resolve(logout.responses["204"]).description).toMatch(/revoked/i);
  });

  test("does not define state-changing behavior on API GET operations", () => {
    for (const { route, method, operation } of operations()) {
      if (method !== "get") continue;
      const description = `${operation.summary || ""} ${operation.description || ""}`;
      expect(description).not.toMatch(/\b(create|update|delete|start|finish|pause|resume|skip|cancel|record|mutate)\b/i);
      expect(route).not.toMatch(/\/(start|finish|pause|resume|skip|cancel|result)$/i);
    }
  });

  test("documents authentication throttling and generic login failure responses", () => {
    const login = contract.paths["/auth/login"].post;
    const register = contract.paths["/auth/register"].post;
    expect(login.responses["429"]).toBeDefined();
    expect(register.responses["429"]).toBeDefined();
    expect(login.description).toMatch(/do not disclose whether the\s+username exists/i);
    expect(contract.components.responses.RateLimited.headers["Retry-After"]).toBeDefined();
  });
});

describe("Legacy HTTP method regression", () => {
  test("legacy tournament navigation is not exposed as state-changing GET routes", () => {
    const source = fs.readFileSync(path.join(root, "web/src/app.ts"), "utf8");
    const getRoutes = [...source.matchAll(/\bapp\.get\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(getRoutes).not.toContain("/tournament/next");
    expect(getRoutes).not.toContain("/tournament/prev");
  });
});

describe("Database and deployment security regressions awaiting real adapters", () => {
  test.todo("production entrypoint fails closed and mounts the API router with validated secret configuration");
  test.todo("database adapter prevents foreign and unowned resource IDs from crossing owner boundaries");
  test.todo("login/registration rotate capabilities and logout/expiry revoke them server-side");
  test.todo("database adapter rejects syntactically valid but unowned roster IDs atomically at create and start");
  test.todo("bounded runtime validators reject oversized, malformed, out-of-range, and hostile inputs without partial writes");
  test.todo("hostile SQL-looking names remain literal data and cannot change query meaning or access foreign rows");
  test.todo("persistent rate-limit buckets are atomic across app instances and production proxy configuration is verified");
  test.todo("interleaved sessions and separate app instances retain isolated tournament state");
  test.todo("captured logs and error responses contain no passwords, tokens, cookies, CSRF values, or guest capabilities");
  test.todo("offline mode is restricted to its approved single-user scope and cannot be selected in production");
});
