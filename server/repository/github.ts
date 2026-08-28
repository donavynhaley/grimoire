import type { DatabaseSync } from "node:sqlite";
import type { PageGithubStatus } from "../../shared/types";
import { row, rows } from "./rows";

// A project's GitHub configuration and the cached pull-request status per linked page.

export type ProjectGithubConfig = { repo: string; token: string };

export function projectGithubConfig(database: DatabaseSync, projectId: string): ProjectGithubConfig {
  const project = row(database, "SELECT github_repo, github_token FROM projects WHERE id = ?", projectId);
  return { repo: String(project?.github_repo ?? ""), token: String(project?.github_token ?? "") };
}

/**
 * Points a project at its repository. The token is written only when the caller sends one,
 * so saving the repo never wipes a credential the form deliberately left blank; an empty
 * string sent explicitly clears it.
 */
export function setProjectGithub(
  database: DatabaseSync,
  projectId: string,
  input: { repo?: string; token?: string },
): void {
  const now = new Date().toISOString();
  // Archived projects refuse every browser, and their settings hold still with them.
  if (input.repo !== undefined) {
    database
      .prepare("UPDATE projects SET github_repo = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.repo, now, projectId);
  }
  if (input.token !== undefined) {
    database
      .prepare("UPDATE projects SET github_token = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.token, now, projectId);
  }
}

export function githubStatusesForProject(
  database: DatabaseSync,
  projectId: string,
): Map<string, PageGithubStatus> {
  const statuses = rows(
    database,
    "SELECT page_id, state, pr_number, pr_title, pr_url, checked_at FROM github_link_status WHERE project_id = ?",
    projectId,
  );
  return new Map(
    statuses.map((value) => [
      String(value.page_id),
      {
        state: String(value.state) as PageGithubStatus["state"],
        prNumber: value.pr_number === null ? null : Number(value.pr_number),
        prTitle: value.pr_title === null ? null : String(value.pr_title),
        prUrl: value.pr_url === null ? null : String(value.pr_url),
        checkedAt: value.checked_at === null ? null : String(value.checked_at),
      },
    ]),
  );
}

export function saveGithubStatus(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  status: PageGithubStatus,
): void {
  database
    .prepare(
      `INSERT INTO github_link_status (project_id, page_id, state, pr_number, pr_title, pr_url, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE
       SET state = excluded.state, pr_number = excluded.pr_number, pr_title = excluded.pr_title,
           pr_url = excluded.pr_url, checked_at = excluded.checked_at`,
    )
    .run(projectId, pageId, status.state, status.prNumber, status.prTitle, status.prUrl, status.checkedAt);
}

/** A link that is gone needs no cached answer about it. */
export function clearGithubStatus(database: DatabaseSync, projectId: string, pageId: string): void {
  database
    .prepare("DELETE FROM github_link_status WHERE project_id = ? AND page_id = ?")
    .run(projectId, pageId);
}
