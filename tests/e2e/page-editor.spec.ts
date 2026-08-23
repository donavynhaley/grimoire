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

    await page.getByRole("button", { name: /^Open Anneal the ward lattice/ }).first().click();
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

    await page.getByRole("button", { name: /^Open Transcribe the moon ledger/ }).first().click();
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

    await page.getByRole("button", { name: /^Open Sound the deep bell/ }).first().tap();
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
