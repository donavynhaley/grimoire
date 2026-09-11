import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Idea, Page, ProjectSummary } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

const shells: string[] = [];
afterEach(() => {
  for (const directory of shells.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startShellServer() {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-shell-"));
  shells.push(directory);
  const staticDirectory = join(directory, "dist");
  mkdirSync(staticDirectory);
  copyFileSync(resolve("index.html"), join(staticDirectory, "index.html"));
  const server = await startTestServer(undefined, { staticDirectory });
  await bootstrap(server);
  return server;
}

type TestServer = Awaited<ReturnType<typeof startShellServer>>;

/** A chat client unfurls the link without the sharer's session. */
async function unfurl(server: TestServer, path: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.text();
}

async function createProject(server: TestServer, name: string, description: string) {
  const created = await server.request<{ project: ProjectSummary }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(created.response.status).toBe(201);
  const project = created.body.project;
  const updated = await server.request(`/api/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
  expect(updated.response.status).toBe(200);
  return project;
}

describe("link previews", () => {
  it("describes the requested project to an anonymous chat client", async () => {
    const server = await startShellServer();
    const project = await createProject(server, "Familiar Tycoon", "Build a shop for magical companions.");
    const html = await unfurl(server, `/?project=${project.id}&people=me&chapter=launch`);
    expect(html).toContain('<meta property="og:title" content="Familiar Tycoon" />');
    expect(html).toContain(
      '<meta property="og:description" content="Build a shop for magical companions." />',
    );
    expect(html).toContain('<meta name="description" content="Build a shop for magical companions." />');
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain("<title>Familiar Tycoon · Grimoire</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(html).not.toContain("Getting started");

    const changed = await server.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "A freshly updated description." }),
    });
    expect(changed.response.status).toBe(200);
    expect(await unfurl(server, `/?project=${project.id}`)).toContain("A freshly updated description.");
  });

  it("keeps page, legacy card and idea links generic in every lifecycle state", async () => {
    const server = await startShellServer();
    const project = await createProject(server, "Secret project name", "Secret project description");
    const headers = { "x-grimoire-project": project.id };
    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Secret page title",
        description: "Secret page notes",
        status: "in_progress",
      }),
    });
    expect(page.response.status).toBe(201);
    const idea = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Secret idea title",
        description: "Secret idea notes",
        state: "shortlist",
      }),
    });
    expect(idea.response.status).toBe(201);
    const generic = await unfurl(server, "/");
    const links = [
      `page=${page.body.page.id}`,
      `card=${page.body.page.id}`,
      `view=ideas&idea=${idea.body.idea.id}`,
    ];
    for (const archived of [false, true]) {
      if (archived) {
        expect(
          (await server.request(`/api/pages/${page.body.page.id}`, { method: "DELETE", headers })).response
            .status,
        ).toBe(200);
        expect(
          (await server.request(`/api/ideas/${idea.body.idea.id}/promote`, { method: "POST", headers }))
            .response.status,
        ).toBe(201);
      }
      for (const link of links) {
        for (const query of [link, `project=${project.id}&${link}`]) {
          const path = `/?${query}`;
          expect(await unfurl(server, path)).toBe(generic);
          // A logged-in user's shell must not disclose metadata either.
          expect(await (await server.fetchRaw(path)).text()).toBe(generic);
        }
      }
    }
  });

  it("does not fall back to project details when an entity parameter is empty or invalid", async () => {
    const server = await startShellServer();
    const project = await createProject(server, "Private context", "Must not appear for entity links");
    const generic = await unfurl(server, "/");
    for (const key of ["page", "card", "idea"]) {
      for (const value of ["", "../../etc/passwd", "00000000-0000-4000-8000-000000000099"]) {
        expect(await unfurl(server, `/?project=${project.id}&${key}=${value}`)).toBe(generic);
      }
    }
  });

  it("escapes project names and descriptions as text rather than executable markup", async () => {
    const server = await startShellServer();
    const project = await createProject(
      server,
      '<script>alert("hi")</script> & more',
      '"><img src=x onerror=alert(1)> & details',
    );
    const html = await unfurl(server, `/?project=${project.id}`);
    expect(html).toContain('content="&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; more"');
    expect(html).toContain('content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; details"');
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("uses a generic description when a project has no description", async () => {
    const server = await startShellServer();
    const project = await createProject(server, "Empty description", "");
    const html = await unfurl(server, `/?project=${project.id}`);
    expect(html).toContain('<meta property="og:title" content="Empty description" />');
    expect(html).toContain(
      'content="Grimoire is a focused collaborative kanban board for small product teams."',
    );
  });

  it("keeps missing, malformed and archived projects indistinguishable from the generic shell", async () => {
    const server = await startShellServer();
    const project = await createProject(server, "Archived project", "No longer shared");
    expect((await server.request(`/api/projects/${project.id}`, { method: "DELETE" })).response.status).toBe(
      200,
    );
    const generic = await unfurl(server, "/");
    for (const id of [project.id, "", "../../etc/passwd", "00000000-0000-4000-8000-000000000099"]) {
      expect(await unfurl(server, `/?project=${id}`)).toBe(generic);
    }
  });
});
