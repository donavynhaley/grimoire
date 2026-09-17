import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("closing a chapter asks over the panel and hands over to the next one", async ({ page }, testInfo) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", { data: { name: "Chapter handover" } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const headers = { "x-grimoire-project": project.id };
  const enabled = await page.request.patch(`/api/projects/${project.id}`, {
    data: { chaptersEnabled: true },
  });
  expect(enabled.ok()).toBeTruthy();
  for (const [name, state] of [
    ["Current chapter", "open"],
    ["Next chapter", "planned"],
  ]) {
    const response = await page.request.post("/api/chapters", { headers, data: { name, state } });
    expect(response.ok()).toBeTruthy();
  }
  // Two pages that will not be finished, which is what the decision is about.
  for (let i = 1; i <= 2; i++) {
    const response = await page.request.post("/api/pages", {
      headers,
      data: { title: `Unfinished ${i}`, status: "ready", chapter: "current-chapter" },
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto(`/?project=${project.id}`);
  await page.getByRole("button", { name: /Filter by chapter/ }).click();
  await page.getByRole("menuitem", { name: /Manage chapters/ }).click();
  const settings = page.getByRole("dialog", { name: "Project settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "close", exact: true }).first().click();

  // The question is its own layer, and the settings behind it cannot be edited around.
  const decision = page.getByRole("dialog", { name: "Close Current chapter?" });
  await expect(decision).toBeVisible();
  await expect(decision).toContainText("2 pages are unfinished");
  await expect(page.locator(".settings-layout")).toHaveAttribute("inert", "");
  await decision.screenshot({ path: testInfo.outputPath("close-decision.png") });

  await decision.getByRole("button", { name: "roll them into Next chapter" }).click();

  // Closing is not the end of it: the chapter the work moved into is offered straight away.
  const next = page.getByRole("dialog", { name: "What comes next?" });
  await expect(next).toBeVisible();
  await next.screenshot({ path: testInfo.outputPath("whats-next.png") });
  await next.getByRole("button", { name: "open Next chapter" }).click();

  // The handover landed: the chapter that was planned is the one the board is now in.
  await expect(next).toBeHidden();
  await expect(page.locator(".settings-layout")).not.toHaveAttribute("inert", "");
  await expect(settings.locator(".chapter-row.state-open")).toContainText("Next chapter");
  await settings.screenshot({ path: testInfo.outputPath("after-handover.png") });
});
