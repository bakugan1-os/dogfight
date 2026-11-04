import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
  },
  {
    // The simulation must stay DOM-free: no browser globals are allowed in src/sim —
    // except EventTarget/CustomEvent, which are platform-neutral (Node 22 has them too).
    files: ["src/sim/**/*.js"],
    languageOptions: { globals: { EventTarget: "readonly", CustomEvent: "readonly" } },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.js", "*.config.js"],
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
