import type { DatabaseSync } from "node:sqlite";
import type { Member, ProjectRole, User } from "../../shared/types";
import { withTransaction } from "../database";
import type { MarkdownPageStore } from "../markdown-pages";
import { projectById } from "./projects";
import { row, rows } from "./rows";
import { findUserByEmail, publicUser } from "./users";

// Who is on a project, and with which project role.

export type AddProjectMemberResult = { added: User } | "no_account" | "already_there";

/**
 * Puts somebody who already has an account onto another project.
 *
 * An invitation only ever made an account, and refused an email that already had one, so
 * there was no way to work with a colleague on a second project: they could be on the one
 * they registered through and on nothing else. That went unnoticed while owning anything
 * meant reaching everything, and became the obvious hole the moment membership was the reach.
 *
 * They join as a member. An owner promotes from the same place afterwards if that is what
 * was meant - which keeps this one action about access and nothing else.
 */
export function addProjectMember(
  database: DatabaseSync,
  projectId: string,
  email: string,
): AddProjectMemberResult {
  const found = findUserByEmail(database, email);
  if (!found) return "no_account";
  const invited = publicUser(found);
  if (
    row(
      database,
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId,
      invited.id,
    )
  ) {
    return "already_there";
  }
  database
    .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(projectId, invited.id, new Date().toISOString());
  return { added: invited };
}

export function membersForProject(database: DatabaseSync, projectId: string): Member[] {
  return rows(
    database,
    `SELECT users.id, users.name, users.email, users.role, project_members.role AS project_role
     FROM project_members JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? ORDER BY project_members.created_at`,
    projectId,
  ).map((value): Member => ({
    ...publicUser(value),
    projectRole: value.project_role as Member["projectRole"],
  }));
}

export type SetMemberRoleResult = "updated" | "not_found" | "unchanged" | "admin";

/**
 * Promotes or demotes somebody on one project.
 *
 * This grants the project, and only the project. It used to write the account-wide role and
 * then copy it across every membership row the person held, so promoting a second owner
 * handed them the whole installation and demoting them in one project took away a project
 * they had created themselves.
 *
 * The admin is refused rather than guarded: it is an installation role, so there is no
 * project promotion that could grant it and none that should be able to take it back.
 */
export function setMemberRole(
  database: DatabaseSync,
  projectId: string,
  memberId: string,
  role: ProjectRole,
): SetMemberRoleResult {
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!member) return "not_found";
  // The admin is not a project role and cannot be handed out or taken back by one.
  if (member.role === "admin") return "admin";
  if (member.projectRole === role) return "unchanged";

  // Scoped to this project, and to `project_members` alone. Writing the account role too -
  // and worse, writing it across every membership row the person had - is what made one
  // promotion reach every project they were on, and what let a demotion in somebody else's
  // project strip them of the project they created themselves.
  database
    .prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?")
    .run(role, projectId, memberId);
  return "updated";
}

export type RemoveMemberResult = "removed" | "not_found" | "owner" | "admin";

export function removeProjectMember(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  memberId: string,
): RemoveMemberResult {
  const project = projectById(database, projectId);
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!project || !member) return "not_found";
  if (member.projectRole === "owner") return "owner";
  // The installation's admin is not a member a project owner gets to remove.
  if (member.role === "admin") return "admin";

  withTransaction(database, () => {
    const removed = database
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'")
      .run(projectId, memberId);
    if (Number(removed.changes) !== 1)
      throw new Error("Project membership changed while it was being removed");
    database
      .prepare("DELETE FROM seen_cursors WHERE project_id = ? AND user_id = ?")
      .run(projectId, memberId);
    const remaining = row(
      database,
      "SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?",
      memberId,
    );
    if (Number(remaining?.count ?? 0) === 0) {
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(memberId);
    }
  });

  // Assignments clear only once the removal has committed. Cleared first, a rolled-back
  // removal would leave a still-present member silently unassigned from everything; this
  // way an interruption leaves page files naming a non-member, which the board already
  // reads as unassigned.
  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.assignee?.toLowerCase() !== member.email.toLowerCase()) return;
    pageStore.save(String(project.slug), { ...page, assignee: null, updatedAt: now });
  });
  return "removed";
}
