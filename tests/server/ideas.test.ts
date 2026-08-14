import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page, Idea, IdeaWorkspace } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

async function ideas(server: Awaited<ReturnType<typeof startTestServer>>) {
  return (await server.request<IdeaWorkspace>("/api/ideas")).body;
}

describe("idea garden", () => {
  it("captures ideas as Markdown outside the work backlog", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const created = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({
        title: "Let familiars learn recurring player habits",
        description: "Keep the behavior surprising but readable.",
      }),
    });

    expect(created.response.status).toBe(201);
    expect(created.body.idea).toMatchObject({ state: "inbox", position: 0, createdByName: "Donavyn" });
    expect((await ideas(server)).ideas).toEqual([expect.objectContaining({ title: created.body.idea.title })]);
    const workspace = (await server.request<BoardWorkspace>("/api/board")).body;
    expect(workspace.pages).toEqual([]);

    const path = join(
      server.pagesDirectory,
      "wizard-simulator",
      "ideas",
      `${created.body.idea.id}.md`,
    );
    expect(readFileSync(path, "utf8")).toContain("state: inbox");
    expect(readFileSync(path, "utf8")).toContain("Keep the behavior surprising but readable.");
  });

  it("triages and manually ranks the shortlist", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const first = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "First idea" }),
    });
    const second = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Second idea" }),
    });

    await server.request(`/api/ideas/${first.body.idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "shortlist", position: 0 }),
    });
    await server.request(`/api/ideas/${second.body.idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "shortlist", position: 0 }),
    });

    const shortlist = (await ideas(server)).ideas.filter((idea) => idea.state === "shortlist");
    expect(shortlist.map((idea) => idea.title)).toEqual(["Second idea", "First idea"]);
    expect(shortlist.map((idea) => idea.position)).toEqual([0, 1]);

    const parked = await server.request<{ idea: Idea }>(`/api/ideas/${first.body.idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "parked" }),
    });
    expect(parked.body.idea.state).toBe("parked");
  });

  it("promotes an idea into one backlog page and archives the source idea", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const created = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Draw runes in sequence", description: "The sequence forms a spell." }),
    });

    const promoted = await server.request<{ page: Page }>(`/api/ideas/${created.body.idea.id}/promote`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(promoted.response.status).toBe(201);
    expect(promoted.body.page).toMatchObject({
      title: "Draw runes in sequence",
      description: "The sequence forms a spell.",
      status: "backlog",
    });
    expect((await ideas(server)).ideas).toEqual([]);
    const board = (await server.request<BoardWorkspace>("/api/board")).body;
    expect(board.pages).toEqual([expect.objectContaining({ id: promoted.body.page.id })]);

    const activePath = join(
      server.pagesDirectory,
      "wizard-simulator",
      "ideas",
      `${created.body.idea.id}.md`,
    );
    const archivedPath = join(
      server.pagesDirectory,
      "wizard-simulator",
      "ideas",
      "archive",
      `${created.body.idea.id}.md`,
    );
    expect(existsSync(activePath)).toBe(false);
    expect(readFileSync(archivedPath, "utf8")).toContain(`promoted_to: ${promoted.body.page.id}`);

    const undone = await server.request<{ idea: Idea }>(`/api/ideas/${created.body.idea.id}/promotion`, {
      method: "DELETE",
    });
    expect(undone.response.status).toBe(200);
    expect(undone.body.idea).toMatchObject({ id: created.body.idea.id, title: created.body.idea.title });
    expect((await ideas(server)).ideas).toEqual([expect.objectContaining({ id: created.body.idea.id })]);
    expect((await server.request<BoardWorkspace>("/api/board")).body.pages).toEqual([]);
    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(archivedPath)).toBe(false);
  });
});
