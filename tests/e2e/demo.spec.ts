import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// All demo behavior goes through the real interface, with production HTTP denied at the browser boundary.
test("a visitor can edit, discuss, move, refresh and reset a private playground", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("link", { name: "Try the demo" })).toBeVisible();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.abort(),
  );
  await page.getByRole("link", { name: "Try the demo" }).click();
  await expect(page.getByRole("heading", { name: "The Lantern Workshop" })).toBeVisible();
  await expect(page.getByText("Your playground.", { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth > window.innerWidth ||
      document.documentElement.scrollHeight > window.innerHeight + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `/tmp/grimoire-demo-${isMobile ? "phone" : "desktop"}.png`, fullPage: true });
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("My own playground");
  await page.getByRole("button", { name: "Discussion", exact: true }).click();
  await page.getByRole("combobox", { name: "Start a thread" }).fill("This stays with my demo.");
  await page.getByRole("combobox", { name: "Start a thread" }).press("Enter");
  await expect(page.getByText("This stays with my demo.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Move to Done", exact: true }).click();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit page" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "The Lantern Workshop" })).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Search everything" })
    .getByRole("searchbox")
    .fill("My own playground");
  await expect(
    page.getByRole("dialog", { name: "Search everything" }).getByText("My own playground", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open Make yourself at home/ })).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("an existing owner can try the demo without exposing or changing their real session", async ({
  page,
}) => {
  await signIn(page);
  const before = await page.context().cookies();
  const realBoard = await (await page.request.get("/api/board")).json();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.abort(),
  );
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "The Lantern Workshop" })).toBeVisible();
  await page.getByRole("combobox", { name: "Capture work page" }).fill("Only in my demo");
  await page.getByRole("combobox", { name: "Capture work page" }).press("Enter");
  await expect(page.getByRole("combobox", { name: "Capture work page" })).toHaveValue("");
  expect(requests).toEqual([]);
  expect(await page.context().cookies()).toEqual(before);
  const after = await (await page.request.get("/api/board")).json();
  expect(after).toEqual(realBoard);
  await page.unrouteAll();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page.getByRole("button", { name: /Open account settings for Maren Voss/ })).toBeVisible();
});

test("separate visitors start fresh and malformed saved data recovers", async ({ page, browser }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "The Lantern Workshop" })).toBeVisible();
  await page.getByRole("button", { name: /^Open Make yourself at home/ }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Private experiment");
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit page" })).toBeHidden();
  const other = await browser.newContext();
  try {
    const visitor = await other.newPage();
    await visitor.goto(new URL("/demo", page.url()).href);
    await expect(visitor.getByRole("button", { name: /^Open Make yourself at home/ })).toBeVisible();
    await expect(visitor.getByText("Private experiment", { exact: true })).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.evaluate(() => sessionStorage.setItem("grimoire.demo.v1", "broken"));
  await page.reload();
  await expect(page.getByRole("button", { name: /^Open Make yourself at home/ })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("fresh playground");
});

test("a visitor can use owner settings while external integrations explain their limits", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.abort(),
  );
  await page.goto("/demo");
  await page.getByRole("button", { name: "The Lantern Workshop", exact: true }).click();
  await page.getByRole("menuitem", { name: /Project settings/ }).click();
  const settings = page.getByRole("dialog", { name: "Project settings" });
  await settings.getByRole("button", { name: "Categories", exact: true }).click();
  await settings.getByRole("textbox", { name: "New category name" }).fill("Playground ideas");
  await settings.getByRole("button", { name: "add", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "Rename Playground ideas" })).toBeVisible();
  await settings.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(settings.getByText(/does not contact GitHub/)).toBeVisible();
  await expect(settings.locator("input")).toHaveCount(0);
  await settings.getByRole("button", { name: "Agent access", exact: true }).click();
  await expect(settings.getByText(/cannot issue real credentials/)).toBeVisible();
  await page.reload();
  await expect(settings.getByText(/cannot issue real credentials/)).toBeVisible();
  await settings.getByRole("button", { name: "Categories", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "Rename Playground ideas" })).toBeVisible();
  expect(requests).toEqual([]);
});
