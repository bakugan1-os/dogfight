// ESLint (flat config) with typescript-eslint. (Plain JS: a .ts config would need one more
// dependency, jiti, just to load it.) tsc checks TYPES; ESLint checks habits — and two
// of them matter for Lab 6: no `any`, and every `as` cast is visible (`consistent-type-assertions`).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "server/logs/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
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
