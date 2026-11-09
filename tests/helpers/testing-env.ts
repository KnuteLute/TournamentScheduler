export function syntheticPassword(): string {
  const password = process.env.TEST_ACCOUNT_PASSWORD;
  if (process.env.NODE_ENV !== "test" || !password || password.length < 12) {
    throw new Error("A 12+ character TEST_ACCOUNT_PASSWORD must be injected into the test environment");
  }
  return password;
}
