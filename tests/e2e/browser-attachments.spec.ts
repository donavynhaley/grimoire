import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/attachments/${name}`, import.meta.url));

async function dropFiles(page: Page, selector: string, names: string[]) {
  const files = names.map((name) => ({
    name,
    data: readFileSync(fixture(name)).toString("base64"),
    type: name.endsWith("mp4") ? "video/mp4" : "image/png",
  }));
  return page.evaluate(
    ({ selector, files }) => {
      const target = document.querySelector(selector)!;
      const transfer = new DataTransfer();
      for (const file of files)
        transfer.items.add(
          new File([Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))], file.name, {
            type: file.type,
          }),
        );
      for (const type of ["dragenter", "dragover", "drop"]) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        target.dispatchEvent(event);
        if (!event.defaultPrevented) return false;
      }
      return true;
    },
    { selector, files },
  );
}

async function openPage(page: Page, title: string) {
  await signIn(page);
  const created = await page.request.post("/api/pages", {
    data: { title, description: "Keep this brief intact.", status: "ready" },
  });
  expect(created.ok()).toBe(true);
  const { page: work } = await created.json();
  await page.goto(`/?page=${work.id}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  return work.id as string;
}

test("a signed-in writer chooses images and videos and retries a lost response without duplicating files", async ({
  page,
}, testInfo) => {
  const id = await openPage(page, `Browser uploads ${testInfo.project.name}`);
  const dialog = page.getByRole("dialog");
  let loseResponse = true;
  await page.route("**/api/attachment-uploads/*/complete", async (route) => {
    if (!loseResponse) return route.continue();
    loseResponse = false;
    await route.fetch();
    await route.abort("failed");
  });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Add image or video", exact: true }).click();
  await (await chooser).setFiles([fixture("image.png"), fixture("recording.mp4")]);
  await expect(dialog.getByRole("button", { name: "Retry image.png", exact: true })).toBeVisible();
  await expect(dialog.locator(".notes-field video")).toBeVisible();
  await dialog.getByRole("button", { name: "Retry image.png", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".notes-field img.cm-lp-image")).toHaveCount(1);
  await expect(dialog.locator(".notes-field video")).toHaveCount(1);
  const video = dialog.locator("video");
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).page.description)
    .toContain('"video/mp4"');
  expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toContain(
    "Keep this brief intact.",
  );
  expect((await (await page.request.get(`/api/pages/${id}/attachments`)).json()).attachments).toHaveLength(2);
  const bounds = await dialog.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height + 1);
  await page.screenshot({ path: testInfo.outputPath("browser-uploads.png") });
});

test("file drops on notes and the modal header attach media and reject unsupported or oversized files in place", async ({
  page,
}, testInfo) => {
  const id = await openPage(page, `Dropped evidence ${testInfo.project.name}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  expect(await dropFiles(page, ".cm-content", ["image.png", "recording.mp4"])).toBe(true);
  await expect(page.locator(".notes-field img.cm-lp-image")).toHaveCount(1);
  await expect(page.locator(".notes-field video")).toHaveCount(1);
  expect(await dropFiles(page, ".dialog-header", ["image.png", "recording.mp4"])).toBe(true);
  await expect(page.locator(".page-upload").filter({ hasText: "Attached" })).toHaveCount(4);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["unsupported"], "report.txt", { type: "text/plain" }));
    transfer.items.add(new File([new Uint8Array(10_000_001)], "too-large.png", { type: "image/png" }));
    document
      .querySelector(".dialog-header")!
      .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "Choose a PNG" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "10 MB or smaller" })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".page-editor.drop-active")).toHaveCount(0);
  await expect(page.locator(".notes-field img.cm-lp-image")).toHaveCount(2);
  await expect(page.locator(".notes-field video")).toHaveCount(2);
  expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toContain(
    "Keep this brief intact.",
  );
});

test("demo visitors can attach and play media without sending any API requests", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.abort(),
  );
  await page.goto("/demo");
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add image or video", exact: true }).click();
  await (await chooser).setFiles(fixture("image.png"));
  await expect(page.getByRole("img", { name: "image.png" })).toBeVisible();
  expect(await dropFiles(page, ".dialog-header", ["recording.mp4"])).toBe(true);
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByText("No attachments yet.")).toBeVisible();
  expect(requests).toEqual([]);
});

test("closing during an upload preserves edits, stops queued files, and allows resuming on the original page", async ({
  page,
  isMobile,
}, testInfo) => {
  const id = await openPage(page, `Paused uploads ${testInfo.project.name}`);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let reached!: () => void;
  const chunkStarted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let finished!: () => void;
  const chunkFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let begins = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/attachments/uploads")) begins += 1;
  });
  await page.route("**/api/attachment-uploads/*/chunks", async (route) => {
    reached();
    await blocked;
    await route.continue().catch(() => undefined);
    finished();
  });
  try {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add image or video", exact: true }).click();
    await (await chooser).setFiles([fixture("recording.mp4"), fixture("image.png")]);
    await chunkStarted;
    if (isMobile) await page.getByRole("button", { name: "Notes", exact: true }).click();
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    // CodeMirror owns selection; use its keyboard commands rather than fill's DOM range.
    await notes.click();
    await notes.press("ControlOrMeta+a");
    await notes.press("Backspace");
    await expect(
      notes.getByText("Add only the context someone needs to act...", { exact: true }),
    ).toBeVisible();
    await notes.pressSequentially("Written while uploading.");
    await expect(notes).toHaveText("Written while uploading.");
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    unblock();
    await chunkFinished;
    await page.unrouteAll({ behavior: "wait" });
    const created = await page.request.post("/api/pages", {
      data: { title: `Other destination ${testInfo.project.name}`, status: "ready" },
    });
    const { page: other } = await created.json();
    await page.goto(`/?page=${other.id}`);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByText("No attachments yet.")).toBeVisible();
    expect(begins).toBe(1);
    await page.goto(`/?page=${id}`);
    const resume = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add image or video", exact: true }).click();
    await (await resume).setFiles([fixture("recording.mp4"), fixture("image.png")]);
    await expect(page.locator(".notes-field img.cm-lp-image")).toHaveCount(1);
    await expect(page.locator(".notes-field video")).toHaveCount(1);
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).page.description)
      .toContain('"video/mp4"');
    expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toContain(
      "Written while uploading.",
    );
    expect(
      (await (await page.request.get(`/api/pages/${other.id}/attachments`)).json()).attachments,
    ).toHaveLength(0);
  } finally {
    unblock();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("an inline recording keeps its insertion point through typing and survives reopening with surrounding notes", async ({
  page,
}, testInfo) => {
  const id = await openPage(page, `Inline recording ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await notes.press("ControlOrMeta+a");
  await notes.press("Backspace");
  await expect(
    notes.getByText("Add only the context someone needs to act...", { exact: true }),
  ).toBeVisible();
  await notes.pressSequentially("Before.");
  await notes.press("Enter");
  await expect(notes.locator(".cm-line")).toHaveCount(2);
  await notes.press("Enter");
  await expect(notes.locator(".cm-line")).toHaveCount(3);
  await notes.pressSequentially("After.");
  await notes.press("ControlOrMeta+Home");
  await notes.press("End");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const completing = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/attachment-uploads/*/complete", async (route) => {
    started();
    await blocked;
    await route.continue();
  });
  try {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add image or video", exact: true }).click();
    await (await chooser).setFiles(fixture("recording.mp4"));
    await completing;
    await notes.click();
    await notes.press("ControlOrMeta+Home");
    await notes.pressSequentially("Updated ");
    release();
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).page.description)
      .toMatch(/^Updated Before\.\n\n!\[recording\.mp4\]\(.+ "video\/mp4"\)\n\nAfter\.$/);
    await page.getByRole("button", { name: "View notes", exact: true }).click();
    await expect(page.locator(".notes-field video")).toBeVisible();
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await page.goto(`/?page=${id}`);
    const video = page.locator(".notes-field video");
    await expect(video).toBeVisible();
    await expect(notes).toContainText("Updated Before.");
    await expect(notes).toContainText("After.");
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0.1);
    await video.evaluate((element: HTMLVideoElement) => {
      element.pause();
      element.currentTime = 0.8;
    });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeCloseTo(0.8, 1);
    await page.screenshot({ path: testInfo.outputPath("inline-notes.png") });
    await page.getByRole("button", { name: "Edit notes", exact: true }).click();
    await notes.press("ControlOrMeta+a");
    await notes.press("Backspace");
    await expect(
      notes.getByText("Add only the context someone needs to act...", { exact: true }),
    ).toBeVisible();
    await notes.pressSequentially("Updated Before.");
    await notes.press("Enter");
    await expect(notes.locator(".cm-line")).toHaveCount(2);
    await notes.press("Enter");
    await expect(notes.locator(".cm-line")).toHaveCount(3);
    await notes.pressSequentially("After.");
    await page.getByRole("button", { name: "View notes", exact: true }).click();
    await expect(video).toHaveCount(0);
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).page.description)
      .toBe("Updated Before.\n\nAfter.");
    expect((await (await page.request.get(`/api/pages/${id}/attachments`)).json()).attachments).toHaveLength(
      1,
    );
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Insert recording.mp4 in notes", exact: true }).click();
    await expect(video).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
