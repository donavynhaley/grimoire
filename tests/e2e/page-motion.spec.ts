import { expect, test } from "@playwright/test";
import { openBoard } from "./helpers";

test("the page grows out of its tile, stays interactive, and dismisses once after its exit", async ({
  page,
}) => {
  await page.goto("/demo");
  const opener = page.getByRole("button", { name: /^Open Make yourself at home/ });
  await opener.click();
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.locator(".page-modal")).toHaveCount(0);

  // Where the tile sits is what the opening has to land on.
  const tile = await opener.evaluate((node) => {
    const box = node.closest("[data-flip-id]")!.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });

  await opener.click();
  const panel = page.locator(".page-editor");
  await expect(panel).toBeVisible();
  const sheet = await panel.evaluate((node) => node.classList.contains("drawer-sheet"));

  if (sheet) {
    // A phone has no tile left on screen to grow from, so the sheet keeps its own rise.
    const rise = await panel.evaluate(
      (node) =>
        node.getAnimations().find((animation) => {
          return "animationName" in animation && animation.animationName === "drawer-rise";
        }) !== undefined,
    );
    expect(rise).toBe(true);
  } else {
    // Held at the first frame, the panel's visible window is exactly the tile it came from.
    const opening = await panel.evaluate((node) => {
      const animations = node.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 0;
      }
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const scale = Number.parseFloat(style.scale) || 1;
      const [top, side] = (style.clipPath.match(/inset\(([^)]*)\)/)?.[1] ?? "")
        .split("round")[0]!
        .trim()
        .split(/\s+/)
        .map(Number.parseFloat);
      return {
        x: box.x + side! * scale,
        y: box.y + top! * scale,
        width: box.width - side! * scale * 2,
        height: box.height - top! * scale * 2,
        // The backdrop veils by colour, never by its own opacity, which would take the panel
        // down with it and show the board through the surface that is covering it.
        backdropOpacity: getComputedStyle(node.closest(".modal-backdrop")!).opacity,
      };
    });
    expect(opening.backdropOpacity).toBe("1");
    expect(Math.abs(opening.x - tile.x)).toBeLessThan(1.5);
    expect(Math.abs(opening.y - tile.y)).toBeLessThan(1.5);
    expect(Math.abs(opening.width - tile.width)).toBeLessThan(1.5);
    expect(Math.abs(opening.height - tile.height)).toBeLessThan(1.5);

    // Finishing hands the panel back to the stylesheet rather than holding the last frame.
    await panel.evaluate((node) => {
      for (const animation of node.getAnimations()) {
        animation.play();
        animation.finish();
      }
    });
    await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).clipPath)).toBe("none");
  }

  await page.getByLabel("Title", { exact: true }).fill("Written while opening");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Written while opening");
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-modal")).toHaveClass(/closing/);
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
  await expect(page.locator(".page-modal")).toHaveClass(/closing/);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
  });
  await expect(page.locator(".page-modal")).toHaveCount(0);
});

// The sheet never lifts and so never falls back: it rises the same way from wherever it was
// opened, because a phone has no tile left on screen either way.
test("a page with no tile to grow from falls back to the plain entrance", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the sheet has one entrance, opened from anywhere");
  await page.goto("/demo");
  // A backlog page is not on the board at all, so there is no tile for the panel to grow out of.
  await page.getByRole("button", { name: /^Open backlog/ }).click();
  const backlog = page.getByRole("dialog");
  await expect(backlog).toBeVisible();
  await backlog.locator("button.library-page-main").first().click();
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(page.locator(".page-modal")).toHaveAttribute("data-plain", "");
  // And it leaves the way it arrived, rather than snapping away with no exit at all. The exit
  // is held from its first frame so the check does not race the 90ms it otherwise takes.
  await page.addStyleTag({
    content: ".page-modal > .modal-backdrop { animation-play-state: paused !important; }",
  });
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page
        .locator(".page-modal > .modal-backdrop")
        .evaluate((node) => node.getAnimations().map((a) => ("animationName" in a ? a.animationName : ""))),
    )
    .toContain("page-modal-fade-out");
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
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await expect(page.locator(".page-modal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^Open ${kept}`) })).toBeFocused();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.request.delete(`/api/pages/${record.id}`);
  }
});
