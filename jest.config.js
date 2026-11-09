const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset({
  tsconfig: { esModuleInterop: true, module: "CommonJS", target: "ES2022", skipLibCheck: true },
}).transform;

/** @type {import("jest").Config} **/
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/web/src/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/web/src/lib/scheduler.test.ts",
    "/web/src/api/router.test.ts",
    "/web/src/persistence/persistence.test.ts",
  ],
  transform: {
    ...tsJestTransformCfg,
  },
};
