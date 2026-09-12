import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers";

test("reconnection retries failed reconciliation and recovers work and ideas without another edit", async ({
  page,
  context,
}) => {
  await openBoard(page);
  await expect(page.locator('[title$=" (online)"]')).toBeAttached();
  await page.getByRole("button", { name: "ideas", exact: true }).click();
  await expect(page.getByLabel("Capture an idea")).toBeVisible();
  const board = await (await page.request.get("/api/board")).json();
  const headers = { "x-grimoire-project": board.project.id };
  await context.setOffline(true);
  const title = `Offline work ${Date.now()}`;
  const idea = `Offline idea ${Date.now()}`;
  const workResponse = await page.request.post("/api/pages", { headers, data: { title, status: "ready" } });
  expect(workResponse.ok()).toBe(true);
  const workId = (await workResponse.json()).page.id;
  const ideaResponse = await page.request.post("/api/ideas", { headers, data: { title: idea } });
  expect(ideaResponse.ok()).toBe(true);
  const ideaId = (await ideaResponse.json()).idea.id;
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/seen") seen += 1;
  });
  await page.route("**/api/board", async (route) => {
    attempts += 1;
    if (attempts === 1)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Temporarily unavailable"}',
      });
    else {
      await gate;
      await route.continue();
    }
  });
  try {
    await context.setOffline(false);
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
    expect(seen).toBe(0);
    release();
    await expect(page.getByText(idea, { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toHaveCount(0);
    await page.getByRole("button", { name: "work", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  } finally {
    release();
    await context.setOffline(false);
    await page.unrouteAll({ behavior: "wait" });
    await page.request.delete(`/api/pages/${workId}`, { headers });
    await page.request.delete(`/api/ideas/${ideaId}`, { headers });
  }
});
