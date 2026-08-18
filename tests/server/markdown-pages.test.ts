import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../server/database";
import { MarkdownPageStore, type StoredPage } from "../../server/markdown-pages";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-markdown-pages-"));
  directories.push(directory);
  return { directory, store: new MarkdownPageStore(directory) };
}

function page(overrides: Partial<StoredPage> = {}): StoredPage {
  return {
    id: "9c46098a-7e85-48de-8a58-213236a8cf0d",
    title: "Research potion reactions",
    description: "- [ ] Test moonwort\n- [ ] Record the result",
    category: "code",
    chapter: null,
    fields: {},
    blockedBy: ["8d3e49fa-2ce5-4cc1-80e7-b3f6d49435f9"],
    unblockedPages: [],
    status: "backlog",
    position: 0,
    assignee: "owner@example.com",
    createdBy: "owner@example.com",
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    github: null,
    ...overrides,
  };
}

describe("MarkdownPageStore", () => {
  it("round-trips strict YAML frontmatter and a Markdown body", () => {
    const { directory, store } = createStore();
    store.save("wizard-simulator", page({ title: "Research: potion reactions" }));

    const path = join(directory, "wizard-simulator", "pages", "9c46098a-7e85-48de-8a58-213236a8cf0d.md");
    const markdown = readFileSync(path, "utf8");
    expect(markdown).toContain('title: "Research: potion reactions"');
    expect(markdown).toContain("category: code");
    expect(markdown).toContain('blocked_by: ["8d3e49fa-2ce5-4cc1-80e7-b3f6d49435f9"]');
    expect(markdown).toContain("assignee: owner@example.com");
    expect(markdown).toContain("completed_at: null");
    expect(markdown).toContain("\n---\n\n- [ ] Test moonwort\n- [ ] Record the result\n");
    expect(store.list("wizard-simulator")).toEqual([page({ title: "Research: potion reactions" })]);
    expect(readdirSync(join(directory, "wizard-simulator", "pages"))).toEqual([
      "9c46098a-7e85-48de-8a58-213236a8cf0d.md",
    ]);
  });

  it("loads older completed pages without completed_at using their last update time", () => {
    const { directory, store } = createStore();
    const completed = page({
      status: "done",
      updatedAt: "2026-08-03T13:00:00.000Z",
      completedAt: "2026-08-03T13:00:00.000Z",
    });
    store.save("wizard-simulator", completed);
    const path = join(directory, "wizard-simulator", "pages", `${completed.id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("completed_at: 2026-08-03T13:00:00.000Z\n", ""));

    expect(store.list("wizard-simulator")[0].completedAt).toBe("2026-08-03T13:00:00.000Z");
  });

  it("reloads external edits and moves archived pages out of the active directory", () => {
    const { directory, store } = createStore();
    const original = page();
    store.save("wizard-simulator", original);
    const activePath = join(directory, "wizard-simulator", "pages", `${original.id}.md`);
    writeFileSync(
      activePath,
      readFileSync(activePath, "utf8").replace("Research potion reactions", "Document potion reactions"),
    );

    const edited = store.list("wizard-simulator")[0];
    expect(edited.title).toBe("Document potion reactions");
    store.archive("wizard-simulator", {
      ...edited,
      updatedAt: "2026-08-03T13:00:00.000Z",
      archivedAt: "2026-08-03T13:00:00.000Z",
    });

    expect(store.list("wizard-simulator")).toEqual([]);
    expect(readFileSync(join(directory, "wizard-simulator", "archive", `${original.id}.md`), "utf8")).toContain(
      "archived_at:",
    );
  });

  it("reports the exact file when frontmatter is invalid", () => {
    const { directory, store } = createStore();
    const path = join(directory, "wizard-simulator", "pages", "broken.md");
    store.save("wizard-simulator", page());
    writeFileSync(path, "---\ntitle: Missing required fields\n---\n");

    expect(() => store.list("wizard-simulator")).toThrow(`Invalid page file ${path}`);
  });

  it("migrates legacy SQLite rows only after writing their Markdown files", () => {
    const { directory, store } = createStore();
    const database = openDatabase(join(directory, "grimoire.sqlite"));
    const userId = "bb87e388-8625-47da-8fca-0d63a7ab2178";
    const projectId = "839760cc-df8a-4f3c-9963-921bd6d96465";
    const timestamp = "2026-08-03T12:00:00.000Z";
    database
      .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, "Donavyn", "owner@example.com", "unused", "owner", timestamp);
    database
      .prepare("INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, "Wizard Simulator", "wizard-simulator", timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO cards (
          id, project_id, title, description, status, position, assignee_id, created_by, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(page().id, projectId, page().title, page().description, "backlog", 0, userId, userId, timestamp, timestamp);

    expect(store.migrateLegacyPages(database)).toBe(1);
    expect(store.list("wizard-simulator")).toEqual([page({ category: null, blockedBy: [] })]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM cards").get()).toEqual({ count: 0 });
    expect(store.migrateLegacyPages(database)).toBe(0);
    database.close();
  });
});
