import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_NAME,
  GETTING_STARTED_PAGES,
  GETTING_STARTED_SLUG,
} from "../../server/getting-started";
import type { BoardWorkspace } from "../../shared/types";
import { PAGE_STATUSES } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

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
});
