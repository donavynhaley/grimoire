import type { DatabaseSync } from "node:sqlite";
import type { Chapter, ChapterState, Member } from "../../shared/types";
import type { MarkdownChapterStore, StoredChapter } from "../markdown-chapters";
import type { MarkdownPageStore, StoredPage } from "../markdown-pages";
import { slugify } from "../slug";
import { PageDependencyError, requireUnchangedContent } from "./errors";
import { membersForProject } from "./members";
import { projectById } from "./projects";
import { row } from "./rows";
import { findUserByEmail } from "./users";

// A project's chapters: the stretches of work its pages belong to, at most one open at a time.

export function chaptersEnabled(database: DatabaseSync, projectId: string): boolean {
  const project = row(database, "SELECT chapters_enabled FROM projects WHERE id = ?", projectId);
  return Number(project?.chapters_enabled ?? 0) === 1;
}

/**
 * Flips the per-project gate.
 *
 * Turning chapters off is deliberately not destructive: the chapter files stay on disk and
 * pages keep their `chapter` field, so the only thing that changes is whether the interface
 * draws any of it. Turning it back on restores exactly the prior state.
 */
export function setChaptersEnabled(database: DatabaseSync, projectId: string, enabled: boolean): boolean {
  const result = database
    .prepare("UPDATE projects SET chapters_enabled = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(enabled ? 1 : 0, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function chaptersForProject(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
): Chapter[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  return chapterStore.list(String(project.slug)).map((chapter) => publicChapter(database, chapter, members));
}

export function chapterSlugFromName(name: string): string {
  return slugify(name, 60);
}

export type ChapterInput = {
  name: string;
  description?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  state?: ChapterState;
};

export type CreateChapterResult = { chapter: Chapter } | "exists" | "invalid_name" | "already_open";

export function createChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  creatorId: string,
  input: ChapterInput,
): CreateChapterResult | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  if (!project || !creator) return null;
  const slug = chapterSlugFromName(input.name);
  if (!slug) return "invalid_name";
  const projectSlug = String(project.slug);
  const existing = chapterStore.list(projectSlug);
  if (existing.some((chapter) => chapter.slug === slug)) return "exists";
  const state = input.state ?? "planned";
  if (state === "open" && existing.some((chapter) => chapter.state === "open")) return "already_open";
  requireCoherentDates(input.startsOn ?? null, input.endsOn ?? null);

  const now = new Date().toISOString();
  const chapter: StoredChapter = {
    slug,
    name: input.name.trim(),
    description: input.description ?? "",
    state,
    position: existing.length,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    closedAt: state === "closed" ? now : null,
    carriedPages: null,
    carriedEstimate: null,
    carriedTo: null,
    deliveredPages: null,
    deliveredEstimate: null,
  };
  chapterStore.save(projectSlug, chapter);
  return { chapter: publicChapter(database, chapter, members) };
}

export type UpdateChapterResult = { chapter: Chapter } | "not_found" | "already_open";

/**
 * Edits one chapter, including its state.
 *
 * Two rules live here rather than in the interface. At most one chapter is open at a time,
 * which is what keeps the feature meaning "what are we working on now" instead of becoming a
 * grid of parallel workstreams; the caller is expected to close the current one first, as an
 * explicit act. And closing stamps `closedAt` while reopening clears it, mirroring how a
 * page's `completedAt` behaves - crucially, without touching a single page either way.
 */
export function updateChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
  input: Partial<ChapterInput> & { position?: number; expectedDescription?: string },
): UpdateChapterResult | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const current = chapterStore.get(projectSlug, slug);
  if (!current) return "not_found";
  requireUnchangedContent(
    { title: current.name, description: current.description },
    { expectedDescription: input.expectedDescription },
    publicChapter(database, current, membersForProject(database, projectId)),
    "chapter",
  );

  const nextState = input.state ?? current.state;
  if (nextState === "open" && current.state !== "open") {
    const conflict = chapterStore
      .list(projectSlug)
      .some((chapter) => chapter.slug !== slug && chapter.state === "open");
    if (conflict) return "already_open";
  }
  const startsOn = input.startsOn === undefined ? current.startsOn : input.startsOn;
  const endsOn = input.endsOn === undefined ? current.endsOn : input.endsOn;
  requireCoherentDates(startsOn, endsOn);

  const now = new Date().toISOString();
  const updated: StoredChapter = {
    ...current,
    name: input.name === undefined ? current.name : input.name.trim(),
    description: input.description ?? current.description,
    state: nextState,
    startsOn,
    endsOn,
    position: input.position ?? current.position,
    updatedAt: now,
    closedAt: nextState === "closed" ? (current.closedAt ?? now) : null,
  };
  chapterStore.save(projectSlug, updated);
  return { chapter: publicChapter(database, updated, membersForProject(database, projectId)) };
}

/**
 * Removes a chapter and clears it from every page that referenced it.
 *
 * This mirrors category deletion. It is the one genuinely lossy chapter operation, which is
 * why the interface names the affected count before asking.
 */
export function deleteChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const projectSlug = String(project.slug);
  if (!chapterStore.get(projectSlug, slug)) return false;
  // Pages are released before the chapter file goes: interrupted here, the chapter
  // still exists and a second delete finishes the job, rather than pages pointing at
  // a chapter that no longer does.
  const now = new Date().toISOString();
  pageStore.list(projectSlug).forEach((page) => {
    if (page.chapter !== slug) return;
    pageStore.save(projectSlug, { ...page, chapter: null, updatedAt: now });
  });
  chapterStore.remove(projectSlug, slug);
  return true;
}

/** How many pages a chapter would release if it were deleted. */
export function pagesInChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  slug: string,
): number {
  const project = projectById(database, projectId);
  if (!project) return 0;
  return pageStore.list(String(project.slug)).filter((page) => page.chapter === slug).length;
}

export function publicChapter(database: DatabaseSync, value: StoredChapter, members: Member[]): Chapter {
  const currentCreator = members.find(
    (member) => member.email.toLowerCase() === value.createdBy.toLowerCase(),
  );
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  return {
    slug: value.slug,
    name: value.name,
    description: value.description,
    state: value.state,
    position: value.position,
    startsOn: value.startsOn,
    endsOn: value.endsOn,
    createdById: historicalCreator ? String(historicalCreator.id) : "",
    createdByName: historicalCreator ? String(historicalCreator.name) : value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt,
    carriedPages: value.carriedPages,
    carriedEstimate: value.carriedEstimate,
    carriedTo: value.carriedTo,
    deliveredPages: value.deliveredPages,
    deliveredEstimate: value.deliveredEstimate,
  };
}

export function requireProjectChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
): void {
  const project = projectById(database, projectId);
  if (!project || !chapterStore.get(String(project.slug), slug)) {
    throw new PageDependencyError("This chapter is not part of the project", 400);
  }
}

/** A chapter may have neither date, either one, or both - but never an end before its start. */
function requireCoherentDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new PageDependencyError("A chapter cannot end before it starts", 400);
  }
}

/* ---------- closing a chapter, and what it leaves behind ---------- */

export type ChapterCloseResult =
  | { chapter: Chapter; carried: { pages: number; estimate: number; to: string | null } }
  | "not_found"
  | "already_closed"
  | "no_target";

/**
 * Closes a chapter and decides what happens to the work it did not finish.
 *
 * What is recorded is counted here rather than derived later: once the pages belong to the
 * next chapter, nothing about them still says they were carried out of this one.
 *
 * The chapter record is written before any page moves, and the writes share no
 * transaction - the filesystem has none to offer. An interruption therefore leaves a
 * correctly closed chapter whose carried pages have not all traveled yet; they sit in the
 * closed chapter, which is a state the board already supports, and `carriedTo` says where
 * each was headed. The other order could under-count what a finished stretch carried,
 * and a recorded total that lies is the worse leftover.
 *
 * `carryTo` names where unfinished work goes - another chapter, or null to set it loose.
 * Only unfinished pages move; a page finished inside this chapter stays in it, which is what
 * makes the delivered total mean what it says.
 */
export function closeChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
  carryTo: string | null | undefined,
): ChapterCloseResult {
  const project = projectById(database, projectId);
  if (!project) return "not_found";
  const projectSlug = String(project.slug);
  const chapters = chapterStore.list(projectSlug);
  const chapter = chapters.find((candidate) => candidate.slug === slug);
  if (!chapter) return "not_found";
  if (chapter.state === "closed") return "already_closed";
  if (carryTo && !chapters.some((candidate) => candidate.slug === carryTo && candidate.slug !== slug)) {
    return "no_target";
  }

  const pages = pageStore.list(projectSlug);
  const mine = pages.filter((page) => page.chapter === slug);
  const unfinished = mine.filter((page) => page.status !== "done");
  const delivered = mine.filter((page) => page.status === "done");
  const total = (group: StoredPage[]) => group.reduce((sum, page) => sum + (page.estimate ?? 0), 0);
  const carriedEstimate = total(unfinished);
  const now = new Date().toISOString();

  const closed: StoredChapter = {
    ...chapter,
    state: "closed",
    updatedAt: now,
    closedAt: now,
    carriedPages: unfinished.length,
    carriedEstimate,
    carriedTo: carryTo ?? null,
    // Both readings of what it delivered, counted now rather than recomputed later: pages
    // archived or re-placed after the fact must not rewrite a finished stretch's record.
    deliveredPages: delivered.length,
    deliveredEstimate: total(delivered),
  };
  chapterStore.save(projectSlug, closed);

  // Rollover is only a move when somewhere was named; "leave them here" closes over work
  // that keeps belonging to the chapter it was not finished in, which is also a fact worth
  // recording rather than a nothing.
  if (carryTo !== undefined) {
    for (const page of unfinished) {
      pageStore.save(projectSlug, { ...page, chapter: carryTo, updatedAt: now });
    }
  }
  return {
    chapter: publicChapter(database, closed, membersForProject(database, projectId)),
    carried: { pages: unfinished.length, estimate: carriedEstimate, to: carryTo ?? null },
  };
}

/** The chapter a rollover would reach for: the next planned one in reading order. */
export function nextChapterAfter(
  chapterStore: MarkdownChapterStore,
  projectSlug: string,
  slug: string,
): string | null {
  const planned = chapterStore
    .list(projectSlug)
    .filter((chapter) => chapter.state === "planned" && chapter.slug !== slug);
  return planned[0]?.slug ?? null;
}
