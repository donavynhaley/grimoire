import { expect, test } from "@playwright/test";
import { centerOf, openBoard, swipe } from "./helpers";

/**
 * The mobile pass, held against an emulated Pixel.
 *
 * Everything here was impossible before the pass: pages could not move by touch at all,
 * dialogs were centred panels sized in vh, and the keyboard rose over the board on load.
 */
test.describe("grimoire in one hand", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone form only");

  test("the board loads without raising the keyboard over itself", async ({ page }) => {
    await openBoard(page);
    // The capture field exists and is one tap away, but it has not taken the screen.
    await expect(page.getByLabel("Capture work page")).toBeVisible();
    const focusedOnLoad = await page.evaluate(
      () => document.activeElement === document.body || document.activeElement === null,
    );
    expect(focusedOnLoad).toBe(true);
  });

  test("a page moves between columns by taps alone", async ({ page }) => {
    await openBoard(page, [{ title: "Carve the moving staircase", status: "ready" }]);

    await page.getByRole("button", { name: "Move Carve the moving staircase" }).tap();
    await expect(page.getByRole("status")).toContainText("Moving");

    await page
      .getByRole("button", { name: "Place Carve the moving staircase in In progress, position 1" })
      .tap();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "In progress" }).getByText("Carve the moving staircase"),
    ).toBeVisible();
  });

  test("a held touch lifts a page and carries it to another column", async ({ page }) => {
    await openBoard(page, [{ title: "Bind the third grimoire", status: "ready" }]);

    await page.getByRole("searchbox", { name: "Search pages", exact: true }).fill("Bind the third grimoire");
    const card = page.locator("article.board-page", { hasText: "Bind the third grimoire" });
    await expect(card).toBeInViewport();
    const from = await centerOf(card);
    // The header keeps the destination inside the viewport however long the stack has grown.
    const to = await centerOf(page.locator("section.column-in_progress header"));

    // Rest first - the same gesture without the rest is how the board scrolls.
    await swipe(page, from, to, { holdMs: 400 });

    await expect(
      page.getByRole("region", { name: "In progress" }).getByText("Bind the third grimoire"),
    ).toBeVisible();
    await expect(card).not.toHaveClass(/drag-hidden/);
  });

  test("a swipe that sets off at once scrolls instead of lifting", async ({ page }) => {
    // Give this gesture its own scrollable stack; earlier journeys must not decide its coordinates.
    await openBoard(
      page,
      Array.from({ length: 10 }, (_, index) => ({ title: `Scroll fixture ${index}`, status: "ready" })),
    );
    await page.getByRole("searchbox", { name: "Search pages", exact: true }).fill("Scroll fixture");
    const card = page.locator("article.board-page").first();
    await expect(card).toBeInViewport();
    const title = await card.locator("strong").innerText();
    const from = await centerOf(card);
    const scrolled = page.waitForFunction(() => {
      const main = document.querySelector(".board-main");
      return (main ? main.scrollTop : 0) > 0 || window.scrollY > 0;
    });
    await swipe(page, from, { x: from.x, y: from.y - 260 });
    await scrolled;

    // And the page has not gone anywhere.
    await expect(
      page.getByRole("region", { name: "Up Next" }).getByText(title, { exact: true }),
    ).toBeVisible();
  });

  test("an open page is a sheet, and pulling it down puts it away", async ({ page }) => {
    await openBoard(page, [{ title: "Chart the leyline drift", status: "ready" }]);

    await page.getByRole("button", { name: /^Open Chart the leyline drift/ }).tap();
    const sheet = page.locator(".drawer-sheet");
    await expect(sheet).toBeVisible();
    // The sheet opens on the writing, and the details are the other half of the switch
    // rather than a scroll below it - the sheet itself is one screen and does not move.
    await expect(sheet.getByRole("button", { name: "Edit notes" })).toBeVisible();
    await sheet.getByRole("button", { name: "Details" }).tap();
    await expect(page.getByRole("button", { name: "Move to Done" })).toBeVisible();
    await sheet.getByRole("button", { name: "Notes" }).tap();

    // The rise animation runs on the sheet itself, so the sheet is what has to settle
    // before anything inside it can be aimed at.
    const grabber = await centerOf(sheet.locator(".drawer-grabber"), sheet);
    await swipe(page, grabber, { x: grabber.x, y: grabber.y + 300 });
    await expect(sheet).toHaveCount(0);
  });

  test("search is one tap from the top bar", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    // A surface whose whole purpose is a query takes the keyboard even on a phone.
    await expect(page.getByLabel("Search pages, notes, ideas, and archived work")).toBeFocused();
  });
});

/**
 * The sheet is sized to the *visual* viewport, so a raised keyboard halves it. That is the
 * ordinary case on a phone, not a corner: the page editor spends most of its life under one.
 */
test.describe("the page editor under a raised keyboard", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone form only");

  test("keeps the title and the notes on screen when the panel is halved", async ({ page }) => {
    await openBoard(page, [{ title: "Reglaze the lantern", status: "ready" }]);
    await page.getByText("Reglaze the lantern").tap();
    await expect(page.getByRole("dialog", { name: "Edit page" })).toBeVisible();

    // What a keyboard does to the sheet, without needing a real one: the Drawer sizes itself
    // from `visualViewport.height`, so shrinking the window is the same input it would get.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 340 });
    await page.waitForTimeout(400);

    // Painted, not merely present: the column used to collapse to nothing and clip both of
    // these out of a zero-height box while the history and the footer kept their room.
    const shown = await page.evaluate(() => {
      const visible = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        if (box.height < 1) return false;
        const x = Math.min(box.left + box.width / 2, window.innerWidth - 1);
        const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
        const top = document.elementFromPoint(x, y);
        return !!top && (element === top || element.contains(top) || top.contains(element));
      };
      return {
        title: visible('.record-form input[name="title"]'),
        notes: visible(".markdown-editor"),
        split: document.querySelector(".page-editor-split")!.getBoundingClientRect().height,
      };
    });
    expect(shown.title).toBe(true);
    expect(shown.notes).toBe(true);
    expect(shown.split).toBeGreaterThan(0);
  });
});
