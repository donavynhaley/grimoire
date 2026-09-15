import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers";

test("the page stays interactive during entrance and dismisses once after its short exit", async ({
  page,
}) => {
  await page.goto("/demo");
  const opener = page.getByRole("button", { name: /^Open Make yourself at home/ });
  await opener.click();
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.locator(".page-modal")).toHaveCount(0);

  // CSS pauses from the first frame, independent of animation-event delivery or runner speed.
  // The application stylesheet still supplies the actual duration, distance, and easing.
  await page.addStyleTag({
    content:
      ".page-modal > .modal-backdrop, .page-modal .page-editor { animation-play-state: paused !important; }",
  });
  await opener.click();
  const panel = page.locator(".page-editor");
  await expect.poll(() => panel.evaluate((node) => node.getAnimations()[0]?.playState)).toBe("paused");
  const entrance = await panel.evaluate((node) => {
    const animation = node.getAnimations()[0]!;
    return {
      duration: animation.effect!.getTiming().duration,
      frames: (animation.effect as KeyframeEffect).getKeyframes(),
      sheet: node.classList.contains("drawer-sheet"),
    };
  });
  expect(entrance.duration).toBe(140);
  expect(entrance.frames[0]!.translate).toBe(entrance.sheet ? "0px 10px" : "0px 6px");
  await page.getByLabel("Title", { exact: true }).fill("Written while opening");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Written while opening");
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-modal")).toHaveClass("page-modal closing");
  await expect
    .poll(() => page.locator(".modal-backdrop").evaluate((node) => node.getAnimations()[0]?.playState))
    .toBe("paused");
  expect(
    await page
      .locator(".modal-backdrop")
      .evaluate((node) => node.getAnimations()[0]!.effect!.getTiming().duration),
  ).toBe(90);
  await expect(page.locator(".page-editor")).toHaveAttribute("inert", "");
  // A click during the exit must still land on the backdrop, never on the board beneath.
  expect(
    await page.locator(".project-menu-trigger").evaluate((trigger) => {
      const box = trigger.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return target?.classList.contains("modal-backdrop");
    }),
  ).toBe(true);
  // Repeated Escape cannot schedule another dismissal of a subsequently opened page.
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
  });
  await expect(page.locator(".page-modal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Open Written while opening/ })).toBeFocused();
  await page.getByRole("button", { name: /^Open Written while opening/ }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Written while opening");
  // Closing during the next entrance also works without waiting for it to finish.
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-modal")).toHaveClass("page-modal closing");
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
  });
  await expect(page.locator(".page-modal")).toHaveCount(0);
});

test("reduced motion opens and closes without animation and save failures keep the page open", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const title = `Motion draft ${Date.now()}`;
  const kept = `Kept draft ${Date.now()}`;
  await openBoard(page, [{ title, status: "ready" }]);
  const workspace = await (await page.request.get("/api/board")).json();
  const record = workspace.pages.find((item: { id: string; title: string }) => item.title === title);
  expect(record).toBeTruthy();
  try {
    const opener = page.getByRole("button", { name: new RegExp(`^Open ${title}`) });
    await opener.click();
    await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
    expect(
      await page.locator(".page-modal").evaluate((node) => node.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await page.route("**/api/pages/*", async (route) => {
      if (route.request().method() === "PATCH")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Save unavailable"}',
        });
      else await route.continue();
    });
    await page.getByLabel("Title", { exact: true }).fill(kept);
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await expect(page.getByText("save failed", { exact: true })).toBeVisible();
    await expect(page.locator(".page-editor")).not.toHaveAttribute("inert");
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(kept);
    await page.unrouteAll({ behavior: "wait" });
    const motions: string[] = [];
    await page.exposeFunction("recordExitMotion", (name: string) => motions.push(name));
    await page.evaluate(() => {
      document.addEventListener("animationstart", (event) => {
        if (event.animationName.startsWith("page-modal-")) {
          void (window as unknown as { recordExitMotion: (name: string) => Promise<void> }).recordExitMotion(
            event.animationName,
          );
        }
      });
    });
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await expect(page.locator(".page-modal")).toHaveCount(0);
    expect(motions).toEqual([]);
    await expect(page.getByRole("button", { name: new RegExp(`^Open ${kept}`) })).toBeFocused();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.request.delete(`/api/pages/${record.id}`);
  }
});
