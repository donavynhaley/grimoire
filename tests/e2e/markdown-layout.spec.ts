import { expect, test } from "@playwright/test";

const NOTES = [
  "# Markdown on a small screen",
  "A paragraph with **bold words**, *emphasis*, and a [readable link](https://example.com).",
  `| Feature | Details | Status |\n| --- | --- | --- |\n| Preview | ${"WideCell".repeat(30)} | Ready |`,
  `https://example.com/${"long-segment".repeat(20)}`,
  `\`\`\`\n${"long_code_expression_".repeat(20)}\n\`\`\``,
].join("\n\n");

test("wide Markdown stays inside the notes and tables scroll independently", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  const notes = page.locator('.cm-content[aria-label="Notes"]');
  await notes.fill(NOTES);
  await page.getByRole("textbox", { name: "Title", exact: true }).click();
  const scroller = page.locator(".notes-view");
  await expect(async () => {
    const widths = await scroller.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  }).toPass({ timeout: 3000 });
  const editor = await page.locator(".markdown-editor").boundingBox();
  const column = await page.locator(".page-editor-main").boundingBox();
  expect(editor).not.toBeNull();
  expect(column).not.toBeNull();
  expect(editor!.x + editor!.width).toBeLessThanOrEqual(column!.x + column!.width + 1);
  const table = page.locator(".cm-lp-table");
  const widths = await table.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  await table.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  expect(await table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  await expect(notes).toContainText("| Feature | Details | Status |");
  const source = await scroller.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(source.scroll).toBeLessThanOrEqual(source.client + 1);
  await page.getByRole("button", { name: "View notes", exact: true }).click();
  await expect(table).toBeVisible();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  await expect(page.locator(".cm-lp-table")).toBeVisible();
});
