// The M3 backpressure experiment. Downloads a big replay through a THROTTLED browser connection
// (Chromium DevTools network emulation) and samples the server's rss every 250 ms, twice:
//   stream — GET /api/replays/:id          pipeline(createReadStream, res)
//   naive  — GET /api/replays/:id?naive=1  readFile whole file, then res.end(buffer)
//
//   node scripts/make-big-log.ts 200
//   node scripts/measure-backpressure.ts [MB/s=4] > rss.csv
//
// Needs Playwright + Chromium (a dev dependency since Lab 6/7).

import { chromium } from "playwright";
import { z } from "zod";
import { startServerProcess, stopServerProcess } from "./spawn-server.ts";

/** The functions passed to page.evaluate() run in the BROWSER; this is the page global they use. */
declare const window: { __got: number };

const throughput = Number(process.argv[2] ?? 4) * 2 ** 20; // bytes per second
const id = process.argv[3] ?? "big-synthetic";
const PORT = 8790;
const base = `http://127.0.0.1:${PORT}`;

const server = await startServerProcess(PORT, { DEBUG_ROUTES: "true" });
const Health = z.object({ rssMB: z.number() });

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
    async (url: string) => {
      const body = (await fetch(url)).body;
      if (!body) return 0;
      const reader = body.getReader();
      for (;;) {
        const chunk: { done: boolean; value?: unknown } = await reader.read();
        if (chunk.done) return window.__got;
        if (chunk.value instanceof Uint8Array) window.__got += chunk.value.length;
      }
    },
    `${base}/api/replays/${id}${mode === "naive" ? "?naive=1" : ""}`,
  );
  let finished = false;
  void download.then(() => (finished = true));
  while (!finished) {
    const { rssMB } = Health.parse(await (await fetch(`${base}/health`)).json()); // Node fetch: not throttled
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
await stopServerProcess(server);
