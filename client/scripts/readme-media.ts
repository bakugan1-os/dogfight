// Lab 8: the README's pictures, reproducibly. Run `npm run build` first.
//
//   node client/scripts/readme-media.ts
//     docs/img/lab08-hero.gif      two browsers (Ada + Bob, autopilot) and 5 bots in one match
//     docs/img/lab08-hud.png       the netgraph with the client + server version stamp
//     docs/img/lab08-restart.png   the lobby after the server was killed mid-match (SIGKILL)
//
// Needs Playwright's Chromium and ffmpeg (palette-based GIF).

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { waitReady } from "../../server/scripts/spawn-server.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMG = `${ROOT}docs/img/`;
const PORT = 8797;
const base = `http://127.0.0.1:${PORT}`;
const ROOM = "r-104";
const size = { width: 960, height: 600 };

let server: ChildProcess | null = null;
async function start(): Promise<void> {
  server = spawn(process.execPath, ["server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), QUIET: "true", GIT_SHA: gitSha() },
    stdio: "ignore",
  });
  await waitReady(base);
}
function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}
async function stop(signal: NodeJS.Signals): Promise<void> {
  const s = server;
  if (!s) return;
  const exited = new Promise((r) => s.once("exit", r));
  s.kill(signal);
  await exited;
}

const inGame = (page: Page) =>
  page.waitForFunction(
    () =>
      (globalThis as unknown as { __dogfight?: { netState?: { slot: number } | null } }).__dogfight
        ?.netState?.slot,
    undefined,
    { timeout: 15_000 },
  );

await start();
const browser = await chromium.launch();
const videoDir = await mkdtemp(join(tmpdir(), "dogfight-video-"));
try {
  // ---- hero GIF: Ada's screen, Bob in the same room, bots around them
  const ada = await browser.newContext({ viewport: size, recordVideo: { dir: videoDir, size } });
  const bob = await browser.newContext({ viewport: size });
  const adaPage = await ada.newPage();
  const bobPage = await bob.newPage();
  await adaPage.goto(`${base}/?join=${ROOM}&name=Ada&autopilot=1`);
  await bobPage.goto(`${base}/?join=${ROOM}&name=Bob&autopilot=1`);
  await Promise.all([inGame(adaPage), inGame(bobPage)]);
  await adaPage.keyboard.press("KeyH"); // hide the key help: more game, less text
  await fetch(`${base}/api/rooms/${ROOM}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 5 }),
  });
  await adaPage.waitForTimeout(9000);
  await adaPage.screenshot({ path: `${IMG}lab08-hud.png` });
  const video = adaPage.video();
  await ada.close(); // the video file is complete only after its context closes
  const webm = await video?.path();
  if (webm) {
    // skip the first 2 s (loading), 6 s at 12 fps, 640 px wide, one shared 128-colour palette
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      "3",
      "-t",
      "6",
      "-i",
      webm,
      "-vf",
      "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
      `${IMG}lab08-hero.gif`,
    ]);
  }

  // ---- server killed mid-match: Bob ends up in the lobby with an explanation
  await stop("SIGKILL");
  await bobPage.waitForTimeout(2000);
  await start();
  await bobPage.locator("p.notice:not([hidden])").waitFor({ timeout: 30_000 });
  await bobPage.locator("ul.rooms button.room").first().waitFor({ timeout: 30_000 });
  await bobPage.locator("#pilot").fill("Bob");
  await bobPage.waitForTimeout(4500); // one more lobby poll: Bob's old seat is released by then
  await bobPage.screenshot({ path: `${IMG}lab08-restart.png` });
  await bob.close();
} finally {
  await browser.close();
  await stop("SIGTERM");
  await rm(videoDir, { recursive: true, force: true });
}
console.log("-> docs/img/lab08-hero.gif, lab08-hud.png, lab08-restart.png");
