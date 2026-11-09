const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/web/src/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/web/src/lib/scheduler.test.ts"],
  transform: {
    ...tsJestTransformCfg,
  },
};
