import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../server/database";
import { MarkdownCardStore, type StoredCard } from "../../server/markdown-cards";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-markdown-cards-"));
  directories.push(directory);
  return { directory, store: new MarkdownCardStore(directory) };
}

function card(overrides: Partial<StoredCard> = {}): StoredCard {
  return {
    id: "9c46098a-7e85-48de-8a58-213236a8cf0d",
    title: "Research potion reactions",
    description: "- [ ] Test moonwort\n- [ ] Record the result",
    category: "code",
    blockedBy: ["8d3e49fa-2ce5-4cc1-80e7-b3f6d49435f9"],
    unblockedCards: [],
    status: "backlog",
    position: 0,
    assignee: "owner@example.com",
    createdBy: "owner@example.com",
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("MarkdownCardStore", () => {
  it("round-trips strict YAML frontmatter and a Markdown body", () => {
    const { directory, store } = createStore();
    store.save("wizard-simulator", card({ title: "Research: potion reactions" }));

    const path = join(directory, "wizard-simulator", "cards", "9c46098a-7e85-48de-8a58-213236a8cf0d.md");
    const markdown = readFileSync(path, "utf8");
    expect(markdown).toContain('title: "Research: potion reactions"');
    expect(markdown).toContain("category: code");
    expect(markdown).toContain('blocked_by: ["8d3e49fa-2ce5-4cc1-80e7-b3f6d49435f9"]');
    expect(markdown).toContain("assignee: owner@example.com");
    expect(markdown).toContain("\n---\n\n- [ ] Test moonwort\n- [ ] Record the result\n");
    expect(store.list("wizard-simulator")).toEqual([card({ title: "Research: potion reactions" })]);
    expect(readdirSync(join(directory, "wizard-simulator", "cards"))).toEqual([
      "9c46098a-7e85-48de-8a58-213236a8cf0d.md",
    ]);
  });

  it("reloads external edits and moves archived cards out of the active directory", () => {
    const { directory, store } = createStore();
    const original = card();
    store.save("wizard-simulator", original);
    const activePath = join(directory, "wizard-simulator", "cards", `${original.id}.md`);
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
    const path = join(directory, "wizard-simulator", "cards", "broken.md");
    store.save("wizard-simulator", card());
    writeFileSync(path, "---\ntitle: Missing required fields\n---\n");

    expect(() => store.list("wizard-simulator")).toThrow(`Invalid card file ${path}`);
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
      .prepare(
        `INSERT INTO projects (
          id, name, slug, pitch, player_fantasy, current_direction, direction_detail, non_goals, created_at, updated_at
        ) VALUES (?, ?, ?, '', '', '', '', '', ?, ?)`,
      )
      .run(projectId, "Wizard Simulator", "wizard-simulator", timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO cards (
          id, project_id, title, description, status, position, assignee_id, created_by, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(card().id, projectId, card().title, card().description, "backlog", 0, userId, userId, timestamp, timestamp);

    expect(store.migrateLegacyCards(database)).toBe(1);
    expect(store.list("wizard-simulator")).toEqual([card({ category: null, blockedBy: [] })]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM cards").get()).toEqual({ count: 0 });
    expect(store.migrateLegacyCards(database)).toBe(0);
    database.close();
  });
});
