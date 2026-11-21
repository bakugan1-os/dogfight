// Lab 7, M2: two browsers, one room. Everything a player does goes through the real UI.

import { test, expect, type Browser, type Page } from "@playwright/test";

type Ship = { slot: number; x: number; y: number };
type Probe = { __dogfight: { netState: { slot: number; ships: Ship[] } | null } };

async function player(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext(); // a separate "browser profile": own storage, own socket
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Почати" }).click(); // loading screen -> lobby
  await page.locator("#pilot").fill(name);
  await page.getByRole("button", { name: /Кают-компанія/ }).click();
  await page.getByRole("button", { name: "Приєднатися" }).click();
  return page;
}

const roster = (page: Page) => page.locator("ul.roster li");
const netState = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Probe).__dogfight.netState);

test("two players: shared roster, chat, and movement seen by the other within 500 ms", async ({
  browser,
}) => {
  const ada = await player(browser, "Ada");
  const bob = await player(browser, "Bob");

  // roster: both names, in both browsers
  for (const page of [ada, bob]) {
    await expect(roster(page)).toHaveCount(2);
    await expect(roster(page)).toContainText(["Ada", "Bob"]);
  }

  // chat: Ada writes, Bob reads
  await ada.getByRole("textbox", { name: "Повідомлення" }).fill("привіт, Bob");
  await ada.keyboard.press("Enter");
  await expect(bob.locator("ol.chat-log")).toContainText("привіт, Bob");

  // the game: both press "Грати"
  for (const page of [ada, bob]) await page.getByRole("button", { name: "Грати" }).click();
  await expect.poll(async () => (await netState(ada))?.slot).toBeTruthy();
  const adaSlot = (await netState(ada))?.slot;
  await expect
    .poll(async () => (await netState(bob))?.ships.some((s) => s.slot === adaSlot))
    .toBe(true);

  // Ada thrusts; Bob's copy of Ada's ship must move within 500 ms
  const before = (await netState(bob))?.ships.find((s) => s.slot === adaSlot);
  await ada.keyboard.down("KeyW");
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = (await netState(bob))?.ships.find((s) => s.slot === adaSlot);
        return before && now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { timeout: 500, intervals: [20] },
    )
    .toBeGreaterThan(2);
  const seen = Date.now() - t0;
  await ada.keyboard.up("KeyW");
  test
    .info()
    .annotations.push({ type: "latency", description: `Bob saw Ada move after ${seen} ms` });
  console.log(`Bob saw Ada move after ${seen} ms`);
});
