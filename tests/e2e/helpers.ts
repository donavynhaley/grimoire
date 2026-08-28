import { expect, type Locator, type Page } from "@playwright/test";

const OWNER = { name: "Maren Voss", email: "maren@example.com", password: "correct-horse-battery" };

/**
 * Signs the browser in as the owner, creating the account if this is the run's first test.
 *
 * The API starts against a wiped directory, so the first arrival bootstraps and everyone
 * after that gets the 409 and logs in instead. Cookies set through `page.request` belong to
 * the page's own context, which is what makes the session real for the app afterwards.
 */
export async function signIn(page: Page): Promise<void> {
  const bootstrap = await page.request.post("/api/auth/bootstrap", { data: OWNER });
  if (!bootstrap.ok() && bootstrap.status() !== 409) {
    throw new Error(`bootstrap failed: ${bootstrap.status()} ${await bootstrap.text()}`);
  }
  if (bootstrap.status() === 409) {
    const login = await page.request.post("/api/auth/login", {
      data: { email: OWNER.email, password: OWNER.password },
    });
    if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  }
}

/** Puts a page on the board through the API, which is faster and quieter than typing it in. */
export async function seedPage(
  page: Page,
  title: string,
  status: "ready" | "in_progress" | "review" | "backlog",
): Promise<void> {
  const response = await page.request.post("/api/pages", { data: { title, status } });
  if (!response.ok()) throw new Error(`seed failed: ${response.status()} ${await response.text()}`);
}

/** Signs in, seeds any pages the test needs, and lands on a settled board. */
export async function openBoard(
  page: Page,
  pages: Array<{ title: string; status: "ready" | "in_progress" | "review" | "backlog" }> = [],
): Promise<void> {
  await signIn(page);
  for (const item of pages) await seedPage(page, item.title, item.status);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Up Next" })).toBeVisible();
}

/**
 * One finger, from here to there, as the compositor would report it.
 *
 * Playwright's touchscreen only taps, so the drag gestures go through the DevTools protocol,
 * which synthesizes the same touch stream a physical screen produces - including the pointer
 * events the drag layer actually listens to. `holdMs` is the stillness before moving, which
 * is what separates a lift from a scroll.
 */
export async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { holdMs = 0, steps = 12 }: { holdMs?: number; steps?: number } = {},
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    if (holdMs > 0) await page.waitForTimeout(holdMs);
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/**
 * The centre of an element, in viewport coordinates, once the element has stopped moving.
 *
 * A raw gesture is aimed at numbers, not at elements, so anything still travelling - a sheet
 * mid-rise, a card mid-glide - would be measured where it was rather than where it will be.
 * Waiting out its animations first is what a locator-based action would have done implicitly.
 */
export async function centerOf(target: Locator, moving: Locator = target): Promise<{ x: number; y: number }> {
  // `moving` is whichever ancestor actually carries the animation - a grabber holds still
  // inside a sheet that is still rising.
  await moving.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
  const box = await target.boundingBox();
  if (!box) throw new Error("no box for gesture target");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
