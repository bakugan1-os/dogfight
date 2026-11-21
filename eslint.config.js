// ESLint (flat config) with typescript-eslint. (Plain JS: a .ts config would need one more
// dependency, jiti, just to load it.) tsc checks TYPES; ESLint checks habits — and two
// of them matter for Lab 6: no `any`, and every `as` cast is visible (`consistent-type-assertions`).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "server/logs/",
      "coverage/",
      "test-results/",
      "playwright-report/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Lab 8: the service worker is plain JS that runs in a worker, not on a page.
    files: ["client/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Lab 7: TYPE-CHECKED rules. ESLint asks the TypeScript compiler (projectService finds each
    // file's tsconfig) whether an expression is a Promise, an `any`, … — things syntax alone
    // cannot know.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    // test doubles are often `async () => { throw … }` on purpose: a rejecting promise
    files: ["**/test/**/*.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["client/src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    // shared/ runs in BOTH the browser and Node: no DOM globals and no Node globals — only the
    // platform-neutral ones both have (AbortController, TextDecoder, DataView…).
    files: ["shared/**/*.ts"],
    ignores: ["shared/test/**"],
    languageOptions: {
      globals: { AbortController: "readonly", AbortSignal: "readonly", TextDecoder: "readonly" },
    },
  },
  {
    files: [
      "server/**/*.ts",
      "shared/test/**/*.ts",
      "scripts/**/*.ts",
      "client/test/**/*.ts",
      "client/scripts/**/*.ts",
      "**/*.config.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // `x as T` stays allowed (with a comment, < 5 in the codebase); `<T>x` and object-literal
      // casts are not — they hide missing fields.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],
    },
  },
);
