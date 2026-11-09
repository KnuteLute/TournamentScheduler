import js from '@eslint/js'
import globals from 'globals'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module', ecmaVersion: 'latest' },
      globals: globals.browser,
    },
  },
  { files: ['src/**/*.ts', 'tests/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['vite.config.ts'], languageOptions: { globals: globals.node } },
)
