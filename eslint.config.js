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
    // The simulation must stay DOM-free: no browser globals are allowed in client/src/sim —
    // except EventTarget/CustomEvent, which are platform-neutral (Node 22 has them too).
    files: ["client/src/sim/**/*.js"],
    languageOptions: { globals: { EventTarget: "readonly", CustomEvent: "readonly" } },
  },
  {
    files: [
      "server/**/*.js",
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
