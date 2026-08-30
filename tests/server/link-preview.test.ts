import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Idea, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

/** The shipped shell, so a preview that loses its markers fails here first. */
function shellDirectory(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "grimoire-shell-")), "dist");
  mkdirSync(directory, { recursive: true });
  copyFileSync(resolve("index.html"), join(directory, "index.html"));
  return directory;
}

async function startShellServer() {
  return startTestServer(undefined, { staticDirectory: shellDirectory() });
}

/** A chat client unfurls the link without the sharer's session. */
async function unfurl(server: Awaited<ReturnType<typeof startTestServer>>, path: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}${path}`);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return response.text();
}

describe("link previews", () => {
  it("describes a shared page without revealing its notes", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const owner = (await server.request<{ projects: Array<{ id: string }> }>("/api/projects")).body;
    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({
        title: "Make the tower door remember Maren",
        description: "The door should greet her by name on the second visit.",
        category: "narrative",
        status: "in_progress",
      }),
    });
    expect(owner.projects).toHaveLength(1);

    const html = await unfurl(server, `/?page=${page.body.page.id}`);

    expect(html).toContain('<meta property="og:title" content="Make the tower door remember Maren" />');
    expect(html).toContain('<meta property="og:site_name" content="Grimoire · Wizard Simulator" />');
    expect(html).toContain('<meta property="og:description" content="In progress · Narrative" />');
    expect(html).toContain('<meta name="theme-color" content="#a99bdc" />');
    expect(html).toContain("<title>Make the tower door remember Maren · Grimoire</title>");
    expect(html).not.toContain("greet her by name");
    expect(html).not.toContain("focused collaborative kanban board");
  });

  it("names the chapter a page belongs to", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const board = (await server.request<{ project: { id: string } }>("/api/board")).body;
    await server.request(`/api/projects/${board.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ chaptersEnabled: true }),
    });
    await server.request("/api/chapters", {
      method: "POST",
      body: JSON.stringify({ name: "First Brew", state: "open" }),
    });
    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({
        title: "Model the potion workbench",
        category: "modeling",
        chapter: "first-brew",
        status: "in_progress",
      }),
    });

    const html = await unfurl(server, `/?page=${page.body.page.id}`);

    // Enough to recognise the page, which is the same boundary the rest of the preview holds.
    expect(html).toContain(
      '<meta property="og:description" content="In progress · Modeling · First Brew" />',
    );
  });

  it("names the assignee and flags blocked and archived pages", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const me = (await server.request<{ status: string; user: { id: string } }>("/api/session")).body;
    const blocker = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Sculpt the door" }),
    });
    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({
        title: "Rig the door",
        assigneeId: me.user.id,
        blockedBy: [blocker.body.page.id],
      }),
    });

    const html = await unfurl(server, `/?page=${page.body.page.id}`);
    expect(html).toContain('<meta property="og:description" content="Backlog · Blocked · Donavyn" />');

    await server.request(`/api/pages/${page.body.page.id}`, { method: "DELETE" });
    const archived = await unfurl(server, `/?page=${page.body.page.id}`);
    expect(archived).toContain('<meta property="og:description" content="Archived · Blocked · Donavyn" />');
  });

  it("describes a shared idea and follows it once it is promoted", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const idea = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Spells are assembled from drawn runes", state: "shortlist" }),
    });

    const html = await unfurl(server, `/?view=ideas&idea=${idea.body.idea.id}`);
    expect(html).toContain('<meta property="og:title" content="Spells are assembled from drawn runes" />');
    expect(html).toContain('<meta property="og:description" content="Idea garden · Shortlist · Donavyn" />');

    await server.request(`/api/ideas/${idea.body.idea.id}/promote`, { method: "POST" });
    const promoted = await unfurl(server, `/?view=ideas&idea=${idea.body.idea.id}`);
    expect(promoted).toContain(
      '<meta property="og:description" content="Idea garden · Promoted to a page · Donavyn" />',
    );
  });

  it("escapes titles so a page cannot inject markup into the shell", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: '<script>alert("hi")</script> & more' }),
    });

    const html = await unfurl(server, `/?page=${page.body.page.id}`);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain(
      '<meta property="og:title" content="&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; more" />',
    );
  });

  it("keeps the generic preview for the board itself and for links to nothing", async () => {
    const server = await startShellServer();
    await bootstrap(server);

    for (const path of ["/", "/?page=00000000-0000-4000-8000-000000000099", "/?page=../../etc/passwd"]) {
      const html = await unfurl(server, path);
      expect(html).toContain("<title>Grimoire</title>");
      expect(html).toContain("focused collaborative kanban board");
      expect(html).not.toContain("og:title");
    }
  });
});
