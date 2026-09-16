import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("completed history starts in the board's chapter and can expand to all work", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", { data: { name: "Completed chapters" } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const headers = { "x-grimoire-project": project.id };
  const enabled = await page.request.patch(`/api/projects/${project.id}`, {
    data: { chaptersEnabled: true },
  });
  expect(enabled.ok()).toBeTruthy();
  for (const [name, state] of [
    ["Earlier chapter", "closed"],
    ["Current chapter", "open"],
  ]) {
    const response = await page.request.post("/api/chapters", { headers, data: { name, state } });
    expect(response.ok()).toBeTruthy();
  }
  for (const [chapter, prefix, count] of [
    ["current-chapter", "Current", 12],
    ["earlier-chapter", "Earlier", 3],
    [null, "Unplaced", 2],
  ] as const) {
    for (let i = 1; i <= count; i++) {
      const response = await page.request.post("/api/pages", {
        headers,
        data: { title: `${prefix} finished ${i}`, status: "done", chapter },
      });
      expect(response.ok()).toBeTruthy();
    }
  }
  await page.goto(`/?project=${project.id}`);
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(done).toContainText("10 of 12");
  await done.screenshot({ path: testInfo.outputPath("done-column.png") });
  const completed = done.getByRole("button", { name: "Search all completed work, 12 pages", exact: true });
  await expect(completed).toBeVisible();
  await completed.click();
  const history = page.getByRole("dialog", { name: "Completed work", exact: true });
  await expect(history).toContainText("12 finished pages");
  await expect(history.locator(".history-page")).toHaveCount(12);
  await expect(history).not.toContainText("Earlier finished");
  const chapter = history.getByRole("combobox", { name: "Completed work chapter" });
  await expect(chapter).toHaveValue("current-chapter");
  await history.screenshot({ path: testInfo.outputPath("chapter-history.png") });
  await chapter.selectOption("");
  await expect(history.locator(".history-page")).toHaveCount(17);
  await chapter.selectOption("earlier-chapter");
  await expect(history.locator(".history-page")).toHaveCount(3);
  await chapter.selectOption("none");
  await expect(history.locator(".history-page")).toHaveCount(2);
  await history.getByRole("button", { name: "Close completed work" }).click();
  await completed.click();
  await expect(history.getByRole("combobox", { name: "Completed work chapter" })).toHaveValue(
    "current-chapter",
  );
});
