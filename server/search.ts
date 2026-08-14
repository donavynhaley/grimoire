import type { DatabaseSync } from "node:sqlite";
import type { CardStatus, IdeaState, SearchGroup, SearchHit, SearchResults } from "../shared/types";
import type { MarkdownCardStore, StoredCard } from "./markdown-cards";
import type { MarkdownChapterStore } from "./markdown-chapters";
import type { MarkdownIdeaStore } from "./markdown-ideas";
import { categoriesForProject, chaptersEnabled, membersForProject, projectById } from "./repository";

export const SEARCH_RESULT_LIMIT = 40;

/** How much note text to keep on either side of a body match. */
const SNIPPET_RADIUS = 44;

const columnNames: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

const ideaStateNames: Record<IdeaState, string> = {
  inbox: "Inbox",
  shortlist: "Shortlist",
  parked: "Parked",
};

const groupOrder: Record<SearchGroup, number> = {
  active: 0,
  backlog: 1,
  ideas: 2,
  done: 3,
  archived: 4,
};

type Ranked = { hit: SearchHit; rank: number; recency: string };

/**
 * Finds everything in one project that mentions the query.
 *
 * The board can only render four columns, so a match in the backlog, in the idea garden,
 * or in a card that was archived has nowhere to appear. This reads the same canonical
 * Markdown the board reads and answers for the whole project instead.
 *
 * Archived ideas are deliberately excluded: promoting an idea archives it and creates a
 * card with the same title, so including them would return every promotion twice.
 */
export function searchProject(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  chapterStore: MarkdownChapterStore,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  rawQuery: string,
  limit: number = SEARCH_RESULT_LIMIT,
): SearchResults {
  const query = rawQuery.trim();
  const needle = query.toLowerCase();
  if (!needle) return { query, total: 0, hits: [] };

  const project = projectById(database, projectId);
  if (!project) return { query, total: 0, hits: [] };
  const projectSlug = String(project.slug);

  const members = membersForProject(database, projectId);
  const categories = new Map(
    categoriesForProject(database, projectId).map((category) => [category.slug, category]),
  );
  const assigneeName = (email: string | null) =>
    members.find((member) => member.email.toLowerCase() === email?.toLowerCase())?.name ?? null;
  // A chapter is part of where a card lives, so a result names it beside its column - but
  // only for a project that actually uses chapters.
  const chapterNames = chaptersEnabled(database, projectId)
    ? new Map(chapterStore.list(projectSlug).map((chapter) => [chapter.slug, chapter.name]))
    : new Map<string, string>();
  const placeOf = (card: StoredCard, column: string) => {
    const chapter = card.chapter ? chapterNames.get(card.chapter) : undefined;
    return chapter ? `${column} · ${chapter}` : column;
  };

  const ranked: Ranked[] = [];

  const addCard = (card: StoredCard, group: SearchGroup, where: string) => {
    const rank = matchRank(card.title, card.description, needle);
    if (rank === null) return;
    const category = card.category ? categories.get(card.category) : undefined;
    ranked.push({
      rank,
      recency: card.updatedAt,
      hit: {
        kind: "card",
        group,
        id: card.id,
        title: card.title,
        snippet: snippetFor(card.description, needle),
        where,
        category: category?.name ?? card.category,
        categoryColor: category?.color ?? null,
        assigneeName: assigneeName(card.assignee),
      },
    });
  };

  for (const card of cardStore.list(projectSlug)) {
    if (card.status === "backlog") addCard(card, "backlog", placeOf(card, columnNames.backlog));
    else if (card.status === "done") addCard(card, "done", placeOf(card, completionLabel(card)));
    else addCard(card, "active", placeOf(card, columnNames[card.status]));
  }

  for (const card of cardStore.listArchived(projectSlug)) {
    addCard(card, "archived", card.archivedAt ? `Archived ${monthLabel(card.archivedAt)}` : "Archived");
  }

  for (const idea of ideaStore.list(projectSlug)) {
    const rank = matchRank(idea.title, idea.description, needle);
    if (rank === null) continue;
    ranked.push({
      rank,
      recency: idea.updatedAt,
      hit: {
        kind: "idea",
        group: "ideas",
        id: idea.id,
        title: idea.title,
        snippet: snippetFor(idea.description, needle),
        where: ideaStateNames[idea.state],
        category: null,
        categoryColor: null,
        assigneeName: null,
      },
    });
  }

  ranked.sort(compareRanked);
  return { query, total: ranked.length, hits: ranked.slice(0, limit).map((value) => value.hit) };
}

function compareRanked(left: Ranked, right: Ranked): number {
  const group = groupOrder[left.hit.group] - groupOrder[right.hit.group];
  if (group !== 0) return group;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return right.recency.localeCompare(left.recency);
}

/**
 * Scores how directly a record answers the query: a title that starts with it beats a
 * title that contains it, which beats a mention buried in the notes. `null` means no match.
 */
function matchRank(title: string, description: string, needle: string): number | null {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.startsWith(needle)) return 0;
  if (lowerTitle.includes(needle)) return 1;
  return description.toLowerCase().includes(needle) ? 2 : null;
}

function snippetFor(description: string, needle: string): string {
  const plain = plainText(description);
  const index = plain.toLowerCase().indexOf(needle);
  if (index < 0) return "";
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(plain.length, index + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${plain.slice(start, end).trim()}${end < plain.length ? "..." : ""}`;
}

/** Reduces Markdown notes to the words in them, so a snippet never shows syntax. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[>*+-]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function completionLabel(card: StoredCard): string {
  const completed = card.completedAt ?? card.updatedAt;
  return `Done ${monthLabel(completed)}`;
}

function monthLabel(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
