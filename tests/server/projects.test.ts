import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page, ProjectCategory, ProjectSummary } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

async function board(server: TestServer, projectId?: string) {
  const headers = projectId ? { "x-grimoire-project": projectId } : undefined;
  return (await server.request<BoardWorkspace>("/api/board", { headers })).body;
}

describe("multiple projects", () => {
  it("lets the owner create, switch, rename, and archive projects", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const created = await server.request<{ project: ProjectSummary }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Familiar Tycoon" }),
    });
    expect(created.response.status).toBe(201);

    const projects = (await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects;
    expect(projects.map((project) => project.name)).toEqual(["Wizard Simulator", "Familiar Tycoon"]);

    const second = await board(server, created.body.project.id);
    expect(second.project.name).toBe("Familiar Tycoon");
    expect(second.pages).toEqual([]);
    expect(second.categories.map((category) => category.slug)).toContain("design");
    expect(second.projects).toHaveLength(2);

    const sketched = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Sketch the shop counter" }),
      headers: { "x-grimoire-project": created.body.project.id },
    });
    expect(sketched.response.status).toBe(201);
    expect((await board(server, created.body.project.id)).pages).toHaveLength(1);
    expect((await board(server)).pages).toHaveLength(0);
    expect(
      readFileSync(
        join(server.pagesDirectory, "familiar-tycoon", "pages", `${sketched.body.page.id}.md`),
        "utf8",
      ),
    ).toContain("title: Sketch the shop counter");

    const renamed = await server.request(`/api/projects/${created.body.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Familiar Emporium" }),
    });
    expect(renamed.response.status).toBe(200);
    expect((await board(server, created.body.project.id)).project.name).toBe("Familiar Emporium");

    const archived = await server.request(`/api/projects/${created.body.project.id}`, { method: "DELETE" });
    expect(archived.response.status).toBe(200);
    expect((await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects).toHaveLength(1);
    const gone = await server.request("/api/board", {
      headers: { "x-grimoire-project": created.body.project.id },
    });
    expect(gone.response.status).toBe(404);
  });

  it("refuses to archive the last project", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const only = (await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects[0];

    const refused = await server.request<{ error: string }>(`/api/projects/${only.id}`, { method: "DELETE" });
    expect(refused.response.status).toBe(409);
    expect(refused.body.error).toContain("last project");
  });

  it("scopes invitations to the project they were created in", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const wizardProjectId = (await board(server)).project.id;
    const created = await server.request<{ project: ProjectSummary }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Familiar Tycoon" }),
    });
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "x-grimoire-project": created.body.project.id },
    });

    // Registering switches the stored session cookie to the new member.
    const registered = await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Maren",
        email: "maren@example.com",
        password: "a long enough password",
        inviteCode: invite.body.code,
      }),
    });
    expect(registered.response.status).toBe(201);

    const memberBoard = await board(server);
    expect(memberBoard.project.id).toBe(created.body.project.id);
    expect(memberBoard.projects).toEqual([expect.objectContaining({ name: "Familiar Tycoon" })]);

    const denied = await server.request("/api/board", {
      headers: { "x-grimoire-project": wizardProjectId },
    });
    expect(denied.response.status).toBe(404);
  });
});

describe("project categories", () => {
  it("lets the owner create, rename, recolor, and delete categories", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const created = await server.request<{ category: ProjectCategory }>("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Playtesting", color: "#d87578" }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.category).toEqual({ slug: "playtesting", name: "Playtesting", color: "#d87578", position: 10 });

    const duplicate = await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Playtesting", color: "#d87578" }),
    });
    expect(duplicate.response.status).toBe(409);

    const page = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Run the first playtest", category: "playtesting" }),
    });
    expect(page.response.status).toBe(201);

    const updated = await server.request<{ category: ProjectCategory }>("/api/categories/playtesting", {
      method: "PATCH",
      body: JSON.stringify({ name: "QA", color: "#9ccc9c" }),
    });
    expect(updated.body.category).toEqual({ slug: "playtesting", name: "QA", color: "#9ccc9c", position: 10 });

    const removed = await server.request("/api/categories/playtesting", { method: "DELETE" });
    expect(removed.response.status).toBe(200);
    const workspace = (await server.request<BoardWorkspace>("/api/board")).body;
    expect(workspace.categories.map((category) => category.slug)).not.toContain("playtesting");
    expect(workspace.pages[0].category).toBeNull();
  });

  it("rejects pages with categories the project does not have", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const rejected = await server.request<{ error: string }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Mystery work", category: "mystery" }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain("category");
  });
});
