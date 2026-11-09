const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const runner = path.join(__dirname, "api-router-runtime.cjs");

function runRuntimeCase(name) {
  return execFileSync(process.execPath, [runner, name], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.join(root, "web/tsconfig.json"),
      TS_NODE_TRANSPILE_ONLY: "1",
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({
        module: "CommonJS",
        moduleResolution: "Node",
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        target: "ES2022",
        skipLibCheck: true,
      }),
    },
  }).trim();
}

describe("API router security regressions", () => {
  test("expires malformed and unknown session cookies instead of treating them as anonymous bootstrap", () => {
    expect(runRuntimeCase("invalid-cookie")).toBe("ok");
  });

  test("rejects missing CSRF tokens, foreign origins, and cross-site metadata before store writes", () => {
    expect(runRuntimeCase("csrf-origin")).toBe("ok");
  });

  test("rejects owner-ID tampering and unknown body/query fields before persistence", () => {
    expect(runRuntimeCase("owner-input")).toBe("ok");
  });

  test("ignores forged forwarding prefixes and applies the readiness rate limit", () => {
    expect(runRuntimeCase("forwarded-rate-limit")).toBe("ok");
  });

  test("enforces the documented 72 UTF-8-byte password limit before bcrypt", () => {
    expect(runRuntimeCase("password-byte-limit")).toBe("ok");
  });

  test("rejects missing and short production API session secrets", () => {
    expect(runRuntimeCase("production-secret")).toBe("ok");
  });
});
