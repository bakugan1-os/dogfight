// Lab 7: one test runner for the whole repo. `npm test` at the root runs the three projects;
// `npm run coverage` adds V8 coverage (shared/ must stay >= 85 %).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "shared", root: "shared", include: ["test/**/*.test.ts"] } },
      { test: { name: "client", root: "client", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "server",
          root: "server",
          include: ["test/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["shared/**/*.ts", "client/src/**/*.ts", "server/src/**/*.ts"],
      exclude: ["**/test/**", "**/*.test.ts"],
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { "shared/**": { statements: 85, branches: 80, functions: 85, lines: 85 } },
    },
  },
});
