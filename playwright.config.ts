import { defineConfig } from "@playwright/test";

if (process.env.NODE_ENV !== "test") {
  throw new Error("Browser tests require NODE_ENV=test");
}

const databaseURL = process.env.POSTGRES_URL;
const expectedDatabase = process.env.TEST_DATABASE_NAME;
if (!databaseURL || !expectedDatabase) {
  throw new Error("Browser tests require POSTGRES_URL and TEST_DATABASE_NAME for disposable PostgreSQL");
}
const parsedDatabaseURL = new URL(databaseURL);
if (
  !["postgres:", "postgresql:"].includes(parsedDatabaseURL.protocol) ||
  !["localhost", "127.0.0.1", "::1"].includes(parsedDatabaseURL.hostname)
) {
  throw new Error("Browser tests may only use a loopback PostgreSQL service");
}
const databaseName = decodeURIComponent(parsedDatabaseURL.pathname.replace(/^\//, ""));
if (
  databaseName !== expectedDatabase ||
  !/(^|[_-])(test|tests|ci)([_-]|$)/i.test(databaseName)
) {
  throw new Error("Refusing browser tests unless POSTGRES_URL names the explicit disposable test database");
}

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error("E2E_BASE_URL must point to a local application using disposable test services");
}

const parsedBaseURL = new URL(baseURL);
if (!["http:", "https:"].includes(parsedBaseURL.protocol) || parsedBaseURL.pathname !== "/") {
  throw new Error("E2E_BASE_URL must be a loopback HTTP(S) origin without a path");
}
if (!["localhost", "127.0.0.1", "::1"].includes(parsedBaseURL.hostname)) {
  throw new Error("Browser tests may only run against a loopback E2E_BASE_URL");
}
if (parsedBaseURL.username || parsedBaseURL.password || parsedBaseURL.search || parsedBaseURL.hash) {
  throw new Error("E2E_BASE_URL must not contain credentials, a query, or a fragment");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL: parsedBaseURL.origin,
    browserName: "chromium",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10_000,
  },
});
