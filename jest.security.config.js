const baseConfig = require("./jest.config");

module.exports = {
  ...baseConfig,
  testMatch: ["<rootDir>/tests/security/**/*.test.js", "<rootDir>/tests/security/**/*.test.ts"],
};
