import type { DatabaseSync } from "node:sqlite";
import type { ArchivedProject, ProjectSummary, User } from "../../shared/types";
import { type Row, row, rows } from "./rows";

// The projects table itself: identity, access, archival, and per-project settings.

export function projectById(database: DatabaseSync, projectId: string): Row | undefined {
  return row(database, "SELECT id, name, slug, description FROM projects WHERE id = ?", projectId);
}

export function projectSlug(database: DatabaseSync, projectId: string): string | null {
  const project = row(database, "SELECT slug FROM projects WHERE id = ?", projectId);
  return project ? String(project.slug) : null;
}

/**
 * Whether this person is on that project at all.
 *
 * Membership is the reach. Owning a project says what somebody may do once they are on it,
 * never which projects they are on: being an owner somewhere is not a standing invitation
 * to every project on the installation, and somebody has to have put them on it. Nothing is
 * lost by insisting on that, because the account that creates a project is written in as its
 * owning member and that is the one membership row no removal may delete.
 *
 * The admin is the deliberate exception, and the only one - an installation needs an account
 * that cannot be shut out of it.
 */
export function userCanAccessProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "admin") {
    return Boolean(
      row(database, "SELECT 1 AS ok FROM projects WHERE id = ? AND archived_at IS NULL", projectId),
    );
  }
  return Boolean(
    row(
      database,
      `SELECT 1 AS ok FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.project_id = ? AND project_members.user_id = ? AND projects.archived_at IS NULL`,
      projectId,
      user.id,
    ),
  );
}

/**
 * Whether this person may reshape that project - its name, categories, chapters, fields,
 * agent access and membership.
 *
 * Two ways to be true, and they answer different questions. The project's own `owner` row
 * is the ordinary one: whoever created it holds it, and an owner may grant it to somebody
 * else on that project and nowhere else. The admin passes everywhere, which is the whole
 * point of there being one - an installation always has somebody who can reach into a
 * project whose owner has gone quiet.
 */
export function userOwnsProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "admin") return true;
  return Boolean(
    row(
      database,
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'owner'",
      projectId,
      user.id,
    ),
  );
}

/** The projects this person is on - every one of them, for the admin. The picker offers these. */
export function listProjectsForUser(database: DatabaseSync, user: User): ProjectSummary[] {
  const values =
    user.role === "admin"
      ? rows(
          database,
          "SELECT id, name, description FROM projects WHERE archived_at IS NULL ORDER BY created_at",
        )
      : rows(
          database,
          `SELECT projects.id, projects.name, projects.description FROM project_members
         JOIN projects ON projects.id = project_members.project_id
         WHERE project_members.user_id = ? AND projects.archived_at IS NULL
         ORDER BY project_members.created_at`,
          user.id,
        );
  return values.map((value) => ({
    id: String(value.id),
    name: String(value.name),
    description: String(value.description ?? ""),
  }));
}

export function renameProject(database: DatabaseSync, projectId: string, name: string): boolean {
  const result = database
    .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(name, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function setProjectDescription(
  database: DatabaseSync,
  projectId: string,
  description: string,
): boolean {
  const result = database
    .prepare("UPDATE projects SET description = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(description, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export type ArchiveProjectResult = "archived" | "not_found" | "last_project";

export function archiveProject(database: DatabaseSync, projectId: string): ArchiveProjectResult {
  const active = rows(database, "SELECT id FROM projects WHERE archived_at IS NULL");
  if (!active.some((value) => String(value.id) === projectId)) return "not_found";
  if (active.length === 1) return "last_project";
  database
    .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), projectId);
  return "archived";
}

/** Archiving was a one-way door until this list existed; it feeds the owner's restore surface. */
/**
 * The archived projects this person is on, newest first.
 *
 * Archiving only sets `archived_at`, so the membership rows outlive it and still say whose
 * project this was. A restore list drawn without them would name every project the
 * installation has ever archived to anyone holding the owner role.
 */
export function listArchivedProjects(database: DatabaseSync, user: User): ArchivedProject[] {
  return (
    user.role === "admin"
      ? rows(
          database,
          "SELECT id, name, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
        )
      : rows(
          database,
          `SELECT projects.id, projects.name, projects.archived_at FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.user_id = ? AND project_members.role = 'owner'
         AND projects.archived_at IS NOT NULL
       ORDER BY projects.archived_at DESC`,
          user.id,
        )
  ).map((value) => ({
    id: String(value.id),
    name: String(value.name),
    archivedAt: String(value.archived_at),
  }));
}

/** Clears `archived_at`, which is all archiving ever set - the files never left the disk. */
export function restoreProject(database: DatabaseSync, projectId: string): boolean {
  const result = database
    .prepare(
      "UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
    )
    .run(new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function setEstimatesEnabled(database: DatabaseSync, projectId: string, enabled: boolean): boolean {
  const result = database
    .prepare("UPDATE projects SET estimates_enabled = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(enabled ? 1 : 0, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function estimatesEnabled(database: DatabaseSync, projectId: string): boolean {
  // Asked for directly rather than through projectById, which selects only the project's
  // identity: a gate read through it was always answered "off" whatever the column said.
  const project = row(database, "SELECT estimates_enabled FROM projects WHERE id = ?", projectId);
  return Number(project?.estimates_enabled ?? 0) === 1;
}

/* ---------- where a recap goes ---------- */

export type RecapConfig = { webhook: string; onClose: boolean };

export function projectRecapConfig(database: DatabaseSync, projectId: string): RecapConfig {
  const project = row(
    database,
    "SELECT discord_webhook, recap_on_close FROM projects WHERE id = ?",
    projectId,
  );
  return {
    webhook: String(project?.discord_webhook ?? ""),
    onClose: Number(project?.recap_on_close ?? 1) === 1,
  };
}

/** Written only for what the caller actually sent, so saving one never clears the other. */
export function setProjectRecap(
  database: DatabaseSync,
  projectId: string,
  input: { webhook?: string; onClose?: boolean },
): void {
  const now = new Date().toISOString();
  // The same stillness the other settings keep: an archived project cannot be reconfigured.
  if (input.webhook !== undefined) {
    database
      .prepare("UPDATE projects SET discord_webhook = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.webhook, now, projectId);
  }
  if (input.onClose !== undefined) {
    database
      .prepare("UPDATE projects SET recap_on_close = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.onClose ? 1 : 0, now, projectId);
  }
}
