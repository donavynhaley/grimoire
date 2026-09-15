import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AttachmentUpload } from "../../shared/attachments";
import { signIn } from "./helpers";

test("agent evidence renders privately with video playback, seeking, and downloads", async ({
  page,
  playwright,
}, testInfo) => {
  await signIn(page);
  const created = await page.request.post("/api/pages", {
    data: {
      title: `Evidence ${testInfo.project.name}`,
      description: "The original brief stays here.",
      status: "ready",
    },
  });
  const { page: work } = await created.json();
  const issued = await page.request.post("/api/agent-tokens", {
    data: { name: "E2E evidence", scope: "write" },
  });
  const { secret } = await issued.json();
  const agent = await playwright.request.newContext({
    baseURL: testInfo.project.use.baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
  try {
    await page.goto(`/?page=${work.id}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Files", exact: true }).click();
    await expect(dialog.getByText("No attachments yet.")).toBeVisible();
    for (const [filename, mediaType] of [
      ["image.png", "image/png"],
      ["recording.mp4", "video/mp4"],
    ]) {
      const bytes = readFileSync(new URL(`../fixtures/attachments/${filename}`, import.meta.url));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const begin = await agent.post(`/api/pages/${work.id}/attachments/uploads`, {
        data: { filename, mediaType, size: bytes.length, sha256, key: sha256 },
      });
      expect(begin.ok(), await begin.text()).toBe(true);
      const upload = (await begin.json()) as AttachmentUpload;
      expect(
        (
          await agent.post(`/api/attachment-uploads/${upload.id}/chunks`, {
            data: { offset: 0, data: bytes.toString("base64") },
          })
        ).ok(),
      ).toBe(true);
      const complete = await agent.post(`/api/attachment-uploads/${upload.id}/complete`, { data: {} });
      expect(complete.ok(), await complete.text()).toBe(true);
      await expect(dialog.getByRole("link", { name: `Download ${filename}` })).toBeVisible();
    }
    const image = dialog.getByRole("img", { name: "image.png" });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320);
    const video = dialog.locator("video");
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((element: HTMLVideoElement) => element.duration)).toBeCloseTo(4, 1);
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0.2);
    await video.evaluate((element: HTMLVideoElement) => {
      element.pause();
      element.currentTime = 2.5;
    });
    await expect
      .poll(() =>
        video.evaluate(
          (element: HTMLVideoElement) => !element.seeking && Math.abs(element.currentTime - 2.5) < 0.1,
        ),
      )
      .toBe(true);
    expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("link", { name: "Download recording.mp4" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("recording.mp4");
    const path = await download.path();
    expect(readFileSync(path!)).toEqual(
      readFileSync(new URL("../fixtures/attachments/recording.mp4", import.meta.url)),
    );
    for (const card of await dialog.locator(".page-attachment").all()) {
      const box = await card.evaluate((element) => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
      }));
      expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
    }
    const sizes = await dialog.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.height + 1);
    await expect(page.locator(".error-banner")).toHaveCount(0);
    expect((await (await agent.get(`/api/pages/${work.id}`)).json()).page.description).toBe(
      "The original brief stays here.",
    );
    await page.screenshot({ path: testInfo.outputPath("attachments.png") });
  } finally {
    await agent.dispose();
  }
});
