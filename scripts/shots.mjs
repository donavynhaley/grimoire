/**
 * Screenshots of the running app, so a change can be looked at rather than described.
 *
 * Points at whatever is serving Grimoire - the demo container on 8099 by default, or a dev
 * server via SHOT_BASE - signs in as the demo owner, and captures the states a page dialog
 * has: a conversation that has outgrown its column, one that has been folded away, a page
 * nobody has said anything about, and the widths where the three columns become three tabs.
 *
 * It only reads. Nothing here posts, answers, or archives, so it can be run against the demo
 * as many times as you like without the board drifting under you.
 *
 * Usage: node scripts/shots.mjs            (writes .shots/*.png)
 *        SHOT_BASE=http://127.0.0.1:5199 node scripts/shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SHOT_BASE ?? "http://127.0.0.1:8099";
const OUT = process.env.SHOT_OUT ?? ".shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(name, { width, height = 900, run }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: "donavyn@team.example.test", password: "a long enough password" },
  });
  await page.goto(BASE);
  await page.waitForSelector(".board-shell", { timeout: 15000 });
  await run(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png  (${width}x${height})`);
  await context.close();
}

const openPage = (title, { discussion = false } = {}) => async (page) => {
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForSelector(".page-editor", { timeout: 10000 });
  await page.waitForTimeout(500);
  // The column shows the properties first, so a plate of the conversation has to turn to it.
  if (discussion) {
    await page.locator(".aside-switch .pane-tab", { hasText: "Discussion" }).click();
    await page.waitForTimeout(500);
  }
};

console.log("capturing:");
await shot("01-board", { width: 1600, run: async (page) => { await page.waitForTimeout(600); } });
// The unread count, on a page whose conversation this person has not opened.
await shot("08-unseen-1600", { width: 1600, run: openPage("swap a logged meal") });
// A message addressed to the person reading it, and the picker that writes one.
await shot("09-mention-1600", { width: 1600, run: openPage("measure LCP", { discussion: true }) });
await shot("10-picker-1600", {
  width: 1600,
  run: async (page) => {
    await openPage("measure LCP", { discussion: true })(page);
    await page.locator(".discussion-composer textarea").first().click();
    await page.keyboard.type("thanks @Al");
    await page.waitForTimeout(400);
  },
});
await shot("02-heavy-1600", { width: 1600, run: openPage("cut-over runbook", { discussion: true }) });
await shot("03-heavy-1280", { width: 1280, run: openPage("cut-over runbook", { discussion: true }) });
await shot("04-quiet-1600", { width: 1600, run: openPage("preserve set order", { discussion: true }) });
await shot("05-closed-1600", {
  width: 1600,
  run: async (page) => {
    await openPage("cut-over runbook")(page);
    await page.waitForTimeout(500);
  },
});
await shot("06-narrow-880", {
  width: 880,
  run: async (page) => {
    await openPage("cut-over runbook")(page);
    await page.locator(".page-editor-panes .pane-tab", { hasText: "Discussion" }).click();
    await page.waitForTimeout(500);
  },
});
await shot("07-answered-open", {
  width: 1600,
  run: async (page) => {
    await openPage("cut-over runbook", { discussion: true })(page);
    await page.locator(".discussion-fold").click();
    await page.waitForTimeout(500);
  },
});

await browser.close();
console.log("done");
