import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BoardWorkspace, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

/** Serves the built shell so link previews render, the way production does. */
async function startShellServer(): Promise<Server> {
  const shell = join(mkdtempSync(join(tmpdir(), "grimoire-shell-")), "dist");
  mkdirSync(shell, { recursive: true });
  copyFileSync(resolve("index.html"), join(shell, "index.html"));
  return startTestServer(undefined, { staticDirectory: shell });
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Server = Awaited<ReturnType<typeof startTestServer>>;

function projectDirectory(server: Server): string {
  return join(server.pagesDirectory, "getting-started");
}

/** Puts a project back the way a build that predates the rename left it. */
function revertToCards(server: Server): void {
  renameSync(join(projectDirectory(server), "pages"), join(projectDirectory(server), "cards"));
}

describe("renaming cards to pages on disk", () => {
  it("moves an existing project's cards directory to pages on the next start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-rename-"));
    directories.push(directory);

    const first = await startTestServer(directory);
    await bootstrap(first);
    const created = await first.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Older work" }),
    });
    const pageId = created.body.page.id;
    revertToCards(first);
    await first.close();

    expect(existsSync(join(directory, "pages", "getting-started", "cards"))).toBe(true);

    // Starting again performs the migration before anything reads a page.
    const second = await startTestServer(directory);
    const workspace = (
      await second.request<BoardWorkspace>("/api/board", {
        headers: { cookie: first.cookie() },
      })
    ).body;

    expect(existsSync(join(directory, "pages", "getting-started", "pages"))).toBe(true);
    expect(existsSync(join(directory, "pages", "getting-started", "cards"))).toBe(false);
    expect(workspace.pages.map((page) => page.id)).toEqual([pageId]);
    // The file itself is untouched by the move.
    expect(
      readFileSync(join(directory, "pages", "getting-started", "pages", `${pageId}.md`), "utf8"),
    ).toContain("title: Older work");
  });

  it("leaves a project alone once it has been migrated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-rename-idempotent-"));
    directories.push(directory);

    const first = await startTestServer(directory);
    await bootstrap(first);
    await first.request("/api/pages", { method: "POST", body: JSON.stringify({ title: "Work" }) });
    await first.close();

    const before = readdirSync(join(directory, "pages", "getting-started", "pages"));
    const second = await startTestServer(directory);
    await second.close();

    expect(readdirSync(join(directory, "pages", "getting-started", "pages"))).toEqual(before);
    expect(existsSync(join(directory, "pages", "getting-started", "cards"))).toBe(false);
  });

  it("keeps serving the old /api/cards paths so a deploy cannot 404 an open tab", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const created = await server.request<{ page: Page }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Saved from an old bundle" }),
    });
    expect(created.response.status).toBe(201);

    const edited = await server.request<{ page: Page }>(`/api/cards/${created.body.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Edited from an old bundle" }),
    });
    expect(edited.response.status).toBe(200);
    expect(edited.body.page.title).toBe("Edited from an old bundle");
  });

  it("still serves links shared as ?card= without publishing private metadata", async () => {
    const server = await startShellServer();
    await bootstrap(server);
    const created = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Shared long ago", category: "narrative", status: "in_progress" }),
    });

    // Those links live in other people's chat history forever, so they keep working.
    const legacy = await fetch(`${server.baseUrl}/?card=${created.body.page.id}`);
    const html = await legacy.text();
    expect(legacy.status).toBe(200);
    expect(html).toContain("<title>Grimoire</title>");
    expect(html).not.toContain("Shared long ago");
  });
});

describe("the directory rollback script", () => {
  it("puts pages back as cards so an older build can find them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-rollback-"));
    directories.push(directory);

    const server = await startTestServer(directory);
    await bootstrap(server);
    await server.request("/api/pages", { method: "POST", body: JSON.stringify({ title: "Work" }) });
    await server.close();

    const root = join(directory, "pages");
    const dryRun = execFileSync(process.execPath, [
      join(process.cwd(), "ops", "rename-pages-to-cards.mjs"),
      root,
    ]).toString();
    expect(dryRun).toContain("would rename");
    expect(existsSync(join(root, "getting-started", "pages"))).toBe(true);

    execFileSync(process.execPath, [
      join(process.cwd(), "ops", "rename-pages-to-cards.mjs"),
      root,
      "--apply",
    ]);

    expect(existsSync(join(root, "getting-started", "cards"))).toBe(true);
    expect(existsSync(join(root, "getting-started", "pages"))).toBe(false);
    // The archive was never named after the entity, so it stays put.
    expect(existsSync(join(root, "getting-started", "pages", "archive"))).toBe(false);
  });

  it("refuses to merge when both directories somehow exist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-rollback-clash-"));
    directories.push(directory);
    const project = join(directory, "pages", "getting-started");
    mkdirSync(join(project, "pages"), { recursive: true });
    mkdirSync(join(project, "cards"), { recursive: true });

    let failed = false;
    try {
      execFileSync(process.execPath, [
        join(process.cwd(), "ops", "rename-pages-to-cards.mjs"),
        join(directory, "pages"),
        "--apply",
      ]);
    } catch {
      failed = true;
    }

    // Two directories of work is a situation for a person, not a script.
    expect(failed).toBe(true);
    expect(existsSync(join(project, "pages"))).toBe(true);
    expect(existsSync(join(project, "cards"))).toBe(true);
  });
});

describe("renaming card events to page events in the activity log", () => {
  it("rewrites historical rows and keeps their sequence numbers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-audit-rename-"));
    directories.push(directory);
    const databasePath = join(directory, "grimoire.sqlite");

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
        entity_type TEXT NOT NULL CHECK (entity_type IN ('card', 'idea', 'project', 'category', 'member')),
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
       VALUES (?, 'project-1', 'user-1', 'Donavyn', ?, ?, ?, 'created', '2026-08-01T00:00:00.000Z')`,
    );
    insert.run("event-1", "card", "card-1", "A card");
    insert.run("event-2", "idea", "idea-1", "An idea");
    insert.run("event-3", "card", "card-2", "Another card");
    legacy
      .prepare("INSERT INTO seen_cursors VALUES ('project-1','user-1',2,'2026-08-01T00:00:00.000Z')")
      .run();
    legacy.close();

    const { openDatabase } = await import("../../server/database");
    const migrated = openDatabase(databasePath);

    const rows = migrated
      .prepare("SELECT sequence, entity_type, entity_title FROM audit_events ORDER BY sequence")
      .all();
    // The log records what happened, and what happened was that a page was created. Only the
    // word changed, so the rows are rewritten rather than left reading as a different entity.
    expect(rows).toEqual([
      { sequence: 1, entity_type: "page", entity_title: "A card" },
      { sequence: 2, entity_type: "idea", entity_title: "An idea" },
      { sequence: 3, entity_type: "page", entity_title: "Another card" },
    ]);

    const cursor = migrated
      .prepare("SELECT last_seen_sequence FROM seen_cursors WHERE user_id = 'user-1'")
      .get() as { last_seen_sequence: number };
    expect(Number(cursor.last_seen_sequence)).toBe(2);
    migrated.close();
  });
});
