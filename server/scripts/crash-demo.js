// M4: why an unhandled "error" event or an unhandled rejection takes the WHOLE server down.
// Runs four tiny programs in child processes and prints how each one ended.
//
//   node scripts/crash-demo.js

import { spawnSync } from "node:child_process";

const cases = {
  "emitter 'error', no listener": `
    const { EventEmitter } = require("node:events");
    const socket = new EventEmitter();
    setInterval(() => {}, 1000);           // a "server" that would otherwise run forever
    socket.emit("error", new Error("ECONNRESET: client vanished"));
    console.log("still serving?");`,
  "emitter 'error', with a listener (the fix)": `
    const { EventEmitter } = require("node:events");
    const socket = new EventEmitter();
    socket.on("error", (e) => console.log("logged:", e.message, "- server keeps running"));
    socket.emit("error", new Error("ECONNRESET: client vanished"));
    setTimeout(() => console.log("still serving: yes"), 50);`,
  "unhandled rejection": `
    setInterval(() => {}, 1000);
    async function loadRoom() { throw new Error("room file is corrupt"); }
    loadRoom();                            // no await, no .catch
    setTimeout(() => console.log("still serving?"), 50);`,
  "rejection handled (the fix)": `
    async function loadRoom() { throw new Error("room file is corrupt"); }
    loadRoom().catch((e) => console.log("logged:", e.message, "- request answered with 500"));
    setTimeout(() => console.log("still serving: yes"), 50);`,
};

for (const [name, code] of Object.entries(cases)) {
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 2000 });
  const err = r.stderr
    .split("\n")
    .filter((l) => /Error|throw|Unhandled/.test(l))
    .slice(0, 3);
  console.log(`\n## ${name}`);
  console.log(`exit code: ${r.status ?? `killed (${r.signal}) — it was still running`}`);
  if (r.stdout.trim()) console.log(`stdout: ${r.stdout.trim().replace(/\n/g, " | ")}`);
  if (err.length) console.log(`stderr: ${err.map((l) => l.trim()).join(" | ")}`);
}
