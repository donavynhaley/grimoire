import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Chapter, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

async function board(server: TestServer): Promise<BoardWorkspace> {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

/** A project with chapters and estimates both switched on, which is what velocity needs. */
async function project(server: TestServer, options: { estimates?: boolean } = {}) {
  const first = await board(server);
  await server.request(`/api/projects/${first.project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ chaptersEnabled: true, estimatesEnabled: options.estimates ?? true }),
  });
  return first.project.id;
}

async function chapter(server: TestServer, name: string, state: Chapter["state"] = "planned") {
  const { body } = await server.request<{ chapter: Chapter }>("/api/chapters", {
    method: "POST",
    body: JSON.stringify({ name, state }),
  });
  return body.chapter;
}

async function page(server: TestServer, input: Record<string, unknown>) {
  const { body } = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.page;
}

async function close(server: TestServer, slug: string, rollover?: string) {
  return server.request<{ chapter: Chapter; carried: { pages: number; estimate: number; to: string | null } }>(
    `/api/chapters/${slug}/close`,
    { method: "POST", body: JSON.stringify(rollover === undefined ? {} : { rollover }) },
  );
}

describe("closing a chapter over unfinished work", () => {
  it("rolls what is unfinished into the next chapter, and leaves what was finished behind", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const open = await chapter(server, "First Brew", "open");
    const next = await chapter(server, "Second Brew");

    const delivered = await page(server, { title: "Delivered work", chapter: open.slug, estimate: 3 });
    await server.request(`/api/pages/${delivered.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
    const carried = await page(server, { title: "Unfinished work", chapter: open.slug, estimate: 5, status: "in_progress" });

    const { body } = await close(server, open.slug, "next");
    expect(body.carried).toEqual({ pages: 1, estimate: 5, to: next.slug });

    const after = await board(server);
    // The unfinished page moved on; the finished one stayed where it was finished.
    expect(after.pages.find((candidate) => candidate.id === carried.id)!.chapter).toBe(next.slug);
    expect(after.pages.find((candidate) => candidate.id === delivered.id)!.chapter).toBe(open.slug);
    // And the chapter itself remembers what it could not finish.
    const closed = after.chapters.find((candidate) => candidate.slug === open.slug)!;
    expect(closed.state).toBe("closed");
    expect(closed.carriedPages).toBe(1);
    expect(closed.carriedEstimate).toBe(5);
    expect(closed.carriedTo).toBe(next.slug);
  });

  it("leaves the work where it is when asked to, and records that too", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const open = await chapter(server, "First Brew", "open");
    await chapter(server, "Second Brew");
    const staying = await page(server, { title: "Unfinished work", chapter: open.slug, estimate: 2, status: "ready" });

    const { body } = await close(server, open.slug, "keep");
    expect(body.carried).toEqual({ pages: 1, estimate: 2, to: null });

    const after = await board(server);
    expect(after.pages.find((candidate) => candidate.id === staying.id)!.chapter).toBe(open.slug);
    expect(after.chapters.find((candidate) => candidate.slug === open.slug)!.carriedPages).toBe(1);
  });

  it("sets the work loose when released, and can send it somewhere named", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const first = await chapter(server, "First Brew", "open");
    const third = await chapter(server, "Third Brew");
    await chapter(server, "Second Brew");
    const loose = await page(server, { title: "Released work", chapter: first.slug, status: "ready" });

    await close(server, first.slug, "release");
    expect((await board(server)).pages.find((candidate) => candidate.id === loose.id)!.chapter).toBeNull();

    // And a named chapter is taken exactly as named, not as "the next one".
    const second = await chapter(server, "Fourth Brew", "open");
    const aimed = await page(server, { title: "Aimed work", chapter: second.slug, status: "ready" });
    await close(server, second.slug, third.slug);
    expect((await board(server)).pages.find((candidate) => candidate.id === aimed.id)!.chapter).toBe(third.slug);
  });

  it("refuses to roll onward when there is nowhere planned to roll to", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const only = await chapter(server, "Only Brew", "open");
    await page(server, { title: "Unfinished work", chapter: only.slug, status: "ready" });

    const { response } = await close(server, only.slug, "next");
    expect(response.status).toBe(400);
    // Refusing left the chapter open rather than half-closing it.
    expect((await board(server)).chapters.find((candidate) => candidate.slug === only.slug)!.state).toBe("open");
  });

  it("refuses to close a chapter twice", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const open = await chapter(server, "First Brew", "open");
    await close(server, open.slug, "keep");
    const { response } = await close(server, open.slug, "keep");
    expect(response.status).toBe(409);
  });

  it("says in the log what closed and what it carried", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const open = await chapter(server, "First Brew", "open");
    const next = await chapter(server, "Second Brew");
    await page(server, { title: "Unfinished work", chapter: open.slug, estimate: 8, status: "ready" });
    await close(server, open.slug, "next");

    const { body } = await server.request<{ events: Array<{ entityType: string; changes: Array<{ field: string; to: string | null }> }> }>(
      "/api/activity?limit=10",
    );
    const closing = body.events.find((event) => event.entityType === "chapter");
    expect(closing?.changes).toContainEqual(expect.objectContaining({ field: "state", to: "closed" }));
    expect(closing?.changes).toContainEqual(
      expect.objectContaining({ field: "carried over", to: `1 page (8) to ${next.slug}` }),
    );
  });
});

describe("velocity", () => {
  it("counts what each chapter delivered, and what it still holds", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const open = await chapter(server, "First Brew", "open");

    const done = await page(server, { title: "Finished", chapter: open.slug, estimate: 3 });
    await server.request(`/api/pages/${done.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
    await page(server, { title: "Still going", chapter: open.slug, estimate: 5, status: "in_progress" });
    // A page nobody estimated is counted as unestimated rather than as nothing.
    await page(server, { title: "Unestimated", chapter: open.slug, status: "ready" });

    const velocity = (await board(server)).velocity.find((entry) => entry.slug === open.slug)!;
    expect(velocity).toEqual({
      slug: open.slug,
      donePages: 1,
      doneEstimate: 3,
      openPages: 2,
      openEstimate: 5,
      unestimatedPages: 1,
    });
  });

  it("credits a rolled-over page to whichever chapter it was finished in", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const first = await chapter(server, "First Brew", "open");
    const second = await chapter(server, "Second Brew");
    const carried = await page(server, { title: "Carried work", chapter: first.slug, estimate: 5, status: "in_progress" });

    await close(server, first.slug, "next");
    await server.request(`/api/pages/${carried.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });

    const after = await board(server);
    const firstVelocity = after.velocity.find((entry) => entry.slug === first.slug)!;
    const secondVelocity = after.velocity.find((entry) => entry.slug === second.slug)!;
    // The chapter that could not finish it takes no credit for it...
    expect(firstVelocity.doneEstimate).toBe(0);
    expect(after.chapters.find((candidate) => candidate.slug === first.slug)!.carriedEstimate).toBe(5);
    // ...and the one that did, does.
    expect(secondVelocity.doneEstimate).toBe(5);
  });

  it("is empty unless both chapters and estimates are switched on", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const projectId = await project(server, { estimates: false });
    await chapter(server, "First Brew", "open");
    expect((await board(server)).velocity).toEqual([]);

    await server.request(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ estimatesEnabled: true }) });
    expect((await board(server)).velocity).toHaveLength(1);

    await server.request(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ chaptersEnabled: false }) });
    expect((await board(server)).velocity).toEqual([]);
  });
});

describe("estimates", () => {
  it("keeps the estimate in the page's own file, and clears it with null", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const made = await page(server, { title: "Some work", estimate: 8 });
    expect(made.estimate).toBe(8);

    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const directory = join(server.pagesDirectory, "wizard-simulator", "pages");
    const contents = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("\n");
    expect(contents).toContain("estimate: 8");

    const { body } = await server.request<{ page: Page }>(`/api/pages/${made.id}`, {
      method: "PATCH",
      body: JSON.stringify({ estimate: null }),
    });
    expect(body.page.estimate).toBeNull();
  });

  it("refuses an estimate that is not a number it can add up", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await project(server);
    const made = await page(server, { title: "Some work" });

    const refused = await server.fetchRaw(`/api/pages/${made.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: server.cookie() },
      body: JSON.stringify({ estimate: -1 }),
    });
    expect(refused.status).toBe(400);
  });
});
