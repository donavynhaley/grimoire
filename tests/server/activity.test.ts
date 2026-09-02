import { describe, expect, it } from "vitest";
import type { AuditPage, BoardWorkspace, Idea, Page, ProjectSummary } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function board(server: Server): Promise<BoardWorkspace> {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

async function activity(server: Server, query = ""): Promise<AuditPage> {
  return (await server.request<AuditPage>(`/api/activity${query}`)).body;
}

async function createPage(server: Server, title: string, extra: Record<string, unknown> = {}): Promise<Page> {
  const created = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title, ...extra }),
  });
  return created.body.page;
}

describe("project activity", () => {
  it("records the project and owner that first-run setup creates", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const page = await activity(server);

    expect(page.hasMore).toBe(false);
    expect(page.events.map((event) => [event.entityType, event.action])).toEqual([
      ["member", "joined"],
      ["project", "created"],
    ]);
    expect(page.events[1]!.entityTitle).toBe("Getting started");
    expect(page.events[0]!.actorName).toBe("Donavyn");
  });

  it("records where a new page landed", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const owner = (await board(server)).currentUser;

    await createPage(server, "Model the potion workbench", {
      status: "ready",
      category: "modeling",
      assigneeId: owner.id,
    });

    const [event] = (await activity(server)).events;
    expect(event!.action).toBe("created");
    expect(event!.entityType).toBe("page");
    expect(event!.entityTitle).toBe("Model the potion workbench");
    expect(event!.changes).toEqual([
      { field: "column", from: null, to: "Up Next" },
      { field: "category", from: null, to: "Modeling" },
      { field: "assignee", from: null, to: "Donavyn" },
    ]);
  });

  it("separates a column move from an edit and ignores reordering", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const first = await createPage(server, "Sweep the tower", { status: "ready" });
    await createPage(server, "Polish the broom", { status: "ready" });

    await server.request(`/api/pages/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress", position: 0 }),
    });
    await server.request(`/api/pages/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Sweep the whole tower", description: "Every floor." }),
    });
    // A pure reorder inside one column carries no readable change and is not recorded.
    await server.request(`/api/pages/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ position: 0 }),
    });

    const page = await activity(server, `?entity=${first.id}`);
    expect(page.events.map((event) => event.action)).toEqual(["updated", "moved", "created"]);
    expect(page.events[1]!.changes).toEqual([{ field: "column", from: "Up Next", to: "In progress" }]);
    expect(page.events[0]!.changes).toEqual([
      { field: "title", from: "Sweep the tower", to: "Sweep the whole tower" },
      { field: "notes", from: null, to: "Every floor." },
    ]);
  });

  it("names the blockers and categories a page gained or lost", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const blocker = await createPage(server, "Design the ritual table");
    const page = await createPage(server, "Build the ritual table");

    await server.request(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ blockedBy: [blocker.id], category: "code" }),
    });

    const [event] = (await activity(server, `?entity=${page.id}`)).events;
    expect(event!.changes).toEqual([
      { field: "category", from: "uncategorized", to: "Code" },
      { field: "blockers", from: null, to: "Design the ritual table" },
    ]);
  });

  it("keeps the title a page had when it was archived", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Retire the old workbench");

    await server.request(`/api/pages/${page.id}`, { method: "DELETE", body: JSON.stringify({}) });
    await server.request(`/api/pages/${page.id}/restore`, { method: "POST", body: JSON.stringify({}) });

    const history = await activity(server, `?entity=${page.id}`);
    expect(history.events.map((event) => event.action)).toEqual(["restored", "archived", "created"]);
    expect(history.events[1]!.entityTitle).toBe("Retire the old workbench");
  });

  it("records ideas, promotions, categories, and project renames", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const idea = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Familiars learn player habits" }),
    });
    await server.request(`/api/ideas/${idea.body.idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "shortlist" }),
    });
    await server.request(`/api/ideas/${idea.body.idea.id}/promote`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Playtesting", color: "#d87578" }),
    });
    const projectId = (await board(server)).project.id;
    await server.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Wizard Simulator 2" }),
    });

    const page = await activity(server);
    expect(page.events.map((event) => [event.entityType, event.action])).toEqual([
      ["project", "renamed"],
      ["category", "created"],
      ["page", "created"],
      ["idea", "promoted"],
      ["idea", "moved"],
      ["idea", "created"],
      ["member", "joined"],
      ["project", "created"],
    ]);
    expect(page.events[0]!.changes).toEqual([
      { field: "name", from: "Getting started", to: "Wizard Simulator 2" },
    ]);
    expect(page.events[4]!.changes).toEqual([{ field: "list", from: "Idea inbox", to: "Shortlist" }]);
  });

  it("records who invited, joined, and was removed", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const ownerCookie = server.cookie();
    // Registering switches the stored session cookie to the new member.
    await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Maren",
        email: "maren@example.com",
        password: "a long enough password",
        inviteCode: invite.body.code,
      }),
    });
    const member = (await board(server)).members.find((value) => value.name === "Maren")!;

    await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com", password: "correct horse wizard tower" }),
    });
    expect(server.cookie()).not.toBe(ownerCookie);
    await server.request(`/api/members/${member.id}`, { method: "DELETE", body: JSON.stringify({}) });

    const page = await activity(server);
    expect(
      page.events.slice(0, 3).map((event) => [event.action, event.actorName, event.entityTitle]),
    ).toEqual([
      ["removed", "Donavyn", "Maren"],
      ["joined", "Maren", "Maren"],
      ["invited", "Donavyn", "invitation link"],
    ]);
  });

  it("keeps each project's history to itself", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const wizardProjectId = (await board(server)).project.id;
    const created = await server.request<{ project: ProjectSummary }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Familiar Tycoon" }),
    });
    await server.request("/api/pages", {
      method: "POST",
      headers: { "x-grimoire-project": created.body.project.id },
      body: JSON.stringify({ title: "Sketch the familiar shop" }),
    });

    const other = (
      await server.request<AuditPage>("/api/activity", {
        headers: { "x-grimoire-project": created.body.project.id },
      })
    ).body;
    const wizard = (
      await server.request<AuditPage>("/api/activity", {
        headers: { "x-grimoire-project": wizardProjectId },
      })
    ).body;

    expect(other.events.map((event) => event.entityTitle)).toEqual([
      "Sketch the familiar shop",
      "Familiar Tycoon",
    ]);
    expect(wizard.events.some((event) => event.entityTitle === "Sketch the familiar shop")).toBe(false);
  });

  it("pages backwards through a long history", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    for (let index = 0; index < 6; index += 1) await createPage(server, `Page ${index}`);

    const first = await activity(server, "?limit=3");
    expect(first.hasMore).toBe(true);
    expect(first.events).toHaveLength(3);

    const second = await activity(server, `?limit=3&before=${first.events[2]!.sequence}`);
    expect(second.events.map((event) => event.entityTitle)).toEqual(["Page 2", "Page 1", "Page 0"]);
    expect(second.hasMore).toBe(true);
  });

  it("requires an authenticated member", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await server.request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });

    const denied = await server.fetchRaw("/api/activity");

    expect(denied.status).toBe(401);
  });
});
