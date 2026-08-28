import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Chapter, ChapterRecap, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

/** A Discord that keeps what it was sent, so a test can read the recap as posted. */
function fakeDiscord(failing = false) {
  const posts: Array<{ url: string; content: string }> = [];
  const poster = async (url: string, content: string) => {
    posts.push({ url, content });
    return failing ? { ok: false, status: 500 } : { ok: true, status: 204 };
  };
  return { poster, posts, all: () => posts.map((post) => post.content).join("\n") };
}

async function board(server: TestServer): Promise<BoardWorkspace> {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

async function setUp(server: TestServer, options: { webhook?: string; onClose?: boolean } = {}) {
  const projectId = (await board(server)).project.id;
  await server.request(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      chaptersEnabled: true,
      estimatesEnabled: true,
      discordWebhook: options.webhook ?? "https://discord.test/hook",
      ...(options.onClose === undefined ? {} : { recapOnClose: options.onClose }),
    }),
  });
  return projectId;
}

async function chapter(server: TestServer, name: string, state: Chapter["state"] = "planned") {
  const { body } = await server.request<{ chapter: Chapter }>("/api/chapters", {
    method: "POST",
    body: JSON.stringify({ name, state }),
  });
  return body.chapter;
}

async function page(server: TestServer, input: Record<string, unknown>) {
  const { body } = await server.request<{ page: Page }>("/api/pages", { method: "POST", body: JSON.stringify(input) });
  return body.page;
}

async function finish(server: TestServer, id: string) {
  return server.request(`/api/pages/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
}

async function close(server: TestServer, slug: string, rollover = "keep") {
  return server.request(`/api/chapters/${slug}/close`, { method: "POST", body: JSON.stringify({ rollover }) });
}

/** Waits for the post that closing fires after it has already answered. */
async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe("the recap a closing chapter posts", () => {
  it("posts itself when a chapter closes, with what it delivered and carried", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server);
    const open = await chapter(server, "Sprint One", "open");
    await chapter(server, "Sprint Two");

    const me = (await board(server)).currentUser.id;
    const done = await page(server, { title: "Shipped the circle", chapter: open.slug, estimate: 5, assigneeId: me });
    await finish(server, done.id);
    await page(server, { title: "Still going", chapter: open.slug, estimate: 3, status: "in_progress" });

    await close(server, open.slug, "next");
    await settled();

    const text = discord.all();
    expect(discord.posts[0]!.url).toBe("https://discord.test/hook");
    expect(text).toContain("Sprint One");
    expect(text).toContain("**Delivered:** 1 page");
    expect(text).toContain("**Velocity:** 5 pts");
    expect(text).toContain("**Carried:** 1 page (3 pts) into sprint-two");
    // The person who did it is named, with what they shipped.
    expect(text).toContain("Shipped the circle");
  });

  it("stays quiet when the project has not asked for it, or has nowhere to post", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server, { onClose: false });
    const first = await chapter(server, "Sprint One", "open");
    await close(server, first.slug);
    await settled();
    expect(discord.posts).toHaveLength(0);

    // And with the automation back on but no webhook, closing still says nothing.
    const projectId = (await board(server)).project.id;
    await server.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ recapOnClose: true, discordWebhook: "" }),
    });
    const second = await chapter(server, "Sprint Two", "open");
    await close(server, second.slug);
    await settled();
    expect(discord.posts).toHaveLength(0);
  });

  it("closes the chapter even when Discord refuses the post", async () => {
    const discord = fakeDiscord(true);
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server);
    const open = await chapter(server, "Sprint One", "open");

    const { response } = await close(server, open.slug);
    await settled();
    // The close answered normally; the failed post is Discord's problem, not the board's.
    expect(response.status).toBe(200);
    expect(discord.posts.length).toBeGreaterThan(0);
    expect((await board(server)).chapters.find((c) => c.slug === open.slug)!.state).toBe("closed");
  });

  it("compares against what earlier chapters delivered, once there is one to compare with", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server);

    // A first chapter has nothing to be measured against.
    const first = await chapter(server, "Sprint One", "open");
    const one = await page(server, { title: "One", chapter: first.slug, estimate: 2 });
    await finish(server, one.id);
    await close(server, first.slug);
    await settled();
    expect(discord.all()).not.toContain("avg");

    // The second is measured against the first.
    const second = await chapter(server, "Sprint Two", "open");
    for (const estimate of [4, 4]) {
      const made = await page(server, { title: `Work ${estimate}`, chapter: second.slug, estimate });
      await finish(server, made.id);
    }
    await close(server, second.slug);
    await settled();
    const latest = discord.posts.map((post) => post.content).join("\n");
    expect(latest).toContain("avg 1 pages");
    expect(latest).toContain("↑ +1");
  });

  it("serves the same facts it posts, for something else to narrate", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server);
    const open = await chapter(server, "Sprint One", "open");
    const me = (await board(server)).currentUser.id;
    const done = await page(server, { title: "Shipped it", chapter: open.slug, estimate: 8, assigneeId: me });
    await finish(server, done.id);
    await close(server, open.slug);

    const { body } = await server.request<{ recap: ChapterRecap }>(`/api/chapters/${open.slug}/recap`);
    expect(body.recap.delivered).toBe(1);
    expect(body.recap.deliveredEstimate).toBe(8);
    expect(body.recap.chapter.name).toBe("Sprint One");
    expect(body.recap.byPerson[0]).toMatchObject({ shipped: 1, shippedEstimate: 8 });
    expect(body.recap.byPerson[0]!.titles).toContain("Shipped it");
    expect(body.recap.project.total).toBeGreaterThan(0);
  });

  it("can be posted by hand, and refuses when there is nowhere to post it", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server, { onClose: false });
    const open = await chapter(server, "Sprint One", "open");

    const { body } = await server.request<{ sent: number; failed: number }>(
      `/api/chapters/${open.slug}/recap`, { method: "POST", body: "{}" },
    );
    expect(body.sent).toBeGreaterThan(0);

    const projectId = (await board(server)).project.id;
    await server.request(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ discordWebhook: "" }) });
    const refused = await server.fetchRaw(`/api/chapters/${open.slug}/recap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: server.cookie() },
      body: "{}",
    });
    expect(refused.status).toBe(400);
  });

  it("keeps the webhook on the server and out of every payload", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server, { webhook: "https://discord.test/very-secret" });

    const workspace = await board(server);
    expect(workspace.project.discordWebhookSet).toBe(true);
    expect(JSON.stringify(workspace)).not.toContain("very-secret");
  });

  it("splits a recap too long for one Discord message rather than cutting it off", async () => {
    const discord = fakeDiscord();
    const server = await startTestServer(undefined, { discordPoster: discord.poster });
    await bootstrap(server);
    await setUp(server);
    const open = await chapter(server, "Sprint One", "open");

    for (let index = 0; index < 40; index += 1) {
      const made = await page(server, {
        title: `A page with a deliberately long title so the recap outgrows one message ${index}`,
        chapter: open.slug,
        estimate: 1,
      });
      await finish(server, made.id);
    }
    await close(server, open.slug);
    await settled();

    expect(discord.posts.length).toBeGreaterThan(1);
    // Every message stands on its own rather than being a truncated half of one.
    for (const post of discord.posts) expect(post.content.length).toBeLessThanOrEqual(2000);
    expect(discord.all()).toContain("**Delivered:** 40 pages");
  });
});
