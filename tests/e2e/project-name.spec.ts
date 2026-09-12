import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

for (const demo of [false, true]) {
  test(`the project stays visible on narrow screens in ${demo ? "the demo" : "a signed-in board"}`, async ({
    page,
  }) => {
    if (!demo) await signIn(page);
    await page.goto(demo ? "/demo" : "/");
    const name = page.locator(".project-menu-name");
    await expect(name).toBeAttached();
    for (const width of [320, 360, 390, 400, 401, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(async () =>
          name.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 50 && rect.height > 10 && getComputedStyle(node).clip === "auto";
          }),
        )
        .toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.locator(".project-menu-trigger").click();
      await expect(page.getByRole("menu", { name: "Projects" })).toBeVisible();
      await page.locator('.project-menu-list [aria-current="true"]').click();
      await expect(page.getByRole("menu", { name: "Projects" })).toHaveCount(0);
    }
  });
}

test("long project names fit beside an agent badge and switch by keyboard or touch", async ({
  page,
  isMobile,
}) => {
  await signIn(page);
  const original = (await (await page.request.get("/api/board")).json()).project;
  const longName = `Northern observatory and its patient astronomers ${isMobile ? "phone" : "desktop"}`;
  const created = await page.request.post("/api/projects", { data: { name: longName } });
  expect(created.ok()).toBe(true);
  const second = (await created.json()).project;
  await page.route("**/api/agent-review", (route) =>
    route.fulfill({
      json: { since: 0, latest: 123, total: 123, events: [], waiting: [] },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?project=${second.id}`);
  await expect(page.locator(".agents-trigger")).toBeVisible();
  for (const width of [320, 360, 390, 400, 401, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const name = page.locator(".project-menu-name");
    await expect(name).toHaveText(longName);
    expect(await name.evaluate((el) => el.clientWidth)).toBeGreaterThan(50);
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const trigger = page.locator(".project-menu-trigger");
    if (isMobile) await trigger.tap();
    else {
      await trigger.focus();
      await page.keyboard.press("Enter");
    }
    const target = page.getByRole("menuitem", { name: original.name, exact: true });
    if (isMobile) await target.tap();
    else {
      await target.focus();
      await page.keyboard.press("Enter");
    }
    await expect(name).toHaveText(original.name);
    await trigger.click();
    await page.getByRole("menuitem", { name: longName, exact: true }).click();
    await expect(name).toHaveText(longName);
  }
});
