import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PAGE_STATUSES,
  type BoardWorkspace,
  type ChapterVelocity,
  type FieldValue,
  type Member,
  type Page,
  type PageCategory,
  type PageGithubLink,
  type PageGithubStatus,
  type PageStatus,
  type User,
} from "../../shared/types";
import {
  openThreadCount,
  openThreadCounts,
  unseenCount,
  unseenCounts,
  unseenMentionCount,
  unseenMentionCounts,
} from "../discussion";
import type { MarkdownChapterStore, StoredChapter } from "../markdown-chapters";
import type { MarkdownPageStore, StoredPage } from "../markdown-pages";
import { placeInOrder, renumber } from "../ordering";
import { categoriesForProject, requireProjectCategory } from "./categories";
import { publicChapter, requireProjectChapter } from "./chapters";
import { PageDependencyError, requireUnchangedContent } from "./errors";
import { fieldsForProject, mergePageFields } from "./fields";
import { githubStatusesForProject } from "./github";
import { membersForProject } from "./members";
import { listProjectsForUser, projectById, userOwnsProject } from "./projects";
import { row } from "./rows";
import { findUserByEmail } from "./users";

// The pages themselves: the board read, and every create, update, move,
// archive and restore of a page, with the dependency graph kept coherent.

export function getBoard(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  user: User,
  projectId: string,
): BoardWorkspace | null {
  const project = row(
    database,
    "SELECT id, name, slug, description, chapters_enabled, estimates_enabled, github_repo, github_token, discord_webhook, recap_on_close FROM projects WHERE id = ?",
    projectId,
  );
  if (!project) return null;

  const members = membersForProject(database, projectId);
  const pages = pageStore.list(String(project.slug));
  validateDependencyGraph(pages);
  const enabled = Number(project.chapters_enabled ?? 0) === 1;
  const estimatesOn = Number(project.estimates_enabled ?? 0) === 1;
  const githubStatuses = githubStatusesForProject(database, projectId);
  const openThreads = openThreadCounts(database, projectId);
  const unseen = unseenCounts(database, projectId, user.id);
  const mentioned = unseenMentionCounts(database, projectId, user.id);

  return {
    project: {
      id: String(project.id),
      name: String(project.name),
      description: String(project.description ?? ""),
      chaptersEnabled: enabled,
      githubRepo: String(project.github_repo ?? ""),
      // The token itself never rides the board payload; the interface only needs to know
      // whether one is held so settings can say "set" without saying what.
      githubTokenSet: String(project.github_token ?? "") !== "",
      estimatesEnabled: Number(project.estimates_enabled ?? 0) === 1,
      // The webhook itself stays on the server; the interface only needs to know one is held.
      discordWebhookSet: String(project.discord_webhook ?? "") !== "",
      recapOnClose: Number(project.recap_on_close ?? 1) === 1,
    },
    projects: listProjectsForUser(database, user),
    categories: categoriesForProject(database, projectId),
    fields: fieldsForProject(database, projectId),
    // A disabled project serves no chapters at all, so the interface has nothing to draw
    // even if files exist on disk from before the gate was turned off.
    chapters: enabled
      ? chapterStore.list(String(project.slug)).map((chapter) => publicChapter(database, chapter, members))
      : [],
    currentUser: user,
    viewerIsOwner: userOwnsProject(database, user, projectId),
    members,
    pages: pages.map((page) =>
      publicPage(database, projectId, page, members, githubStatuses, openThreads, {
        id: user.id,
        unseen,
        mentions: mentioned,
      }),
    ),
    // Chapters and estimates are separate gates, and velocity is the place they meet: it is
    // an estimate summed per chapter, so it needs both to mean anything.
    velocity:
      enabled && estimatesOn
        ? chapterStore.list(String(project.slug)).map((chapter) => velocityFor(chapter, pages))
        : [],
  };
}

/**
 * What one chapter delivered and what it still holds.
 *
 * Delivered counts pages finished while they belonged to this chapter, which is the only
 * honest reading once rollover exists: unfinished work moves onward, so a page that carried
 * over is counted by whichever chapter it was actually finished in. Pages nobody estimated
 * are counted separately rather than as zero, so an empty total can be told from an
 * unestimated one.
 */
function velocityFor(chapter: StoredChapter, pages: StoredPage[]): ChapterVelocity {
  const mine = pages.filter((page) => page.chapter === chapter.slug);
  const done = mine.filter((page) => page.status === "done");
  const open = mine.filter((page) => page.status !== "done");
  const total = (group: StoredPage[]) => group.reduce((sum, page) => sum + (page.estimate ?? 0), 0);
  // A closed chapter answers with the numbers it recorded as it closed. Anything else would
  // let later edits rewrite history: archive a delivered page and the stretch it was
  // delivered in would quietly claim less than it did.
  const recorded = chapter.deliveredPages !== null;
  return {
    slug: chapter.slug,
    donePages: recorded ? chapter.deliveredPages! : done.length,
    doneEstimate: recorded ? (chapter.deliveredEstimate ?? 0) : total(done),
    openPages: open.length,
    openEstimate: total(open),
    unestimatedPages: mine.filter((page) => page.estimate === null).length,
    recorded,
  };
}

/** Reads one page in the same shape the board serves, for before-and-after comparisons. */
export function findPage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const stored = pageStore.get(String(project.slug), pageId);
  if (!stored) return null;
  return publicPage(
    database,
    projectId,
    stored,
    membersForProject(database, projectId),
    githubStatusesForProject(database, projectId),
  );
}

export function listPages(database: DatabaseSync, pageStore: MarkdownPageStore, projectId: string): Page[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  const openThreads = openThreadCounts(database, projectId);
  return pageStore
    .list(String(project.slug))
    .map((page) => publicPage(database, projectId, page, members, undefined, openThreads));
}

type PageInput = {
  title: string;
  description?: string;
  category?: PageCategory | null;
  chapter?: string | null;
  /** A patch, not a replacement: `null` clears one field and absent keys are left alone. */
  fields?: Record<string, FieldValue | null>;
  blockedBy?: string[];
  status?: PageStatus;
  assigneeId?: string | null;
  /** The page's tie to GitHub: a parsed link to hold, or null to let go of one. */
  github?: PageGithubLink | null;
  /** How much work this is; null clears it. */
  estimate?: number | null;
};

export function createPage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  creatorId: string,
  input: PageInput,
): Page | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (!project || !creator || (input.assigneeId && !assignee)) return null;
  if (input.category) requireProjectCategory(database, projectId, input.category);
  if (input.chapter) requireProjectChapter(database, chapterStore, projectId, input.chapter);
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "backlog";
  const pages = pageStore.list(String(project.slug));
  const position = pages.filter((page) => page.status === status).length;
  const page: StoredPage = {
    id,
    title: input.title,
    description: input.description ?? "",
    category: input.category ?? null,
    chapter: input.chapter ?? null,
    fields: mergePageFields(fieldsForProject(database, projectId), {}, input.fields),
    blockedBy: input.blockedBy ?? [],
    unblockedPages: [],
    status,
    position,
    assignee: assignee?.email.toLowerCase() ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
    archivedAt: null,
    github: null,
    estimate: input.estimate ?? null,
  };
  validateDependencyGraph([...pages, page]);
  pageStore.save(String(project.slug), page);
  return publicPage(database, projectId, page, members);
}

export function updatePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  pageId: string,
  input: Partial<PageInput> & { position?: number; expectedTitle?: string; expectedDescription?: string },
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const members = membersForProject(database, projectId);
  const pages = pageStore.list(projectSlug);
  const current = pages.find((page) => page.id === pageId);
  if (!current) return null;
  requireUnchangedContent(current, input, publicPage(database, projectId, current, members), "page");
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (input.assigneeId && !assignee) return null;
  if (input.category) requireProjectCategory(database, projectId, input.category);
  if (input.chapter) requireProjectChapter(database, chapterStore, projectId, input.chapter);

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();
  const completedAt =
    nextStatus === "done"
      ? current.status === "done"
        ? (current.completedAt ?? current.updatedAt)
        : now
      : null;
  const updated: StoredPage = {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    category: input.category === undefined ? current.category : input.category,
    chapter: input.chapter === undefined ? current.chapter : input.chapter,
    fields: mergePageFields(fieldsForProject(database, projectId), current.fields, input.fields),
    blockedBy: input.blockedBy ?? current.blockedBy,
    status: nextStatus,
    assignee: input.assigneeId === undefined ? current.assignee : (assignee?.email.toLowerCase() ?? null),
    github: input.github === undefined ? current.github : input.github,
    estimate: input.estimate === undefined ? current.estimate : input.estimate,
    updatedAt: now,
    completedAt,
  };
  validateDependencyGraph(pages.map((page) => (page.id === pageId ? updated : page)));

  if (!shouldMove) {
    pageStore.save(projectSlug, updated);
    return publicPage(database, projectId, updated, members);
  }

  for (const status of PAGE_STATUSES) {
    const others = pages.filter((page) => page.id !== pageId && page.status === status);
    const ordered =
      status === nextStatus ? placeInOrder(others, updated, input.position ?? others.length) : others;
    const settled = renumber(ordered, (page) => pageStore.save(projectSlug, page), pageId);
    if (settled >= 0) updated.position = settled;
  }
  return publicPage(database, projectId, updated, members);
}

export function archivePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const projectSlug = String(project.slug);
  const current = pageStore.get(projectSlug, pageId);
  if (!current) return false;
  const pages = pageStore.list(projectSlug);
  const dependents = pages.filter((page) => page.id !== pageId && page.blockedBy.includes(pageId));
  if (current.status !== "done" && dependents.some((page) => page.status !== "done")) {
    throw new PageDependencyError("This page blocks active work and cannot be archived", 409);
  }
  const now = new Date().toISOString();
  dependents.forEach((page) => {
    pageStore.save(projectSlug, {
      ...page,
      blockedBy: page.blockedBy.filter((dependencyId) => dependencyId !== pageId),
      updatedAt: now,
    });
  });
  pageStore.archive(projectSlug, {
    ...current,
    unblockedPages: dependents.map((page) => page.id),
    archivedAt: now,
    updatedAt: now,
  });
  renumber(
    pageStore.list(projectSlug).filter((page) => page.status === current.status),
    (page) => pageStore.save(projectSlug, page),
  );
  return true;
}

export function restorePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const archived = pageStore.getArchived(projectSlug, pageId);
  if (!archived) return null;
  const pages = pageStore.list(projectSlug);
  const restored: StoredPage = {
    ...archived,
    unblockedPages: [],
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  const previouslyBlocked = new Set(archived.unblockedPages);
  const restoredPages = pages.map((page) =>
    previouslyBlocked.has(page.id)
      ? { ...page, blockedBy: [...page.blockedBy, restored.id], updatedAt: restored.updatedAt }
      : page,
  );
  validateDependencyGraph([...restoredPages, restored]);
  pageStore.restore(projectSlug, restored);

  restoredPages.forEach((page) => {
    const previous = pages.find((candidate) => candidate.id === page.id);
    if (previous && previous.blockedBy.length !== page.blockedBy.length) pageStore.save(projectSlug, page);
  });

  const ordered = placeInOrder(
    restoredPages.filter((page) => page.status === restored.status),
    restored,
    restored.position,
  );
  renumber(ordered, (page) => pageStore.save(projectSlug, page));
  restored.position = ordered.findIndex((page) => page.id === restored.id);
  return publicPage(database, projectId, restored, membersForProject(database, projectId));
}

function publicPage(
  database: DatabaseSync,
  projectId: string,
  value: StoredPage,
  members: Member[],
  githubStatuses?: Map<string, PageGithubStatus>,
  /*
   * Counted once for the whole board and handed down, because this is read on every board
   * load and a project of a few hundred pages should not pay a query per tile. A single page
   * read on its own counts for itself instead, so it is never quietly wrong.
   */
  openThreads?: Map<string, number>,
  /** Whose unread count this is. Absent where a read is not on anyone's behalf. */
  reader?: { id: string; unseen?: Map<string, number>; mentions?: Map<string, number> },
): Page {
  // Page files are edited outside Grimoire, so a name the project does not know is
  // ordinary weather, not corruption. An unknown assignee reads as unassigned and an
  // unknown creator keeps the written email as their name - throwing here would let
  // one odd file take the entire board down, since getBoard serializes every page.
  const assignee = value.assignee
    ? (members.find((member) => member.email.toLowerCase() === value.assignee?.toLowerCase()) ?? null)
    : null;
  const currentCreator = members.find(
    (member) => member.email.toLowerCase() === value.createdBy.toLowerCase(),
  );
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    category: value.category,
    chapter: value.chapter,
    fields: value.fields,
    blockedBy: value.blockedBy,
    status: value.status,
    position: value.position,
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    createdById: historicalCreator ? String(historicalCreator.id) : "",
    createdByName: historicalCreator ? String(historicalCreator.name) : value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
    estimate: value.estimate,
    github: value.github,
    githubStatus: value.github
      ? (githubStatuses?.get(value.id) ?? {
          state: "unchecked",
          prNumber: null,
          prTitle: null,
          prUrl: null,
          checkedAt: null,
        })
      : null,
    openThreads: openThreads
      ? (openThreads.get(value.id) ?? 0)
      : openThreadCount(database, projectId, value.id),
    unseenMessages: reader
      ? reader.unseen
        ? (reader.unseen.get(value.id) ?? 0)
        : unseenCount(database, projectId, value.id, reader.id)
      : 0,
    unseenMentions: reader
      ? reader.mentions
        ? (reader.mentions.get(value.id) ?? 0)
        : unseenMentionCount(database, projectId, value.id, reader.id)
      : 0,
  };
}

function validateDependencyGraph(pages: StoredPage[]): void {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  for (const page of pages) {
    if (new Set(page.blockedBy).size !== page.blockedBy.length) {
      throw new PageDependencyError("A blocking page can only be linked once");
    }
    for (const dependencyId of page.blockedBy) {
      if (dependencyId === page.id) throw new PageDependencyError("A page cannot block itself");
      if (!pagesById.has(dependencyId)) throw new PageDependencyError("A blocking page could not be found");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pageId: string) => {
    if (visiting.has(pageId)) throw new PageDependencyError("Page dependencies cannot form a cycle");
    if (visited.has(pageId)) return;
    visiting.add(pageId);
    for (const dependencyId of pagesById.get(pageId)?.blockedBy ?? []) visit(dependencyId);
    visiting.delete(pageId);
    visited.add(pageId);
  };
  for (const page of pages) visit(page.id);
}
