import { expect, test } from "@playwright/test";

test("loads features on demand and retries a failed notes download without losing the title", async ({
  page,
}) => {
  const assets: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".js")) assets.push(request.url());
  });
  await page.goto("/");
  // Production cookies are Secure; use the browser's trusted loopback origin for setup too.
  await page.evaluate(async () => {
    const data = {
      name: "Production Reader",
      email: "production@example.com",
      password: "correct-horse-battery",
    };
    const post = (path: string, body: object) =>
      fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const bootstrap = await post("/api/auth/bootstrap", data);
    const login =
      bootstrap.status === 409
        ? await post("/api/auth/login", { email: data.email, password: data.password })
        : bootstrap;
    if (!login.ok) throw new Error("Could not sign in");
    const created = await post("/api/pages", { title: "Keep my draft during download", status: "ready" });
    if (!created.ok) throw new Error("Could not seed page");
  });
  await page.reload();
  await expect(page.getByLabel("Capture work page")).toBeVisible();
  expect(
    assets.some((url) => /MarkdownEditor-|ProjectSettingsDialog-|AccountDialog-|PageDialog-/.test(url)),
  ).toBe(false);
  let blocked = false;
  await page.route("**/assets/MarkdownEditor-*.js", async (route) => {
    if (!blocked) {
      blocked = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: /^Open Keep my draft during download/ })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText("Could not load notes editor");
  await expect(page.getByRole("button", { name: "Add an image" })).toBeDisabled();
  await page.getByLabel("Title", { exact: true }).fill("A title retained through retry");
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toBeFocused();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("A title retained through retry");
  await expect(page.getByRole("button", { name: "Add an image" })).toBeEnabled();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await page.locator(".project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Project settings" }).click();
  await expect(page.getByRole("dialog", { name: "Project settings", exact: true })).toBeVisible();
  expect(assets.some((url) => /ProjectSettingsDialog-/.test(url))).toBe(true);
});
