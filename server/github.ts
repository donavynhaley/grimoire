import type { DatabaseSync } from "node:sqlite";
import type { Page, PageGithubLink, PageGithubStatus } from "../shared/types";
import type { MarkdownChapterStore } from "./markdown-chapters";
import type { MarkdownPageStore } from "./markdown-pages";
import {
  projectById,
  projectGithubConfig,
  githubStatusesForProject,
  saveGithubStatus,
  updatePage,
} from "./repository";

/**
 * How a page keeps up with the work in GitHub.
 *
 * A page can hold a link to a pull request, or to a branch a pull request will eventually be
 * opened from. Grimoire polls the GitHub API for what those links point at and lets the board
 * follow the code: a page whose pull request is open moves into Review, and a page whose pull
 * request merged moves into Done.
 *
 * Polling, not webhooks, deliberately. A webhook needs a publicly reachable endpoint, a
 * secret, and a configuration step inside GitHub for every repository - three things a
 * self-hosted tool cannot assume. A token pasted into project settings is the whole setup,
 * works from behind any tunnel, and for a small team's linked pages the poll traffic is
 * noise. The interval is generous because nothing here is urgent: the merge already
 * happened; the board is only catching up with the truth.
 *
 * The automation only ever moves a page forward, and only along the two edges it owns
 * (into Review while a pull request is open, into Done once one merges). It never moves a
 * page backwards, so a hand that placed a page somewhere always wins over the robot that
 * would tidy it.
 */

/** What a page's link resolves to, said the way the rest of the product says it. */
export type ResolvedPullRequest = {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
};

/** The one seam the poller has on the outside world, so tests can be the outside world. */
export type GithubFetcher = (
  path: string,
  token: string,
) => Promise<{ status: number; body: unknown }>;

export const githubApiFetcher: GithubFetcher = async (path, token) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "grimoire",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

/**
 * Reads a pasted reference into a link.
 *
 * Accepted: a pull request URL, "#123" or "123", a branch URL (.../tree/name), or a bare
 * branch name. A URL names its own repository, which is kept when it differs from the
 * project's so a page may point across repositories; bare forms lean on the project's
 * configured one. Returns null for something unreadable.
 */
export function parseGithubReference(raw: string, projectRepo: string): PageGithubLink | null {
  const value = raw.trim();
  if (!value) return null;

  const pull = value.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  if (pull) {
    const repo = normalizeRepo(pull[1]!);
    return { kind: "pr", number: Number(pull[2]!), ...(repo !== projectRepo ? { repo } : {}) };
  }

  const tree = value.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/tree\/(.+)$/i);
  if (tree) {
    const repo = normalizeRepo(tree[1]!);
    const name = decodeURIComponent(tree[2]!).replace(/\/+$/, "");
    return { kind: "branch", name, ...(repo !== projectRepo ? { repo } : {}) };
  }

  const number = value.match(/^#?(\d+)$/);
  if (number) return projectRepo ? { kind: "pr", number: Number(number[1]) } : null;

  // Anything left that looks like a git branch name is one. A bare name needs the
  // project's repository to mean anything.
  if (!projectRepo) return null;
  if (!/^[\w][\w\-./]{0,199}$/.test(value) || value.includes("..")) return null;
  return { kind: "branch", name: value };
}

export function normalizeRepo(value: string): string {
  return value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

function prState(pr: { state?: string; merged_at?: string | null; draft?: boolean }): ResolvedPullRequest["state"] {
  if (pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

function asResolved(pr: Record<string, unknown>): ResolvedPullRequest {
  return {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    url: String(pr.html_url ?? ""),
    state: prState(pr as { state?: string; merged_at?: string | null; draft?: boolean }),
  };
}

/** Asks GitHub about one link. Returns null when nothing answers to it. */
export async function resolveLink(
  fetcher: GithubFetcher,
  repo: string,
  token: string,
  link: PageGithubLink,
): Promise<ResolvedPullRequest | null> {
  const target = normalizeRepo(link.repo ?? repo);
  if (!target) return null;
  if (link.kind === "pr") {
    const { status, body } = await fetcher(`/repos/${target}/pulls/${link.number}`, token);
    if (status !== 200 || !body) return null;
    return asResolved(body as Record<string, unknown>);
  }
  // A branch resolves through whichever pull request has it as its head; the newest wins
  // when a branch has been through several.
  const owner = target.split("/")[0];
  const query = `?head=${encodeURIComponent(`${owner}:${link.name}`)}&state=all&sort=created&direction=desc&per_page=1`;
  const { status, body } = await fetcher(`/repos/${target}/pulls${query}`, token);
  if (status !== 200 || !Array.isArray(body) || body.length === 0) return null;
  return asResolved(body[0] as Record<string, unknown>);
}

type SyncDependencies = {
  database: DatabaseSync;
  pageStore: MarkdownPageStore;
  chapterStore: MarkdownChapterStore;
  fetcher: GithubFetcher;
  /** Runs after a page auto-moves, with everything the audit log wants to say about it. */
  onMoved: (input: { projectId: string; page: Page; from: string; to: "review" | "done" }) => void;
  /** Runs when any cached status changed, so open boards can be told to look again. */
  onChanged: (projectId: string) => void;
};

/** Every linked page in one project, brought up to date with GitHub. */
export async function syncProjectGithub(deps: SyncDependencies, projectId: string): Promise<void> {
  const { database, pageStore, chapterStore, fetcher } = deps;
  const config = projectGithubConfig(database, projectId);
  const project = projectById(database, projectId);
  if (!project) return;
  const pages = pageStore.list(String(project.slug));
  const cached = githubStatusesForProject(database, projectId);
  let changed = false;

  for (const page of pages) {
    if (!page.github) continue;
    const before = cached.get(page.id);
    // A merged page in Done has arrived; asking GitHub about it again earns nothing.
    if (page.status === "done" && before?.state === "merged") continue;
    // Without a repository to ask, a bare link stays politely unchecked.
    if (!normalizeRepo(page.github.repo ?? config.repo)) continue;

    const resolved = await resolveLink(fetcher, config.repo, config.token, page.github);
    const next: PageGithubStatus = resolved
      ? {
        state: resolved.state,
        prNumber: resolved.number,
        prTitle: resolved.title,
        prUrl: resolved.url,
        checkedAt: new Date().toISOString(),
      }
      : {
        state: page.github.kind === "branch" ? "unchecked" : "missing",
        prNumber: null,
        prTitle: null,
        prUrl: null,
        checkedAt: new Date().toISOString(),
      };

    if (statusDiffers(before, next)) changed = true;
    saveGithubStatus(database, projectId, page.id, next);

    // The two edges the automation owns, and each fires on the *transition*, not the state:
    // a page moves when GitHub's answer changes, never merely because it still holds. A hand
    // that pulled a page back out of Review while its pull request stayed open has decided
    // something, and a robot that re-filed it every two minutes would be unbearable.
    const to = resolved?.state === "merged" && before?.state !== "merged" && page.status !== "done"
      ? "done" as const
      : (resolved?.state === "open" && before?.state !== "open" &&
          (page.status === "backlog" || page.status === "ready" || page.status === "in_progress"))
        ? "review" as const
        : null;
    if (to) {
      const moved = updatePage(database, pageStore, chapterStore, projectId, page.id, { status: to });
      if (moved) deps.onMoved({ projectId, page: moved, from: page.status, to });
      changed = true;
    }
  }

  if (changed) deps.onChanged(projectId);
}

function statusDiffers(before: PageGithubStatus | undefined, next: PageGithubStatus): boolean {
  return before?.state !== next.state || before?.prNumber !== next.prNumber || before?.prTitle !== next.prTitle;
}

export type RepoVerification =
  | { ok: true; repo: string; private: boolean }
  | { ok: false; reason: "no_repo" | "unauthorized" | "not_found" | "unreachable"; message: string };

/**
 * Asks GitHub whether the configured repository answers to the configured token.
 *
 * The one wrinkle worth explaining to a person: GitHub answers 404, not 403, for a private
 * repository the caller cannot see, so "not found" here usually means the token - not the
 * name - is what is wrong.
 */
export async function verifyRepoAccess(
  fetcher: GithubFetcher,
  repo: string,
  token: string,
): Promise<RepoVerification> {
  const target = normalizeRepo(repo);
  if (!target) return { ok: false, reason: "no_repo", message: "Name a repository first, as owner/name." };
  try {
    const { status, body } = await fetcher(`/repos/${target}`, token);
    if (status === 200 && body) {
      return { ok: true, repo: target, private: Boolean((body as Record<string, unknown>).private) };
    }
    if (status === 401) {
      return { ok: false, reason: "unauthorized", message: "GitHub refused the token. It may be expired or mistyped." };
    }
    return {
      ok: false,
      reason: "not_found",
      message: token
        ? "GitHub cannot see that repository with this token. Check the name, and that the token was granted this repository."
        : "GitHub cannot see that repository. If it is private, it needs a token.",
    };
  } catch {
    return { ok: false, reason: "unreachable", message: "GitHub could not be reached from the server." };
  }
}

/** One line in the picker: enough to recognise a pull request, nothing more. */
export type OpenPullRequest = {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft";
  branch: string;
  author: string;
};

/**
 * The pull requests someone might plausibly be linking to: open ones, drafts included.
 *
 * Merged and closed pull requests are left out on purpose. A page is linked while the work
 * is live, and a list that carried every pull request the repository ever had would bury
 * the handful that matter under history.
 *
 * The answer is cached briefly because this is asked while a person types. GitHub's own
 * rate limit is generous, but a request per keystroke is rude to it and slow for them.
 */
const openPullRequestCache = new Map<string, { at: number; items: OpenPullRequest[] }>();
const OPEN_PR_CACHE_MS = 30_000;

export async function listOpenPullRequests(
  fetcher: GithubFetcher,
  repo: string,
  token: string,
  now: number = Date.now(),
): Promise<OpenPullRequest[]> {
  const target = normalizeRepo(repo);
  if (!target) return [];
  const cached = openPullRequestCache.get(target);
  if (cached && now - cached.at < OPEN_PR_CACHE_MS) return cached.items;

  const { status, body } = await fetcher(`/repos/${target}/pulls?state=open&sort=updated&direction=desc&per_page=50`, token);
  if (status !== 200 || !Array.isArray(body)) return cached?.items ?? [];
  const items = (body as Array<Record<string, unknown>>).map((pr) => ({
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    url: String(pr.html_url ?? ""),
    state: pr.draft ? "draft" as const : "open" as const,
    branch: String((pr.head as Record<string, unknown> | undefined)?.ref ?? ""),
    author: String((pr.user as Record<string, unknown> | undefined)?.login ?? ""),
  }));
  openPullRequestCache.set(target, { at: now, items });
  return items;
}

/** Lets a project that just changed its repository or token ask again immediately. */
export function forgetOpenPullRequests(repo: string): void {
  openPullRequestCache.delete(normalizeRepo(repo));
}
