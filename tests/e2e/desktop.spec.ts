import { expect, test } from "@playwright/test";
import { centerOf, openBoard } from "./helpers";

/**
 * The other half of the promise: the pass changes what a phone gets, not what a desktop has.
 */
test.describe("grimoire at a desk, unchanged", () => {
  test.skip(({ isMobile }) => Boolean(isMobile), "the desktop form only");

  test("the capture field still takes the caret on arrival", async ({ page }) => {
    await openBoard(page);
    await expect(page.getByLabel("Capture work page")).toBeFocused();
  });

  test("an open page is still a centred dialog, not a sheet", async ({ page }) => {
    await openBoard(page, [{ title: "Rekey the vault sigils", status: "ready" }]);

    await page.getByRole("button", { name: /^Open Rekey the vault sigils/ }).click();
    const dialog = page.getByRole("dialog", { name: "Edit page" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/dialog-panel/);
    await expect(dialog).not.toHaveClass(/drawer-sheet/);
    await expect(page.locator(".drawer-grabber")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("a mouse still drags a page between columns", async ({ page }) => {
    await openBoard(page, [{ title: "Polish the scrying bowl", status: "ready" }]);

    const from = await centerOf(page.locator("article.board-page", { hasText: "Polish the scrying bowl" }));
    const to = await centerOf(page.locator("section.column-in_progress header"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Travel in steps, the way a hand does, so the drop hint tracks the crossing.
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await page.mouse.up();

    await expect(
      page.getByRole("region", { name: "In progress" }).getByText("Polish the scrying bowl"),
    ).toBeVisible();
  });

  test("dropping a page back where it started only opens nothing", async ({ page }) => {
    await openBoard(page, [{ title: "Feed the archive moths", status: "ready" }]);

    const from = await centerOf(page.locator("article.board-page", { hasText: "Feed the archive moths" }));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 10, { steps: 4 });
    await page.mouse.move(from.x, from.y, { steps: 4 });
    await page.mouse.up();

    // The click the browser sends after a drag must not open the page editor.
    await expect(page.getByRole("dialog", { name: "Edit page" })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Up Next" }).getByText("Feed the archive moths"),
    ).toBeVisible();
  });
});
