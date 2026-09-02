import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_NAME,
  GETTING_STARTED_PAGES,
  GETTING_STARTED_SLUG,
} from "../../server/getting-started";
import { MarkdownPageStore } from "../../server/markdown-pages";
import type { BoardWorkspace } from "../../shared/types";
import { PAGE_STATUSES } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

describe("the getting started board", () => {
  it("greets a fresh installation with pages that teach the columns they sit in", async () => {
    const server = await startTestServer();
    await bootstrap(server, { keepStarterBoard: true });

    const { body } = await server.request<BoardWorkspace>("/api/board");
    expect(body.project.name).toBe(GETTING_STARTED_NAME);

    // Every starter page arrives, in its column, in the order the seed names them.
    for (const status of PAGE_STATUSES) {
      expect(body.pages.filter((page) => page.status === status).map((page) => page.title)).toEqual(
        GETTING_STARTED_PAGES.filter((page) => page.status === status).map((page) => page.title),
      );
    }
    expect(body.pages).toHaveLength(GETTING_STARTED_PAGES.length);

    // Ordinary pages: seeded through the same door as any other, so each carries its notes,
    // belongs to the person who stood the installation up, and is assigned to nobody.
    for (const seeded of GETTING_STARTED_PAGES) {
      const page = body.pages.find((candidate) => candidate.title === seeded.title)!;
      expect(page.description).toBe(seeded.description);
      expect(page.assigneeId).toBeNull();
    }

    // The page in Done reads as finished work, not as work that lost its timestamp.
    const done = body.pages.find((page) => page.status === "done")!;
    expect(done.completedAt).not.toBeNull();

    // And the record is Markdown on disk, like every page that will follow it.
    const files = readdirSync(join(server.pagesDirectory, GETTING_STARTED_SLUG, "pages"));
    expect(files.filter((name) => name.endsWith(".md"))).toHaveLength(GETTING_STARTED_PAGES.length);
  });

  it("seeds first-run setup alone, so a second project starts empty", async () => {
    const server = await startTestServer();
    await bootstrap(server, { keepStarterBoard: true });

    const created = await server.request<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Familiar Tycoon" }),
    });
    expect(created.response.status).toBe(201);

    const board = await server.request<BoardWorkspace>("/api/board", {
      headers: { "x-grimoire-project": created.body.project.id },
    });
    expect(board.body.pages).toEqual([]);
  });

  it("undoes a seed that fails midway, so setup can simply be tried again", async () => {
    const server = await startTestServer();
    // A file standing where the project directory belongs makes the first page write fail
    // after the project row has already been committed.
    const projectDirectory = join(server.pagesDirectory, GETTING_STARTED_SLUG);
    mkdirSync(server.pagesDirectory, { recursive: true });
    writeFileSync(projectDirectory, "");
    const failed = await server.request("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify(ownerAccount),
    });
    expect(failed.response.status).toBe(500);

    rmSync(projectDirectory);
    const retried = await bootstrap(server, { keepStarterBoard: true });
    expect(retried.response.status).toBe(201);
    const { body } = await server.request<BoardWorkspace>("/api/board");
    expect(body.project.name).toBe(GETTING_STARTED_NAME);
    expect(body.pages).toHaveLength(GETTING_STARTED_PAGES.length);
  });

  it("adopts a pages directory that already holds work instead of teaching over it", async () => {
    const server = await startTestServer();
    // The Markdown files are the canonical record: a database recreated beside an existing
    // directory is a recovery, and the board that comes back is the one on disk.
    const now = new Date().toISOString();
    new MarkdownPageStore(server.pagesDirectory).save(GETTING_STARTED_SLUG, {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Recovered work",
      description: "",
      category: null,
      chapter: null,
      fields: {},
      blockedBy: [],
      unblockedPages: [],
      status: "in_progress",
      position: 0,
      assignee: null,
      createdBy: ownerAccount.email,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
      github: null,
      estimate: null,
    });

    await bootstrap(server, { keepStarterBoard: true });
    const { body } = await server.request<BoardWorkspace>("/api/board");
    expect(body.pages.map((page) => page.title)).toEqual(["Recovered work"]);
  });
});
