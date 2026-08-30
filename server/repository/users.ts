import type { DatabaseSync } from "node:sqlite";
import type { User } from "../../shared/types";
import { type Row, row } from "./rows";

// Accounts and each reader's private seen-cursor into a project's activity log.

export function publicUser(value: Row): User {
  return {
    id: String(value.id),
    name: String(value.name),
    email: String(value.email),
    // Checked rather than cast, because this value is what requireAdmin gates on;
    // a row that stopped saying 'admin' - however it got that way - must read as
    // the lesser role, never as whatever the column happens to hold.
    role: value.role === "admin" ? "admin" : "member",
  };
}

export function findUserByEmail(database: DatabaseSync, email: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE email = ? COLLATE NOCASE", email);
}

export function findUserById(database: DatabaseSync, id: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE id = ?", id);
}

export function userCount(database: DatabaseSync): number {
  return Number(row(database, "SELECT COUNT(*) AS count FROM users")?.count ?? 0);
}

/**
 * Where somebody lands with no project named: the first one they were put on.
 *
 * The admin falls back to the oldest project on the installation, so an admin who happens
 * to be on none of them still has somewhere to land - the login gate refuses an account
 * with no project at all, and the one account that can never be locked out must not be
 * the one that trips it.
 */
export function defaultProjectIdForUser(database: DatabaseSync, user: User): string | null {
  const value =
    row(
      database,
      `SELECT project_members.project_id FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.user_id = ? AND projects.archived_at IS NULL
       ORDER BY project_members.created_at LIMIT 1`,
      user.id,
    ) ??
    (user.role === "admin"
      ? row(
          database,
          "SELECT id AS project_id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1",
        )
      : undefined);
  return value ? String(value.project_id) : null;
}

/** The reader's private boundary into the activity log, or null before their first look. */
export function seenCursor(database: DatabaseSync, projectId: string, userId: string): number | null {
  const value = row(
    database,
    "SELECT last_seen_sequence FROM seen_cursors WHERE project_id = ? AND user_id = ?",
    projectId,
    userId,
  );
  return value ? Number(value.last_seen_sequence) : null;
}

/**
 * First look at a project starts at the present, so joining never dumps the
 * whole history as unread. Racing tabs both succeed; the first row wins.
 */
export function initializeSeenCursor(
  database: DatabaseSync,
  projectId: string,
  userId: string,
  sequence: number,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}

/** Advances with MAX semantics, so stale tabs and repeats can never rewind the boundary. */
export function advanceSeenCursor(
  database: DatabaseSync,
  projectId: string,
  userId: string,
  sequence: number,
): void {
  database
    .prepare(
      `INSERT INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         last_seen_sequence = MAX(last_seen_sequence, excluded.last_seen_sequence),
         updated_at = excluded.updated_at`,
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}
