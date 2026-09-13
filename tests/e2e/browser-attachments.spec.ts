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
  await expect(dialog.getByRole("link", { name: "Download recording.mp4" })).toBeVisible();
  await dialog.getByRole("button", { name: "Retry image.png", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".page-attachment")).toHaveCount(2);
  const video = dialog.locator("video");
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toBe(
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
  await expect(page.locator(".page-attachment")).toHaveCount(2);
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
  await expect(page.locator(".page-attachment")).toHaveCount(2);
  expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toBe(
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
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Written while uploading.");
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
    await expect(page.locator(".page-attachment")).toHaveCount(2);
    expect((await (await page.request.get(`/api/pages/${id}`)).json()).page.description).toBe(
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
