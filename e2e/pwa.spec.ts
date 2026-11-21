// Lab 8: the game is installable — Chrome itself is asked (DevTools protocol) whether the page
// passes its install criteria: a manifest with name + icons, a service worker that controls the
// page, a secure origin (127.0.0.1 counts as one).

import { test, expect } from "@playwright/test";

test("PWA: valid manifest, the service worker takes control, Chrome reports no install errors", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 10_000,
    })
    .toBe(true);

  const cdp = await context.newCDPSession(page);
  const manifest = (await cdp.send("Page.getAppManifest")) as {
    url: string;
    errors: Array<{ message: string }>;
  };
  expect(manifest.url).toMatch(/manifest\.webmanifest$/);
  expect(manifest.errors).toEqual([]);
  const install = (await cdp.send("Page.getInstallabilityErrors")) as {
    installabilityErrors: Array<{ errorId: string }>;
  };
  expect(install.installabilityErrors.map((e) => e.errorId)).toEqual([]);

  // never cached: the live endpoints go straight to the server
  const health = await page.evaluate(async () =>
    (await fetch("/health")).headers.get("cache-control"),
  );
  expect(health).toBe("no-store");
});
