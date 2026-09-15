import { expect, type Locator, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

async function openEmptyNotes(page: Page): Promise<Locator> {
  await signIn(page);
  const response = await page.request.post("/api/pages", {
    data: { title: "Notes caret alignment", status: "ready" },
  });
  expect(response.ok()).toBeTruthy();
  const { page: work } = await response.json();
  await page.goto(`/?page=${work.id}`);
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await expect(notes).toBeVisible();
  return notes;
}

/** Compare the painted caret with the glyph bounds, not the editor's outer padding. */
async function expectCaretAligned(page: Page, target: Locator, atEnd = false) {
  await expect
    .poll(async () => {
      const caret = await page.locator(".markdown-editor .cm-cursor-primary").boundingBox();
      const text = await target.evaluate((element, end) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
        return rects.at(end ? -1 : 0)?.toJSON();
      }, atEnd);
      if (!caret || !text?.height) return false;
      const expectedX = atEnd ? text.right : text.left;
      return (
        Math.abs(caret.x - expectedX) <= 2 &&
        Math.abs(caret.y - text.top) <= 2 &&
        Math.abs(caret.height - text.height) <= 2
      );
    })
    .toBe(true);
}

test("empty notes keep the caret beside the placeholder when clicked or focused by keyboard", async ({
  page,
}, testInfo) => {
  const notes = await openEmptyNotes(page);
  const placeholder = notes.locator(".cm-placeholder");
  await notes.click({ position: { x: 15, y: 12 } });
  await expect(notes).toBeFocused();
  await expectCaretAligned(page, placeholder);
  await page.screenshot({ path: testInfo.outputPath("empty-notes-caret.png"), caret: "initial" });

  // Clicking lower in an otherwise empty field still places the insertion point on line one.
  await notes.click({ position: { x: 100, y: 100 } });
  await expectCaretAligned(page, placeholder);
  await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  await expect(notes).toBeFocused();
  await expectCaretAligned(page, placeholder);
  await notes.press("Escape");
  await expect(notes).not.toBeFocused();
  await notes.focus();
  await expectCaretAligned(page, placeholder);

  await notes.pressSequentially("First line");
  await expect(placeholder).toHaveCount(0);
  await expectCaretAligned(page, notes.locator(".cm-line"), true);
  await notes.press("ControlOrMeta+a");
  await notes.press("Backspace");
  await expect(placeholder).toBeVisible();
  await expectCaretAligned(page, placeholder);
});

test("the caret follows wrapped notes and scrolling without obscuring selected text", async ({
  page,
}, testInfo) => {
  const notes = await openEmptyNotes(page);
  await notes.fill(
    Array.from({ length: 45 }, (_, i) => `Line ${i + 1}: notes remain editable across the whole page.`).join(
      "\n",
    ),
  );
  await notes.press("ControlOrMeta+End");
  await expectCaretAligned(page, notes.locator(".cm-line").last(), true);
  await expect.poll(() => page.locator(".notes-view").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await notes.press("ControlOrMeta+Home");
  await expectCaretAligned(page, notes.locator(".cm-line").first());
  await notes.press("Shift+ArrowDown");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
  await expect(page.locator(".markdown-editor .cm-selectionBackground").first()).toBeVisible();
  const selectionStyle = await notes.evaluate((element) => {
    const editor = element.closest(".cm-editor");
    const background = editor?.querySelector(".cm-selectionBackground");
    const line = element.querySelector(".cm-line");
    return {
      background: background && getComputedStyle(background).backgroundColor,
      foreground: line && getComputedStyle(line, "::selection").color,
      text: getComputedStyle(element).color,
      nativeCaret: getComputedStyle(element).caretColor,
    };
  });
  expect(selectionStyle.background).toBe("rgb(35, 48, 33)");
  expect(selectionStyle.foreground).toBe(selectionStyle.text);
  expect(selectionStyle.nativeCaret).toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: testInfo.outputPath("selected-notes.png"), caret: "initial" });
  // Replacing the selection must edit the same document that the highlight describes.
  await notes.pressSequentially("Replacement ");
  await expect(notes).toContainText("Replacement ");
});
