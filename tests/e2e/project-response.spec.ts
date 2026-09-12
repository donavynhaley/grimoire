import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers";

test("a late background response cannot replace a newly selected project", async ({ page }) => {
  await openBoard(page);
  const original = await (await page.request.get("/api/board")).json();
  const result = await page.request.post("/api/projects", { data: { name: `Second project ${Date.now()}` } });
  const second = (await result.json()).project;
  await page.goto(`/?project=${original.project.id}`);
  await expect(page.locator(".project-menu-name")).toHaveText(original.project.name);
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let intercept = true;
  await page.route("**/api/board", async (route) => {
    if (intercept && route.request().headers()["x-grimoire-project"] === original.project.id) {
      intercept = false;
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response }).catch(() => undefined);
    } else await route.continue();
  });
  let backgroundId: string | undefined;
  try {
    // Wait for the live stream before creating the change that starts the delayed read.
    await expect
      .poll(async () => page.evaluate(() => document.querySelector('[title$=" (online)"]') !== null))
      .toBe(true);
    const background = await page.request.post("/api/pages", {
      headers: { "x-grimoire-project": original.project.id },
      data: { title: "Background change", status: "ready" },
    });
    backgroundId = (await background.json()).page.id;
    await held;
    await page.locator(".project-menu-trigger").click();
    await page.getByRole("menuitem", { name: second.name, exact: true }).click();
    await expect(page.locator(".project-menu-name")).toHaveText(second.name);
    release();
    await page.waitForTimeout(300);
    await expect(page.locator(".project-menu-name")).toHaveText(second.name);
    expect(new URL(page.url()).searchParams.get("project")).toBe(second.id);
    const write = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/pages",
    );
    await page.getByLabel("Capture work page").fill("Written in second project");
    await page.getByLabel("Capture work page").press("Enter");
    expect((await write).headers()["x-grimoire-project"]).toBe(second.id);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    if (backgroundId)
      await page.request.delete(`/api/pages/${backgroundId}`, {
        headers: { "x-grimoire-project": original.project.id },
      });
  }
});
