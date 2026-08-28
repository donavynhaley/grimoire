import { expect, test, type Page } from "@playwright/test";
import { openBoard, signIn } from "./helpers";

/**
 * The page editor is a frame, not a document.
 *
 * Everything it holds used to lengthen the same scroll, so opening a page meant scrolling
 * it to find out what was on it. These hold the panel to one screen at a desk and on a
 * phone: the panel itself never scrolls, and the notes - the one thing that can genuinely
 * be longer than the screen - are what scrolls instead.
 */

const LONG_NOTES = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}: the vault sigils drift a little further out of true every week.`,
).join("\n\n");

/** Puts a page on the board carrying more notes than any panel could show at once. */
async function seedWordyPage(page: Page, title: string): Promise<void> {
  await signIn(page);
  const created = await page.request.post("/api/pages", { data: { title, status: "ready" } });
  if (!created.ok()) throw new Error(`seed failed: ${created.status()} ${await created.text()}`);
  const body = await created.json();
  const id = body.page?.id ?? body.id;
  const written = await page.request.patch(`/api/pages/${id}`, { data: { description: LONG_NOTES } });
  if (!written.ok()) throw new Error(`notes failed: ${written.status()} ${await written.text()}`);
}

/** What the panel and the notes each have to scroll, measured together in the one pass. */
async function measure(page: Page) {
  return page.locator(".page-editor").evaluate((panel) => {
    const notes = panel.querySelector(".notes-view") as HTMLElement | null;
    return {
      panelScroll: panel.scrollHeight,
      panelClient: panel.clientHeight,
      notesScroll: notes?.scrollHeight ?? 0,
      notesClient: notes?.clientHeight ?? 0,
    };
  });
}

test.describe("the page editor holds to one screen", () => {
  test("at a desk the panel does not scroll, and the notes do", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "the desktop form only");
    await seedWordyPage(page, "Anneal the ward lattice");
    await openBoard(page);

    await page
      .getByRole("button", { name: /^Open Anneal the ward lattice/ })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: "Edit page" })).toBeVisible();

    const sizes = await measure(page);
    // A single pixel of slack: sub-pixel layout, not a hidden scroll.
    expect(sizes.panelScroll).toBeLessThanOrEqual(sizes.panelClient + 1);
    expect(sizes.notesScroll).toBeGreaterThan(sizes.notesClient);

    // Both halves stand side by side, and the archive is in reach without scrolling to it.
    await expect(page.getByLabel("Page properties")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to Done" })).toBeVisible();
    await expect(page.getByRole("button", { name: "archive page" })).toBeVisible();
  });

  test("narrower than the split, the two halves take turns", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "the desktop form only");
    await seedWordyPage(page, "Transcribe the moon ledger");
    await page.setViewportSize({ width: 700, height: 820 });
    await openBoard(page);

    await page
      .getByRole("button", { name: /^Open Transcribe the moon ledger/ })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: "Edit page" })).toBeVisible();

    // The writing is what a page opens on.
    await expect(page.getByRole("button", { name: "Edit notes" })).toBeVisible();
    await expect(page.getByLabel("Page properties")).toBeHidden();

    await page.getByRole("button", { name: "Details" }).click();
    await expect(page.getByLabel("Page properties")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to Done" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit notes" })).toBeHidden();

    // And the panel is still one screen with either half showing.
    const sizes = await measure(page);
    expect(sizes.panelScroll).toBeLessThanOrEqual(sizes.panelClient + 1);

    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByRole("button", { name: "Edit notes" })).toBeVisible();
  });

  test("on a phone the sheet is one screen, and the details are one tap away", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the phone form only");
    await seedWordyPage(page, "Sound the deep bell");
    await openBoard(page);

    await page
      .getByRole("button", { name: /^Open Sound the deep bell/ })
      .first()
      .tap();
    const sheet = page.locator(".drawer-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Edit notes" })).toBeVisible();

    const sizes = await measure(page);
    expect(sizes.panelScroll).toBeLessThanOrEqual(sizes.panelClient + 1);
    expect(sizes.notesScroll).toBeGreaterThan(sizes.notesClient);

    await page.getByRole("button", { name: "Details" }).tap();
    await expect(page.getByRole("button", { name: "Move to Done" })).toBeVisible();
    expect((await measure(page)).panelScroll).toBeLessThanOrEqual((await measure(page)).panelClient + 1);
  });
});

/**
 * The two boxes on this panel that must never grow a scrollbar of their own.
 *
 * Both were caught here rather than in the unit suite, because both were a couple of pixels
 * of box arithmetic and jsdom has no boxes: it reports every height as zero, so a test there
 * cannot tell a field that fits from one that is two pixels short of its own text.
 */
test.describe("nothing on the page editor scrolls that should not", () => {
  test("the writing column holds its title and notes without scrolling", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "the desk form only");
    await seedWordyPage(page, "Ward the tower door");
    await openBoard(page);
    await page
      .getByRole("button", { name: /^Open Ward the tower door/ })
      .first()
      .click();
    await expect(page.locator(".page-editor")).toBeVisible();

    const column = await page.locator(".page-editor-main").evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
    }));
    // The notes scroll inside their own box; the column around them never does.
    expect(column.scroll).toBeLessThanOrEqual(column.client);
  });

  test("the composer is exactly as tall as what is written in it", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "the desk form only");
    await signIn(page);
    const created = await page.request.post("/api/pages", {
      data: { title: "Hold the circle", status: "ready" },
    });
    expect(created.ok()).toBe(true);
    await openBoard(page);
    await page
      .getByRole("button", { name: /^Open Hold the circle/ })
      .first()
      .click();
    await page.locator(".aside-switch .pane-tab", { hasText: "Discussion" }).click();

    const field = page.locator(".discussion-composer textarea").first();
    await expect(field).toBeVisible();

    const fits = () => field.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));

    // Empty: `scrollHeight` counts padding and content, and the height it is assigned to has
    // to hold the borders as well, so getting this wrong scrolls a field nobody has typed in.
    const empty = await fits();
    expect(empty.scroll).toBeLessThanOrEqual(empty.client);

    await field.click();
    await field.type("one line");
    const one = await fits();
    expect(one.scroll).toBeLessThanOrEqual(one.client);

    await page.keyboard.press("Shift+Enter");
    await field.type("and a second");
    const two = await fits();
    expect(two.scroll).toBeLessThanOrEqual(two.client);
    // It really did grow rather than stay put and hide the second line.
    expect(two.client).toBeGreaterThan(one.client);
  });
});
