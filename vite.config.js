// Vite config: only one addition — a dev/preview-server middleware that misbehaves on purpose
// for the Lab 3 failure gallery. URL scheme in src/net/faults.js.

import { defineConfig } from "vite";
import { parseFault, createFlakyCounter } from "./src/net/faults.js";

function faultInjection() {
  const count = createFlakyCounter();
  const middleware = (req, res, next) => {
    const url = new URL(req.url, "http://localhost");
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

export default defineConfig({
  plugins: [faultInjection()],
  build: {
    rollupOptions: {
      input: { main: "index.html", puzzles: "puzzles.html" },
    },
  },
});
