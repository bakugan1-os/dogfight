import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/dist/", "**/node_modules/", "server/logs/"] },
  js.configs.recommended,
  {
    files: ["client/src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
  },
  {
    // shared/ runs in BOTH the browser and Node: no DOM globals and no Node globals — only the
    // platform-neutral ones both have (EventTarget, CustomEvent, AbortController, DataView…).
    files: ["shared/**/*.js"],
    ignores: ["shared/test/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        EventTarget: "readonly",
        CustomEvent: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
  {
    files: [
      "server/**/*.js",
      "shared/test/**/*.js",
      "scripts/**/*.js",
      "client/test/**/*.js",
      "client/scripts/**/*.js",
      "**/*.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
