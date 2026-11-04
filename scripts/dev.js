// `npm run dev`: the Node game server (with --watch) and the Vite dev server, side by side.
// Plain child_process instead of a dependency, so it works the same on Windows, macOS, Linux.
// Ctrl+C stops both.

import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

const processes = [
  {
    name: "server",
    color: 35,
    args: ["--watch", "src/index.js"],
    cwd: join(root, "server"),
    env: { DEBUG_ROUTES: "true" },
  },
  { name: "client", color: 36, args: [vite], cwd: join(root, "client"), env: {} },
];

const children = processes.map(({ name, color, args, cwd, env }) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const relay = (stream, target) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) target.write(prefix + line + "\n");
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    console.log(`${prefix}exited (${signal ?? code})`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
