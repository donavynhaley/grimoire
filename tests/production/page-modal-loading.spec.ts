import { expect, test } from "@playwright/test";

for (const scenario of ["retry", "cancel"] as const) {
  test(`a cold page download can ${scenario} without restarting or reopening its modal`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    await page.route("**/assets/PageDialog-*.js*", async (route) => {
      if (!first) return route.continue();
      first = false;
      await gate;
      if (scenario === "retry") await route.abort("failed");
      else await route.continue();
    });
    try {
      await page.goto("/demo");
      // Counting entrances rather than animation events, because the centred panel is measured
      // into place by `use-page-motion` and a measured animation raises no `animationstart`.
      // The shell marks the one window in which it is entering, on every surface, so the mark
      // appearing twice is the modal having restarted around the arriving editor.
      await page.evaluate(() => {
        document.documentElement.dataset.pageEntrances = "0";
        const seen = new WeakSet<Element>();
        const count = (node: Element) => {
          if (seen.has(node)) return;
          seen.add(node);
          document.documentElement.dataset.pageEntrances = String(
            Number(document.documentElement.dataset.pageEntrances) + 1,
          );
        };
        new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target;
            if (
              target instanceof Element &&
              target.matches(".page-modal[data-entering], .page-modal[data-plain]")
            )
              count(target);
            for (const added of record.addedNodes)
              if (added instanceof Element && added.matches?.(".page-modal")) count(added);
          }
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-entering", "data-plain"],
        });
      });
      await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
      await expect(page.getByRole("dialog", { name: "Opening page editor", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-page-entrances", "1");
      const shell = await page.locator(".page-editor").elementHandle();
      await shell!.evaluate((node) =>
        Promise.all(node.getAnimations().map((animation) => animation.finished)),
      );

      if (scenario === "cancel") {
        await page.getByRole("button", { name: "Cancel opening" }).click();
        await expect(page.locator(".page-modal")).toHaveCount(0);
        const downloaded = page.waitForResponse(/\/assets\/PageDialog-.*\.js/);
        release();
        await downloaded;
        await expect(page.locator(".page-modal")).toHaveCount(0);
        await expect(page).not.toHaveURL(/[?&]page=/);
        return;
      }

      release();
      await expect(page.getByRole("alert")).toContainText("Could not load page editor");
      await page.getByRole("button", { name: "Retry loading" }).click();
      await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
      expect(await shell!.evaluate((node) => node === document.querySelector(".page-editor"))).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-page-entrances", "1");
      await expect(page.getByRole("dialog", { name: "Edit page", exact: true })).toBeFocused();
      await page.getByLabel("Title", { exact: true }).fill("Loaded into the same modal");
      await page.getByRole("button", { name: "Close page", exact: true }).click();
      await expect(page.locator(".page-modal")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Open Loaded into the same modal/ })).toBeFocused();
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
