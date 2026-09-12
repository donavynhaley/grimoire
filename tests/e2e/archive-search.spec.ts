import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("search reaches every match and restores an archived exact title", async ({ page }) => {
  await signIn(page);
  const query = `recovery${Date.now()}`;
  // Keep this deliberately large board out of the gesture tests' shared starter project.
  const created = await page.request.post("/api/projects", { data: { name: query } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()).project;
  await page.context().setExtraHTTPHeaders({ "x-grimoire-project": project.id });
  await page.goto(`/?project=${project.id}`);
  await expect(page.getByLabel("Capture work page")).toBeVisible();
  for (let index = 0; index < 40; index += 1) {
    const response = await page.request.post("/api/pages", {
      data: { title: `Task ${index}`, description: `mentions ${query}`, status: "ready" },
    });
    expect(response.ok()).toBe(true);
  }
  const response = await page.request.post("/api/pages", { data: { title: query, status: "backlog" } });
  const archived = (await response.json()).page;
  await page.request.delete(`/api/pages/${archived.id}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search everything" });
  await dialog.getByRole("searchbox").fill(query);
  await expect(dialog.locator(".search-hit")).toHaveCount(40);
  await expect(dialog.getByRole("button", { name: `Restore ${query}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Show more matches" }).click();
  await expect(dialog.locator(".search-hit")).toHaveCount(41);
  await expect(dialog.getByRole("button", { name: "Show more matches" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Archived", exact: true }).click();
  await dialog.getByRole("searchbox").clear();
  await expect(dialog.getByRole("button", { name: `Restore ${query}` })).toBeVisible();
  await dialog.getByRole("button", { name: `Restore ${query}` }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit page" }).getByLabel("Title", { exact: true }),
  ).toHaveValue(query);
  const board = await (await page.request.get("/api/board")).json();
  expect(board.pages.find((item: { id: string }) => item.id === archived.id).status).toBe("backlog");
});
