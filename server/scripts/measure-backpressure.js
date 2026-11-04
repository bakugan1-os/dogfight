// The M3 backpressure experiment. Downloads a big replay through a THROTTLED browser connection
// (Chromium DevTools network emulation) and samples the server's rss every 250 ms, twice:
//   stream — GET /api/replays/:id          pipeline(createReadStream, res)
//   naive  — GET /api/replays/:id?naive=1  readFile whole file, then res.end(buffer)
//
//   node scripts/make-big-log.js 200
//   node scripts/measure-backpressure.js [MB/s=4] > rss.csv
//
// Needs Playwright + Chromium (a measuring tool, deliberately not a project dependency).

/* global window -- the functions passed to page.evaluate() run in the browser */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const throughput = Number(process.argv[2] ?? 4) * 2 ** 20; // bytes per second
const id = process.argv[3] ?? "big-synthetic";
const PORT = 8790;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(PORT), DEBUG_ROUTES: "true", QUIET: "true" },
  stdio: ["ignore", "pipe", "inherit"],
});
let banner = "";
server.stdout.on("data", (d) => (banner += d));
while (!banner.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 50));

const browser = await chromium.launch();
console.log("mode,seconds,rss_mb,downloaded_mb");

for (const mode of ["stream", "naive"]) {
  const page = await browser.newPage();
  await page.goto(`${base}/health`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 20,
    downloadThroughput: throughput,
    uploadThroughput: -1,
  });
  await page.evaluate(() => (window.__got = 0));
  const t0 = performance.now();
  const download = page.evaluate(
    async (url) => {
      const reader = (await fetch(url, { cache: "no-store" })).body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return window.__got;
        window.__got += value.length;
      }
    },
    `${base}/api/replays/${id}${mode === "naive" ? "?naive=1" : ""}`,
  );
  let finished = false;
  download.then(() => (finished = true));
  while (!finished) {
    const { rssMB } = await (await fetch(`${base}/health`)).json(); // Node fetch: not throttled
    const got = await page.evaluate(() => window.__got).catch(() => 0);
    const s = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`${mode},${s},${rssMB},${(got / 2 ** 20).toFixed(1)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await download;
  await page.close();
  await new Promise((r) => setTimeout(r, 3000)); // let the naive buffer be collected
}

await browser.close();
server.kill("SIGTERM");
await once(server, "exit");
