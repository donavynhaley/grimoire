import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(schema);
  return database;
}

export function createWizardSimulatorProject(database: DatabaseSync, ownerId: string): string {
  const projectId = randomUUID();
  const milestoneId = randomUUID();
  const now = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projects (
          id, name, slug, pitch, player_fantasy, current_direction, direction_detail, non_goals, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        "Wizard Simulator",
        "wizard-simulator",
        "A tactile first-person fantasy simulator about doing the strange daily work of a village wizard.",
        "Become a working wizard by observing, understanding, and physically manipulating a magical world.",
        "Make Wizard Sight essential, strange, and useful.",
        "Build one complete investigation that cannot be solved through ordinary observation.",
        "No multiplayer production, broad content expansion, or disconnected spell systems during the current focus.",
        now,
        now,
      );

    database
      .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .run(projectId, ownerId, now);

    const pillars = [
      ["Wizard work is physical", "Magic should feel like practiced labor performed with hands, tools, and preparation."],
      ["Knowledge changes perception", "Learning should reveal relationships and possibilities that were previously invisible."],
      ["Consequences remain in the world", "Spellwork should leave readable, persistent evidence rather than disappearing as effects."],
    ];
    const insertPillar = database.prepare(
      "INSERT INTO pillars (id, project_id, title, description, position) VALUES (?, ?, ?, ?, ?)",
    );
    pillars.forEach(([title, description], position) =>
      insertPillar.run(randomUUID(), projectId, title, description, position),
    );

    database
      .prepare(
        "INSERT INTO milestones (id, project_id, title, description, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)",
      )
      .run(
        milestoneId,
        projectId,
        "Wizard Sight vertical slice",
        "The player discovers, understands, and changes one hidden elemental relationship.",
        now,
        now,
      );

    const insertCondition = database.prepare(
      "INSERT INTO milestone_conditions (id, milestone_id, title, complete, position) VALUES (?, ?, ?, ?, ?)",
    );
    [
      ["Sight has a distinct visual identity", 1],
      ["Elements can move between sources", 1],
      ["Knowledge changes what the player can perceive", 0],
      ["One complete discovery is ready for playtesting", 0],
    ].forEach(([title, complete], position) =>
      insertCondition.run(randomUUID(), milestoneId, title, complete, position),
    );

    const insertIdea = database.prepare(
      "INSERT INTO ideas (id, project_id, title, notes, status, horizon, created_by, created_at, updated_at) VALUES (?, ?, ?, '', 'inbox', 'later', ?, ?, ?)",
    );
    insertIdea.run(randomUUID(), projectId, "Let awakened objects remember previous wizards", ownerId, now, now);
    insertIdea.run(randomUUID(), projectId, "A spell should leave physical evidence in the room", ownerId, now, now);

    database.exec("COMMIT");
    return projectId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id),
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS pillars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'complete')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestone_conditions (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('inbox', 'considering', 'later', 'promoted', 'rejected')),
  horizon TEXT NOT NULL CHECK (horizon IN ('now', 'next', 'later')),
  created_by TEXT NOT NULL REFERENCES users(id),
  promoted_outcome_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('shaping', 'ready', 'active', 'playtest', 'integrated', 'validated', 'revise', 'cut')),
  owner_id TEXT REFERENCES users(id),
  milestone_id TEXT REFERENCES milestones(id),
  pillar_id TEXT REFERENCES pillars(id),
  definition_of_playable TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome_id TEXT NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  discipline TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'doing', 'review', 'done')),
  owner_id TEXT REFERENCES users(id),
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  PRIMARY KEY (work_item_id, depends_on_id),
  CHECK (work_item_id != depends_on_id)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome_id TEXT REFERENCES outcomes(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'prop',
  status TEXT NOT NULL DEFAULT 'active',
  owner_id TEXT REFERENCES users(id),
  source_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_stages (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'ready', 'doing', 'review', 'done')),
  owner_id TEXT REFERENCES users(id),
  position INTEGER NOT NULL DEFAULT 0,
  handoff_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  known_issues TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  built_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playtests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome_id TEXT REFERENCES outcomes(id),
  build_id TEXT REFERENCES builds(id),
  title TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL CHECK (decision IN ('undecided', 'keep', 'revise', 'cut')),
  created_by TEXT NOT NULL REFERENCES users(id),
  played_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_project ON outcomes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_work_project ON work_items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, created_at DESC);
`;

