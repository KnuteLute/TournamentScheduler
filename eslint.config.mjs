import eslint from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import vueParser from "vue-eslint-parser";
import vuePlugin from "eslint-plugin-vue";

const maintainedTypeScript = [
  "web/src/api/**/*.ts",
  "web/src/auth/**/*.ts",
  "web/src/config/**/*.ts",
  "web/src/domain/**/*.ts",
  "web/src/persistence/**/*.ts",
  "web/src/services/**/*.ts",
  "frontend/src/**/*.ts",
  "packages/contracts/src/**/*.ts",
  "tests/**/*.ts",
];

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "web/src/lib/**", "web/src/app.js"],
  },
  eslint.configs.recommended,
  {
    files: maintainedTypeScript,
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["frontend/src/**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { vue: vuePlugin },
    rules: {
      "vue/no-parsing-error": "error",
      "vue/no-dupe-keys": "error",
      "vue/no-unused-vars": "error",
    },
  },
];
