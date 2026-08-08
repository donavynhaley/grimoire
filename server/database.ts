import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_PROJECT_CATEGORIES: Array<{ slug: string; name: string; color: string }> = [
  { slug: "design", name: "Design", color: "#d6bc78" },
  { slug: "code", name: "Code", color: "#8bb9c9" },
  { slug: "modeling", name: "Modeling", color: "#b49bd4" },
  { slug: "texturing", name: "Texturing", color: "#d89b73" },
  { slug: "animation", name: "Animation", color: "#d88eae" },
  { slug: "narrative", name: "Narrative", color: "#a99bdc" },
  { slug: "audio", name: "Audio", color: "#b8d99b" },
  { slug: "ui", name: "UI", color: "#74c6bf" },
  { slug: "vfx", name: "VFX", color: "#d284d3" },
  { slug: "production", name: "Production", color: "#a7adaf" },
];

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(schema);
  migrate(database);
  return database;
}

export function createWizardSimulatorProject(database: DatabaseSync, ownerId: string): string {
  return createProject(database, ownerId, "Wizard Simulator", "wizard-simulator");
}

export function createProject(database: DatabaseSync, ownerId: string, name: string, slug?: string): string {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  const projectSlug = slug ?? uniqueProjectSlug(database, name);

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projects (
          id, name, slug, pitch, player_fantasy, current_direction, direction_detail, non_goals, created_at, updated_at
        ) VALUES (?, ?, ?, '', '', '', '', '', ?, ?)`,
      )
      .run(projectId, name, projectSlug, now, now);
    database
      .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .run(projectId, ownerId, now);
    seedDefaultCategories(database, projectId, now);
    database.exec("COMMIT");
    return projectId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function projectSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "project";
}

function uniqueProjectSlug(database: DatabaseSync, name: string): string {
  const base = projectSlugFromName(name);
  let candidate = base;
  for (let suffix = 2; ; suffix += 1) {
    const existing = database.prepare("SELECT 1 FROM projects WHERE slug = ?").get(candidate);
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
  }
}

function seedDefaultCategories(database: DatabaseSync, projectId: string, now: string): void {
  const insert = database.prepare(
    "INSERT INTO categories (project_id, slug, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  DEFAULT_PROJECT_CATEGORIES.forEach((category, position) => {
    insert.run(projectId, category.slug, category.name, category.color, position, now);
  });
}

function migrate(database: DatabaseSync): void {
  const projectColumns = tableColumns(database, "projects");
  if (!projectColumns.includes("archived_at")) {
    database.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
  }

  const inviteColumns = tableColumns(database, "invites");
  if (!inviteColumns.includes("project_id")) {
    database.exec("ALTER TABLE invites ADD COLUMN project_id TEXT REFERENCES projects(id)");
    database.exec(
      `UPDATE invites SET project_id = (
        SELECT project_id FROM project_members
        WHERE project_members.user_id = invites.created_by
        ORDER BY project_members.created_at LIMIT 1
      ) WHERE project_id IS NULL`,
    );
  }

  const unseeded = database
    .prepare("SELECT id FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM categories)")
    .all() as Array<{ id: string }>;
  if (unseeded.length === 0) return;
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const project of unseeded) seedDefaultCategories(database, String(project.id), now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map(
    (row) => String(row.name),
  );
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  pitch TEXT NOT NULL DEFAULT '',
  player_fantasy TEXT NOT NULL DEFAULT '',
  current_direction TEXT NOT NULL DEFAULT '',
  direction_detail TEXT NOT NULL DEFAULT '',
  non_goals TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS categories (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slug)
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'in_progress', 'review', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  assignee_id TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(project_id, status, position) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(project_id, entity_id, sequence DESC);
`;
