import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseMarkdown } from "../../server/markdown-files";
import type { BoardWorkspace, Chapter, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function board(server: Server): Promise<BoardWorkspace> {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

async function enableChapters(server: Server, enabled = true) {
  const workspace = await board(server);
  return server.request(`/api/projects/${workspace.project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ chaptersEnabled: enabled }),
  });
}

async function createChapter(server: Server, body: Record<string, unknown>) {
  return server.request<{ chapter: Chapter }>("/api/chapters", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function createPage(server: Server, body: Record<string, unknown>) {
  return server.request<{ page: Page }>("/api/pages", { method: "POST", body: JSON.stringify(body) });
}

function chapterFile(server: Server, slug: string): string {
  return join(server.pagesDirectory, "wizard-simulator", "chapters", `${slug}.md`);
}

function pageFiles(server: Server): string[] {
  const directory = join(server.pagesDirectory, "wizard-simulator", "pages");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(directory, name), "utf8"));
}

describe("chapters", () => {
  describe("the per-project gate", () => {
    it("is off until a project asks for it, and refuses every chapter route until then", async () => {
      const server = await startTestServer();
      await bootstrap(server);

      const workspace = await board(server);
      expect(workspace.project.chaptersEnabled).toBe(false);

      const refused = await createChapter(server, { name: "First Brew" });
      expect(refused.response.status).toBe(403);
    });

    it("serves chapters once enabled", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);

      const created = await createChapter(server, { name: "First Brew", state: "open" });
      expect(created.response.status).toBe(201);
      expect(created.body.chapter.slug).toBe("first-brew");

      const workspace = await board(server);
      expect(workspace.project.chaptersEnabled).toBe(true);
      expect(workspace.chapters.map((chapter) => chapter.slug)).toEqual(["first-brew"]);
    });

    it("hides chapters when switched back off without destroying anything", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      const page = await createPage(server, { title: "Brew a potion", chapter: "first-brew" });
      expect(page.response.status).toBe(201);

      await enableChapters(server, false);

      const hidden = await board(server);
      expect(hidden.project.chaptersEnabled).toBe(false);
      expect(hidden.chapters).toEqual([]);
      // The page keeps its chapter and the chapter file stays on disk: turning the gate off
      // is a change of surface, never a deletion.
      expect(hidden.pages[0]!.chapter).toBe("first-brew");
      expect(readFileSync(chapterFile(server, "first-brew"), "utf8")).toContain("slug: first-brew");

      await enableChapters(server, true);
      const restored = await board(server);
      expect(restored.chapters.map((chapter) => chapter.slug)).toEqual(["first-brew"]);
    });

    it("refuses to place a page in a chapter while the gate is off", async () => {
      const server = await startTestServer();
      await bootstrap(server);

      const refused = await createPage(server, { title: "Brew a potion", chapter: "first-brew" });
      expect(refused.response.status).toBe(403);
    });
  });

  describe("the record on disk", () => {
    it("writes a readable file named by its slug", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, {
        name: "First Brew",
        description: "Get one full potion loop playable end to end.",
        startsOn: "2026-08-18",
        endsOn: "2026-09-15",
        state: "open",
      });

      const contents = readFileSync(chapterFile(server, "first-brew"), "utf8");
      expect(contents).toContain("slug: first-brew");
      expect(contents).toContain("name: First Brew");
      expect(contents).toContain("state: open");
      expect(contents).toContain("starts_on: 2026-08-18");
      expect(contents).toContain("ends_on: 2026-09-15");
      expect(contents).toContain("Get one full potion loop playable end to end.");

      // What actually matters is that the day survives the round trip unchanged.
      const reread = (await board(server)).chapters[0];
      expect(reread!.startsOn).toBe("2026-08-18");
      expect(reread!.endsOn).toBe("2026-09-15");
      expect(reread!.description).toContain("Get one full potion loop playable end to end.");
    });

    it("rejects an unknown field, naming the file", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew" });

      const path = chapterFile(server, "first-brew");
      writeFileSync(path, readFileSync(path, "utf8").replace("state:", "velocity: 42\nstate:"));

      const { response } = await server.request("/api/board");
      expect(response.status).toBe(500);
    });

    it("rejects a file whose name does not match its slug", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew" });

      const directory = join(server.pagesDirectory, "wizard-simulator", "chapters");
      writeFileSync(
        join(directory, "second-brew.md"),
        readFileSync(chapterFile(server, "first-brew"), "utf8"),
      );

      const { response } = await server.request("/api/board");
      expect(response.status).toBe(500);
    });

    it("refuses an end date that falls before the start", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);

      const { response } = await createChapter(server, {
        name: "Backwards",
        startsOn: "2026-09-15",
        endsOn: "2026-08-18",
      });
      expect(response.status).toBe(400);
    });

    it("accepts a chapter with no dates at all", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);

      const created = await createChapter(server, { name: "Someday" });
      expect(created.response.status).toBe(201);
      expect(created.body.chapter.startsOn).toBeNull();
      expect(created.body.chapter.endsOn).toBeNull();
    });
  });

  describe("one open chapter at a time", () => {
    it("refuses to open a second while one is already open", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });

      const second = await createChapter(server, { name: "Second Brew", state: "open" });
      expect(second.response.status).toBe(409);

      const planned = await createChapter(server, { name: "Second Brew" });
      expect(planned.response.status).toBe(201);

      const promoted = await server.request(`/api/chapters/second-brew`, {
        method: "PATCH",
        body: JSON.stringify({ state: "open" }),
      });
      expect(promoted.response.status).toBe(409);
    });

    it("allows the next one to open once the current chapter closes", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      await createChapter(server, { name: "Second Brew" });

      await server.request("/api/chapters/first-brew", {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      const opened = await server.request<{ chapter: Chapter }>("/api/chapters/second-brew", {
        method: "PATCH",
        body: JSON.stringify({ state: "open" }),
      });

      expect(opened.response.status).toBe(200);
      expect(opened.body.chapter.state).toBe("open");
    });

    it("places any number of planned chapters without complaint", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);

      for (const name of ["One", "Two", "Three"]) {
        expect((await createChapter(server, { name })).response.status).toBe(201);
      }
      expect((await board(server)).chapters).toHaveLength(3);
    });
  });

  describe("closing", () => {
    it("stamps closedAt, clears it on reopening, and never touches a page", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      await createPage(server, { title: "Unfinished work", chapter: "first-brew", status: "ready" });

      const closed = await server.request<{ chapter: Chapter }>("/api/chapters/first-brew", {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      expect(closed.body.chapter.state).toBe("closed");
      expect(closed.body.chapter.closedAt).not.toBeNull();

      // Closing is a statement about the chapter, not an instruction to the board. The
      // unfinished page stays exactly where it was, which is what makes a closed chapter an
      // honest record of what did and did not land.
      const afterClose = await board(server);
      expect(afterClose.pages[0]!.chapter).toBe("first-brew");
      expect(afterClose.pages[0]!.status).toBe("ready");

      const reopened = await server.request<{ chapter: Chapter }>("/api/chapters/first-brew", {
        method: "PATCH",
        body: JSON.stringify({ state: "open" }),
      });
      expect(reopened.body.chapter.closedAt).toBeNull();
    });
  });

  describe("referential integrity", () => {
    it("refuses a page pointing at a chapter that does not exist", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);

      const { response } = await createPage(server, { title: "Nowhere", chapter: "made-up" });
      expect(response.status).toBe(400);
    });

    it("clears the chapter from its pages when the chapter is deleted", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      await createPage(server, { title: "Brew a potion", chapter: "first-brew" });
      await createPage(server, { title: "Unrelated" });

      const removed = await server.request<{ released: number }>("/api/chapters/first-brew", {
        method: "DELETE",
      });
      expect(removed.response.status).toBe(200);
      expect(removed.body.released).toBe(1);

      const workspace = await board(server);
      expect(workspace.chapters).toEqual([]);
      expect(workspace.pages.every((page) => page.chapter === null)).toBe(true);
    });
  });

  describe("chapter and column are independent", () => {
    it("keeps a page in the Backlog while it belongs to a chapter", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "Second Brew" });

      const created = await createPage(server, {
        title: "Pulled from the backlog",
        chapter: "second-brew",
        status: "backlog",
      });

      // This is the property that lets a chapter be filled without flooding Up Next.
      expect(created.body.page.status).toBe("backlog");
      expect(created.body.page.chapter).toBe("second-brew");
    });

    it("carries the chapter through archive and restore", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      const created = await createPage(server, { title: "Brew a potion", chapter: "first-brew" });
      const pageId = created.body.page.id;

      await server.request(`/api/pages/${pageId}`, { method: "DELETE" });
      const restored = await server.request<{ page: Page }>(`/api/pages/${pageId}/restore`, {
        method: "POST",
      });

      expect(restored.response.status).toBe(200);
      expect(restored.body.page.chapter).toBe("first-brew");
    });
  });

  describe("compatibility with a build that predates chapters", () => {
    it("writes no chapter key at all onto a page that has no chapter", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      await createPage(server, { title: "Placed", chapter: "first-brew" });
      await createPage(server, { title: "Unplaced" });

      const files = pageFiles(server);
      const placed = files.filter((contents) => contents.includes("chapter: first-brew"));
      const unplaced = files.filter((contents) => !contents.includes("chapter:"));

      // An older strict parser rejects any frontmatter key it does not know, and one bad file
      // fails the whole listing. Emitting the key only when it carries a value means a
      // rollback has to answer for the pages someone deliberately placed and nothing else.
      expect(placed).toHaveLength(1);
      expect(unplaced).toHaveLength(1);
    });

    it("keeps reading pages written before the field existed", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const created = await createPage(server, { title: "Older page" });
      const pageId = created.body.page.id;

      const path = join(server.pagesDirectory, "wizard-simulator", "pages", `${pageId}.md`);
      const legacy = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("chapter:"))
        .join("\n");
      writeFileSync(path, legacy);

      const workspace = await board(server);
      expect(workspace.pages[0]!.chapter).toBeNull();
    });
  });

  describe("the activity log", () => {
    it("records moving a page into a chapter by name", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      const created = await createPage(server, { title: "Brew a potion" });

      await server.request(`/api/pages/${created.body.page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ chapter: "first-brew" }),
      });

      const activity = await server.request<{ events: Array<{ changes: Array<Record<string, unknown>> }> }>(
        "/api/activity",
      );
      const change = activity.body.events
        .flatMap((event) => event.changes)
        .find((candidate) => candidate.field === "chapter");
      expect(change).toEqual({ field: "chapter", from: "no chapter", to: "First Brew" });
    });

    it("records opening and closing a chapter", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await enableChapters(server);
      await createChapter(server, { name: "First Brew", state: "open" });
      await server.request("/api/chapters/first-brew", {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });

      const activity = await server.request<{
        events: Array<{ entityType: string; action: string; entityTitle: string }>;
      }>("/api/activity");
      const chapterEvents = activity.body.events.filter((event) => event.entityType === "chapter");

      expect(chapterEvents.map((event) => event.action)).toEqual(["moved", "created"]);
      expect(chapterEvents[0]!.entityTitle).toBe("First Brew");
    });
  });
});

describe("where a chaptered page turns up", () => {
  it("names the chapter beside the column in a search result", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await enableChapters(server);
    await createChapter(server, { name: "First Brew", state: "open" });
    await createPage(server, { title: "Brew a potion", chapter: "first-brew", status: "in_progress" });
    await createPage(server, { title: "Brew nothing", status: "in_progress" });

    const found = await server.request<{ hits: Array<{ title: string; where: string }> }>(
      "/api/search?q=brew",
    );
    const wheres = Object.fromEntries(found.body.hits.map((hit) => [hit.title, hit.where]));

    expect(wheres["Brew a potion"]).toBe("In progress · First Brew");
    // A page in no chapter still reads exactly as it did before.
    expect(wheres["Brew nothing"]).toBe("In progress");
  });

  it("leaves search alone for a project with the gate off", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await enableChapters(server);
    await createChapter(server, { name: "First Brew", state: "open" });
    await createPage(server, { title: "Brew a potion", chapter: "first-brew", status: "in_progress" });
    await enableChapters(server, false);

    const found = await server.request<{ hits: Array<{ where: string }> }>("/api/search?q=brew");
    expect(found.body.hits[0]!.where).toBe("In progress");
  });
});

describe("the rollback script", () => {
  it("makes every page readable again by a build that predates chapters", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await enableChapters(server);
    await createChapter(server, { name: "First Brew", state: "open" });
    await createPage(server, { title: "Placed", chapter: "first-brew" });
    await createPage(server, { title: "Unplaced" });

    // The schema as it stands on the branch this would roll back to: strict, and with no
    // idea what a chapter is.
    const legacySchema = z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        category: z.string().nullable().optional(),
        blocked_by: z.array(z.string()).optional(),
        unblocked_cards: z.array(z.string()).optional(),
        status: z.string(),
        position: z.number(),
        assignee: z.string().nullable(),
        created_by: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        completed_at: z.string().nullable().optional(),
        archived_at: z.string().nullable().optional(),
      })
      .strict();
    const readAll = () => pageFiles(server).map((contents) => parseMarkdown(contents).metadata);

    // Before: the placed page is unreadable, which is what would take the board down.
    expect(readAll().filter((metadata) => !legacySchema.safeParse(metadata).success)).toHaveLength(1);

    execFileSync(process.execPath, [
      join(process.cwd(), "ops", "strip-chapter-frontmatter.mjs"),
      server.pagesDirectory,
      "--apply",
    ]);

    // After: every file parses under the older schema.
    for (const metadata of readAll()) {
      expect(legacySchema.safeParse(metadata).success).toBe(true);
    }

    // The chapter file itself is untouched, so rolling forward again restores the chapter -
    // only which pages were in it is lost.
    expect(readFileSync(chapterFile(server, "first-brew"), "utf8")).toContain("name: First Brew");
  });

  it("writes nothing without --apply", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await enableChapters(server);
    await createChapter(server, { name: "First Brew", state: "open" });
    await createPage(server, { title: "Placed", chapter: "first-brew" });
    const before = pageFiles(server);

    const output = execFileSync(process.execPath, [
      join(process.cwd(), "ops", "strip-chapter-frontmatter.mjs"),
      server.pagesDirectory,
    ]).toString();

    expect(output).toContain("would strip");
    expect(pageFiles(server)).toEqual(before);
  });
});

describe("widening the audit entity types", () => {
  it("preserves every sequence number and the seen cursor across the rebuild", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-audit-rebuild-"));
    directories.push(directory);
    const databasePath = join(directory, "grimoire.sqlite");

    // Build a database the way a release that predates chapters would have left it: the
    // narrow CHECK, real rows, and a member cursor pointing at one of those sequences.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')), created_at TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        pitch TEXT NOT NULL DEFAULT '', player_fantasy TEXT NOT NULL DEFAULT '',
        current_direction TEXT NOT NULL DEFAULT '', direction_detail TEXT NOT NULL DEFAULT '',
        non_goals TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id),
        actor_name TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('page', 'idea', 'project', 'category', 'member')),
        entity_id TEXT,
        entity_title TEXT NOT NULL,
        action TEXT NOT NULL,
        changes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL);
      CREATE TABLE seen_cursors (project_id TEXT NOT NULL, user_id TEXT NOT NULL,
        last_seen_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
    `);
    legacy
      .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
      .run("user-1", "Donavyn", "owner@example.com", "hash", "owner", "2026-08-01T00:00:00.000Z");
    legacy
      .prepare("INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(
        "project-1",
        "Wizard Simulator",
        "wizard-simulator",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
    const insert = legacy.prepare(
      `INSERT INTO audit_events (id, project_id, actor_id, actor_name, entity_type, entity_id, entity_title, action, created_at)
       VALUES (?, 'project-1', 'user-1', 'Donavyn', 'page', ?, ?, 'created', '2026-08-01T00:00:00.000Z')`,
    );
    for (let index = 1; index <= 5; index += 1)
      insert.run(`event-${index}`, `page-${index}`, `Page ${index}`);
    legacy
      .prepare("INSERT INTO seen_cursors VALUES ('project-1', 'user-1', 3, '2026-08-01T00:00:00.000Z')")
      .run();
    const before = legacy.prepare("SELECT sequence, id FROM audit_events ORDER BY sequence").all();
    legacy.close();

    // Opening with the current build runs the rebuild.
    const { openDatabase } = await import("../../server/database");
    const migrated = openDatabase(databasePath);

    const after = migrated.prepare("SELECT sequence, id FROM audit_events ORDER BY sequence").all();
    expect(after).toEqual(before);

    const cursor = migrated
      .prepare("SELECT last_seen_sequence FROM seen_cursors WHERE user_id = 'user-1'")
      .get() as { last_seen_sequence: number };
    expect(Number(cursor.last_seen_sequence)).toBe(3);

    // The high-water mark survives, so the next event cannot reuse a sequence a reader has
    // already been marked as having seen.
    migrated
      .prepare(
        `INSERT INTO audit_events (id, project_id, actor_id, actor_name, entity_type, entity_id, entity_title, action, created_at)
         VALUES ('event-next', 'project-1', 'user-1', 'Donavyn', 'chapter', 'first-brew', 'First Brew', 'created', '2026-08-02T00:00:00.000Z')`,
      )
      .run();
    const next = migrated.prepare("SELECT MAX(sequence) AS value FROM audit_events").get() as {
      value: number;
    };
    expect(Number(next.value)).toBe(6);

    // Exactly one sqlite_sequence row. Two would let AUTOINCREMENT reissue a sequence that a
    // reader has already been marked as having seen - the corruption the rebuild guards against.
    const tracked = migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'").all();
    expect(tracked).toHaveLength(1);

    // The indexes the log pages through are rebuilt with the table.
    const indexes = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'")
      .all()
      .map((row) => String((row as { name: string }).name));
    expect(indexes).toEqual(expect.arrayContaining(["idx_audit_project", "idx_audit_entity"]));

    migrated.close();
  });

  it("is a no-op on a database that already accepts chapters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-audit-noop-"));
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const databasePath = join(directory, "grimoire.sqlite");
    const { openDatabase } = await import("../../server/database");

    const first = openDatabase(databasePath);
    const definition = first.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get();
    first.close();

    const second = openDatabase(databasePath);
    const again = second.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get();
    second.close();

    expect(again).toEqual(definition);
  });
});
