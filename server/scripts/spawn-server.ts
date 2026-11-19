// Starts `node src/index.ts` in a child process for the measuring scripts and waits for its
// banner. A child process, so that whatever the script measures blocks the SERVER, not itself.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { WebSocket } from "ws";
import type { ClientMessage } from "@dogfight/shared/protocol/control.ts";

export async function startServerProcess(
  port: number,
  env: Record<string, string> = {},
): Promise<ChildProcess> {
  const server = spawn(process.execPath, ["src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), QUIET: "true", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let banner = "";
  server.stdout?.on("data", (d: Buffer) => (banner += String(d)));
  while (!banner.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 30));
  return server;
}

export async function stopServerProcess(server: ChildProcess): Promise<void> {
  server.kill("SIGTERM");
  await once(server, "exit");
}

/**
 * Lab 6: the only way the scripts send control messages — typed as ClientMessage, so a stale
 * field (blocking-demo.js still sent `v: 1` after Lab 5 moved to protocol v2) is a compile error.
 */
export function sendMessage(ws: WebSocket, message: ClientMessage): void {
  ws.send(JSON.stringify(message));
}
