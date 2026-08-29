import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AUDIT_ENTITY_TYPES, FIELD_TYPES } from "../shared/types";
import { slugify } from "./slug";

/**
 * The table definition is shared between first-run creation and the CHECK-widening
 * rebuild, so the two can never drift into disagreeing about the constraint.
 */
function auditEventsTable(name: string): string {
  const entityTypes = AUDIT_ENTITY_TYPES.map((value) => `'${value}'`).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${name} (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  actor_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN (${entityTypes})),
  entity_id TEXT,
  entity_title TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  agent_token_id TEXT REFERENCES agent_tokens(id)
);`;
}

/**
 * Every column the rebuild carries across, named explicitly.
 *
 * A rebuild that listed fewer columns than the table has would silently drop the rest, so
 * anything added to `auditEventsTable` has to be added here in the same change.
 */
const AUDIT_EVENT_COLUMNS = [
  "sequence",
  "id",
  "project_id",
  "actor_id",
  "actor_name",
  "entity_type",
  "entity_id",
  "entity_title",
  "action",
  "changes",
  "created_at",
  "agent_token_id",
] as const;

const auditEventsIndexes = `CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(project_id, entity_id, sequence DESC);`;

/**
 * A credential that lets something without a browser act inside one project.
 *
 * It belongs to a person as well as a project, and every write it makes is attributed to
 * that person: a token is a delegation, not a second kind of account. Only the hash is
 * stored, exactly as sessions and invitations do it.
 *
 * Revoking sets `revoked_at` rather than deleting the row, so `audit_events.agent_token_id`
 * keeps resolving and a retired agent's history still says which agent wrote it.
 */
const agentTokensTable = `CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);`;

/**
 * The fields one project decided its pages carry.
 *
 * Definitions live here rather than on disk because they are project configuration, the same
 * kind of thing as categories, and because a page file that carried its own schema would let
 * two pages disagree about what a field means. The values stay in the Markdown, where the
 * rest of the page's content is.
 *
 * No project is seeded with any. A team that wants none keeps files byte-identical to the
 * ones it has now, which is the whole reason this is additive rather than a new default.
 */
const FIELD_TYPE_LIST = FIELD_TYPES.map((value) => `'${value}'`).join(", ");

/** Named so the widening rebuild below can create its replacement from the same source. */
const projectFieldsTableNamed = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (${FIELD_TYPE_LIST})),
  options TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  show_on_tile INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);`;

const projectFieldsTable = projectFieldsTableNamed("project_fields");

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

/**
 * BEGIN IMMEDIATE around `fn`: committed on return, rolled back on throw. Eleven
 * hand-written copies of this envelope preceded it, and an envelope hand-written a
 * twelfth time is one forgotten ROLLBACK away from holding the write lock forever.
 */
export function withTransaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

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

  return withTransaction(database, () => {
    database
      .prepare("INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, name, projectSlug, now, now);
    database
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .run(projectId, ownerId, now);
    seedDefaultCategories(database, projectId, now);
    return projectId;
  });
}

export function projectSlugFromName(name: string): string {
  // The fallback matters here alone: a project directory must have a name even when the
  // project's own is all punctuation, while a category or field spelled that way is refused.
  return slugify(name, 60) || "project";
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
  // Additive and defaulted off, so a build that predates chapters simply ignores the column
  // and a rollback needs no undo step.
  if (!projectColumns.includes("chapters_enabled")) {
    database.exec("ALTER TABLE projects ADD COLUMN chapters_enabled INTEGER NOT NULL DEFAULT 0");
  }
  // The design-pillars columns outlived the product shape they belonged to: written as ''
  // at creation and never read or edited anywhere since the pillars were removed. Dropped
  // rather than repurposed, so `description` below starts with an honest name and no ghosts.
  for (const pillar of ["pitch", "player_fantasy", "current_direction", "direction_detail", "non_goals"]) {
    if (projectColumns.includes(pillar)) database.exec(`ALTER TABLE projects DROP COLUMN ${pillar}`);
  }
  // Which repository this project's pull requests live in, and the token that may read it.
  // Additive and empty by default: a project that never links GitHub stores nothing.
  if (!projectColumns.includes("github_repo")) {
    database.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''");
  }
  if (!projectColumns.includes("github_token")) {
    database.exec("ALTER TABLE projects ADD COLUMN github_token TEXT NOT NULL DEFAULT ''");
  }
  // Estimates are a gate like chapters: off by default, so a project that never asks for
  // them keeps page files byte-identical to the ones it has now.
  if (!projectColumns.includes("estimates_enabled")) {
    database.exec("ALTER TABLE projects ADD COLUMN estimates_enabled INTEGER NOT NULL DEFAULT 0");
  }
  // Where a chapter recap is posted, and whether closing one posts it. Additive and empty,
  // so a project that never asks for this stores nothing and posts nothing.
  if (!projectColumns.includes("discord_webhook")) {
    database.exec("ALTER TABLE projects ADD COLUMN discord_webhook TEXT NOT NULL DEFAULT ''");
  }
  if (!projectColumns.includes("recap_on_close")) {
    database.exec("ALTER TABLE projects ADD COLUMN recap_on_close INTEGER NOT NULL DEFAULT 1");
  }
  if (!projectColumns.includes("description")) {
    database.exec("ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

  // Agent access is additive in both directions: an older build simply never reads these,
  // and a database that predates them gains an empty table and a null column.
  //
  // Both run before the rebuild below, because the rebuilt `audit_events` references
  // `agent_tokens` and ends with a foreign key check that a missing table would fail.
  database.exec(agentTokensTable);

  // Nullable, so this is a plain ADD COLUMN and needs none of the rebuild machinery below.
  // It carries which agent wrote an event, because the actor name cannot: reads prefer the
  // live account name, so a label folded into that snapshot would never be displayed.
  if (!tableColumns(database, "audit_events").includes("agent_token_id")) {
    database.exec("ALTER TABLE audit_events ADD COLUMN agent_token_id TEXT REFERENCES agent_tokens(id)");
  }

  widenAuditEntityTypes(database);
  widenFieldTypes(database);
  adoptAdminRole(database);

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
  withTransaction(database, () => {
    for (const project of unseeded) seedDefaultCategories(database, String(project.id), now);
  });
}

/**
 * Brings `audit_events.entity_type` in line with the entity kinds the product now has.
 *
 * That means accepting `chapter`, and renaming historical `card` rows to `page`. The rows are
 * rewritten rather than left alone because the log records what happened, and what happened
 * was that a page was created - only the word for it changed. Leaving them would also break
 * the copy outright, since the new constraint no longer allows `card`.
 *
 * SQLite cannot alter a CHECK constraint in place, so this rebuilds the table. Two things
 * make that more delicate than a normal rebuild, and both are why the copy names `sequence`
 * explicitly instead of letting it regenerate:
 *
 * - `sequence` is the activity log's paging cursor, and every row in `seen_cursors` stores a
 *   number pointing into it. Renumbering would silently rewind or overshoot every member's
 *   while-you-were-away boundary.
 * - AUTOINCREMENT keeps a high-water mark in `sqlite_sequence`. It is carried across so a
 *   later insert can never reuse a sequence a reader has already been marked as having seen.
 *
 * Nothing references `audit_events`, so dropping it cannot cascade. Its indexes go with it
 * and are recreated here, because the startup schema has already run by this point.
 */
/**
 * Brings `project_fields.type` in line with the field kinds the product now has.
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt from the current
 * definition and the rows copied across. This one is far simpler than the audit rebuild
 * above: nothing references `project_fields`, none of its columns is a cursor anything else
 * stores, and no values change - only the set the constraint will accept grows.
 */
function widenFieldTypes(database: DatabaseSync): void {
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_fields'")
    .get() as { sql?: string } | undefined;
  if (!existing?.sql) return;
  if (FIELD_TYPES.every((value) => existing.sql!.includes(`'${value}'`))) return;

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    withTransaction(database, () => {
      database.exec(projectFieldsTableNamed("project_fields_rebuild"));
      const columns = tableColumns(database, "project_fields").join(", ");
      database.exec(`INSERT INTO project_fields_rebuild (${columns}) SELECT ${columns} FROM project_fields`);
      database.exec("DROP TABLE project_fields");
      database.exec("ALTER TABLE project_fields_rebuild RENAME TO project_fields");
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Splits the old account-wide `owner` into an installation admin and per-project owners.
 *
 * The account role used to be both the power somebody had and the set of projects they had
 * it in, so promoting a second owner handed them the whole installation. It now says only
 * what somebody is on the installation, and there is exactly one of those.
 *
 * Two things are settled here, once, on the way past:
 *
 * - The first account becomes the `admin` - whoever set the installation up, which is the
 *   only account that can be identified without being told. Every other account becomes a
 *   plain member, which takes away nothing their project rows do not already grant.
 * - Each project's creator is confirmed as its owner, and everybody else on it is reduced
 *   to a member. Under the old model a project owner row was never granted per project: the
 *   promotion wrote `role` across every row a user had, so every non-creator owner row on
 *   disk is spillage from that write rather than a decision anybody made about that project.
 *   Reducing them is what makes the remaining owner rows mean something again.
 *
 * It runs once, gated on the constraint it also widens, because re-running it every startup
 * would reinstate a creator the admin had deliberately demoted.
 */
function adoptAdminRole(database: DatabaseSync): void {
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  if (!existing?.sql || existing.sql.includes("'admin'")) return;

  // A pragma is a no-op inside a transaction, so the guard is lifted around the whole swap.
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    withTransaction(database, () => {
      database.exec(usersTableNamed("users_rebuild"));
      database.exec(
        `INSERT INTO users_rebuild (id, name, email, password_hash, role, created_at)
       SELECT id, name, email, password_hash,
         CASE WHEN id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
           THEN 'admin' ELSE 'member' END,
         created_at
       FROM users`,
      );
      database.exec("DROP TABLE users");
      database.exec("ALTER TABLE users_rebuild RENAME TO users");

      // The creator is the earliest membership row: it is written inside the same transaction
      // that writes the project, so nobody else can hold an earlier one.
      database.exec(
        `UPDATE project_members SET role = CASE WHEN created_at = (
         SELECT MIN(created_at) FROM project_members AS earliest
         WHERE earliest.project_id = project_members.project_id
       ) THEN 'owner' ELSE 'member' END`,
      );
      // Sessions, invitations and the whole activity log point at `users`, and the swap above
      // drops it with the guard lifted. Checking before the commit is what stops a bad rebuild
      // from being the thing that signs everybody out.
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("Rebuilding users would break a foreign key");
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function widenAuditEntityTypes(database: DatabaseSync): void {
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get() as { sql?: string } | undefined;
  if (!existing?.sql) return;
  if (AUDIT_ENTITY_TYPES.every((value) => existing.sql!.includes(`'${value}'`))) return;

  const highWater = Number(
    (
      database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'").get() as
        | { seq?: number }
        | undefined
    )?.seq ?? 0,
  );

  // A pragma is a no-op inside a transaction, so the guard is lifted around the whole swap.
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    withTransaction(database, () => {
      database.exec(auditEventsTable("audit_events_rebuild"));
      // The source may predate a column the rebuilt table has, so anything missing is selected
      // as NULL rather than named blindly, which would fail the copy on an older database.
      const present = new Set(tableColumns(database, "audit_events"));
      const selected = AUDIT_EVENT_COLUMNS.map((column) => {
        if (column === "entity_type") return "CASE entity_type WHEN 'card' THEN 'page' ELSE entity_type END";
        return present.has(column) ? column : "NULL";
      });
      database.exec(
        `INSERT INTO audit_events_rebuild (${AUDIT_EVENT_COLUMNS.join(", ")})
       SELECT ${selected.join(", ")}
       FROM audit_events`,
      );
      database.exec("DROP TABLE audit_events");
      database.exec("ALTER TABLE audit_events_rebuild RENAME TO audit_events");
      database.exec(auditEventsIndexes);
      // Copying the rows with explicit sequences already leaves sqlite_sequence at their
      // maximum, so this only has to raise it in the rare case that the old high-water mark ran
      // ahead of the surviving rows. Whether a row exists has to be asked directly: an UPDATE
      // that changes nothing is ambiguous between "no such row" and "already high enough", and
      // sqlite_sequence has no unique constraint to make INSERT OR IGNORE safe. Two rows for one
      // table would let AUTOINCREMENT hand out a sequence a reader has already been marked as
      // having seen, which is the exact corruption this whole routine exists to prevent.
      const tracked = Number(
        (
          database
            .prepare("SELECT COUNT(*) AS rows FROM sqlite_sequence WHERE name = 'audit_events'")
            .get() as { rows: number }
        ).rows,
      );
      if (tracked > 0) {
        database
          .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events' AND seq < ?")
          .run(highWater, highWater);
      } else if (highWater > 0) {
        database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', ?)").run(highWater);
      }
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("Rebuilding audit_events would break a foreign key");
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (
    database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
  ).map((row) => String(row.name));
}

/**
 * Named, because the account role changed shape and SQLite cannot alter a CHECK in place:
 * the migration below rebuilds this table, and both it and the schema must be one definition
 * or the rebuilt table would drift from the created one.
 */
function usersTableNamed(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL
);`;
}

const schema = `
${usersTableNamed("users")}

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
  description TEXT NOT NULL DEFAULT '',
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

${auditEventsTable("audit_events")}

CREATE TABLE IF NOT EXISTS seen_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

${agentTokensTable}

/*
 * The identity provider this installation signs people in through, when it has one.
 *
 * One row, because a provider belongs to the installation rather than to a project - the
 * same reason there is exactly one admin. It lives in the database rather than only in the
 * environment so that setting it up is a screen somebody fills in and checks, instead of a
 * redeploy they get wrong twice. An environment variable still wins where one is set, which
 * is what keeps a file-configured deployment file-configured.
 */
CREATE TABLE IF NOT EXISTS oidc_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  issuer TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  auto_register INTEGER NOT NULL DEFAULT 1,
  allowed_email_domains TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  signup_project TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by TEXT REFERENCES users(id)
);

/*
 * Which account a provider's person is, recorded rather than worked out again each time.
 *
 * The first sign-in finds the account by email, which is what makes turning single sign-on on
 * a non-event for an installation that already has people in it. That match is then written
 * down, because email is a good way to *find* somebody once and a bad way to *keep knowing*
 * who they are: people change their address, and an installation that re-derived the link every
 * time would hand them a second, empty account on the day they did.
 *
 * Keyed by issuer as well as subject, so a subject id is only ever believed from the provider
 * that issued it, and moving to a different provider leaves the old links inert rather than
 * letting a colliding id inherit an account.
 */
CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  last_sign_in_at TEXT,
  PRIMARY KEY (issuer, subject)
);

CREATE INDEX IF NOT EXISTS oidc_identities_user ON oidc_identities(user_id);

${projectFieldsTable}
/*
 * What people said to each other about a page.
 *
 * Deliberately not in the Markdown. A page file is portable and editable outside Grimoire,
 * and a conversation folded into its body would be rewritten by the first external editor
 * that touched it. This is the same choice the activity log already makes, and it has the
 * same consequence: discussion is visible in Grimoire and nowhere else.
 *
 * A row with no parent_id opens a thread; every other row answers one. answered_at is the
 * only state a thread has, and nothing is ever deleted to reach it.
 */
CREATE TABLE IF NOT EXISTS page_discussion (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  parent_id TEXT REFERENCES page_discussion(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  author_name TEXT NOT NULL,
  agent_token_id TEXT REFERENCES agent_tokens(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT REFERENCES users(id)
);

/*
 * Who a message named.
 *
 * Resolved once, when it is written, and stored as ids rather than re-read out of the text on
 * every load. A name in a body is a quote and never changes; who was meant by it is a fact
 * about an account, and an account can be renamed. Ids are also what a relay to somewhere else
 * will need, because "@Alan" means nothing to Discord and a user id can be mapped to one.
 */
CREATE TABLE IF NOT EXISTS discussion_mentions (
  message_id TEXT NOT NULL REFERENCES page_discussion(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

/*
 * How far each person has read the conversation on each page.
 *
 * The same shape as seen_cursors and for the same reason: it is private, it is per person,
 * and nobody can see how caught up anybody else is. A page with no row here has never been
 * opened by that person, so everything on it is unseen.
 *
 * Time rather than a sequence, because this is scoped to one page rather than to the whole
 * project's log, and a message carries the moment it was written already.
 */
CREATE TABLE IF NOT EXISTS discussion_seen (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, page_id)
);

CREATE TABLE IF NOT EXISTS github_link_status (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'draft', 'merged', 'closed', 'missing', 'unchecked')),
  pr_number INTEGER,
  pr_title TEXT,
  pr_url TEXT,
  checked_at TEXT,
  PRIMARY KEY (project_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(project_id, status, position) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_discussion_page ON page_discussion(project_id, page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discussion_open ON page_discussion(project_id, page_id) WHERE parent_id IS NULL AND answered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_discussion_mentions_user ON discussion_mentions(user_id);
${auditEventsIndexes}
`;
