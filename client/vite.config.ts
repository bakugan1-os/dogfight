// Vite config.
//  - Lab 3: a dev/preview-server middleware that misbehaves on purpose for the failure gallery
//    (URL scheme in src/net/faults.ts).
//  - Lab 4: /api, /health and /ws are proxied to the Node game server (server/), so in
//    development the page and the server look like one origin, exactly as in production.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type Connect, type Plugin } from "vite";
import { parseFault, createFlakyCounter } from "./src/net/faults.ts";

/** Lab 8: "1.0.0+3f2a9c1" — root package.json version + the git SHA (env GIT_SHA in Docker/CI). */
function appVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof pkg === "object" && pkg && "version" in pkg && typeof pkg.version === "string"
      ? pkg.version
      : "0.0.0";
  let sha = process.env.GIT_SHA;
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      sha = "dev"; // no git (a Docker build context without .git)
    }
  }
  return `${version}+${sha.slice(0, 7)}`;
}

function faultInjection(): Plugin {
  const count = createFlakyCounter();
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const fault = parseFault(url.pathname);
    if (!fault) return next();
    const forward = () => {
      req.url = fault.base + fault.rest + url.search; // let Vite serve the real file
      next();
    };
    if (fault.kind === "delay") {
      const timer = setTimeout(forward, fault.arg);
      res.on("close", () => clearTimeout(timer)); // client aborted: never answer
    } else if (fault.kind === "status") {
      res.statusCode = fault.arg;
      res.end();
    } else if (fault.kind === "flaky" && count(fault.rest) <= fault.arg) {
      res.statusCode = 503;
      res.end();
    } else {
      forward();
    }
  };
  return {
    name: "dogfight-fault-injection",
    // Block bodies on purpose: a function RETURNED from these hooks would run as a post-hook.
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

const SERVER = `http://127.0.0.1:${process.env.SERVER_PORT || 8787}`;

export default defineConfig({
  plugins: [faultInjection()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  server: {
    proxy: {
      "/api": SERVER,
      "/health": SERVER,
      "/ready": SERVER,
      "/metrics": SERVER,
      "/ws": { target: SERVER, ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: { main: "index.html", puzzles: "puzzles.html" },
    },
  },
});
