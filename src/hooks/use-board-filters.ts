import { useEffect, useMemo, useState } from "react";
import type { BoardWorkspace, Chapter, Page, PageStatus, ProjectCategory } from "../../shared/types";
import { type ChapterFilter, NO_CHAPTER } from "../components/ChapterPicker";
import {
  decodeFacets,
  encodeFacets,
  type FacetContext,
  type FacetSelection,
  facetPredicate,
} from "../lib/page-facets";
import { compareCompletion } from "../lib/page-order";

export const BOARD_STATUSES = [
  "ready",
  "in_progress",
  "review",
  "done",
] as const satisfies readonly PageStatus[];

/**
 * Done is a hybrid column: it reads like the other three until it outgrows them, then it
 * grows a backlog-style escape hatch instead of scrolling forever. Board filters run over
 * every page before this slice, so a match buried deep in the history still surfaces here.
 */
export const DONE_COLUMN_LIMIT = 10;

export function comparePosition(left: Page, right: Page): number {
  return left.position - right.position;
}

export type BoardFilters = {
  query: string;
  people: Set<string>;
  facets: FacetSelection;
  chapter: ChapterFilter;
  selectedChapter: Chapter | undefined;
  facetContext: FacetContext;
  categoriesBySlug: Map<string, ProjectCategory>;
  categoryName: (slug: string | null) => string;
  normalizedQuery: string;
  /** The board as the bar's own controls leave it, before the filter panel has its say. */
  pagesBeforeFacets: Page[];
  filteredPages: Page[];
  pagesByStatus: Record<(typeof BOARD_STATUSES)[number], Page[]>;
  changeQuery: (value: string) => void;
  togglePerson: (id: string) => void;
  changeFacets: (next: FacetSelection) => void;
  changeChapter: (value: ChapterFilter) => void;
};

/**
 * Everything the board can be narrowed by - search, people, facets, chapter - seeded from
 * the URL and written back to it from the setters, so the address bar is always a shareable
 * link to the filtered view on screen.
 */
export function useBoardFilters(board: BoardWorkspace): BoardFilters {
  const initialParams = useMemo(() => new URLSearchParams(location.search), []);
  const [query, setQuery] = useState(() => initialParams.get("q") ?? "");
  const [people, setPeople] = useState<Set<string>>(
    () => new Set((initialParams.get("people") ?? "").split(",").filter(Boolean)),
  );
  const [facets, setFacets] = useState<FacetSelection>(() => decodeFacets(initialParams.get("filters")));
  /**
   * The clock the "last changed" buckets are read against, taken once per board rather than per
   * render, so a page cannot cross from "today" into "this week" between two paints of the same
   * list. A refetch is a new board and a fresh reading, which is often enough.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: board.pages is the trigger, not an input: a refetch is a new board and should be a fresh reading of the clock, as the comment above says
  const facetContext = useMemo<FacetContext>(
    () => ({
      categories: board.categories,
      fields: board.fields,
      estimatesEnabled: board.project.estimatesEnabled,
      now: new Date(),
    }),
    [board.categories, board.fields, board.pages, board.project.estimatesEnabled],
  );
  const chaptersOn = board.project.chaptersEnabled;
  /**
   * With no chapter named in the URL the board opens on the one that is open, so arriving
   * lands on what the team is working on now. With nothing open it falls back to all work,
   * and the picker always offers "All work" so this can never hide the project.
   */
  const [chapter, setChapter] = useState<ChapterFilter>(() => {
    if (!chaptersOn) return null;
    const requested = initialParams.get("chapter");
    if (requested === NO_CHAPTER) return NO_CHAPTER;
    if (requested && board.chapters.some((value) => value.slug === requested)) return requested;
    if (requested) return null;
    return board.chapters.find((value) => value.state === "open")?.slug ?? null;
  });
  const selectedChapter =
    chapter === null || chapter === NO_CHAPTER
      ? undefined
      : board.chapters.find((value) => value.slug === chapter);
  // A chapter that was deleted, or a gate switched off, must not leave the board filtered
  // to something the reader can no longer see or reach.
  useEffect(() => {
    if (chapter === null || chapter === NO_CHAPTER) return;
    if (!chaptersOn || !board.chapters.some((value) => value.slug === chapter)) setChapter(null);
  }, [board.chapters, chapter, chaptersOn]);

  const categoriesBySlug = useMemo(
    () => new Map(board.categories.map((category) => [category.slug, category])),
    [board.categories],
  );
  const categoryName = (slug: string | null) =>
    slug === null ? "uncategorized" : (categoriesBySlug.get(slug)?.name ?? slug);
  const normalizedQuery = query.trim().toLowerCase();
  const chaptersBySlug = useMemo(
    () => new Map(board.chapters.map((value) => [value.slug, value])),
    [board.chapters],
  );
  const chapterName = (slug: string | null) =>
    slug === null ? "no chapter" : (chaptersBySlug.get(slug)?.name ?? slug);
  /**
   * The panel counts against this rather than the finished list, because a facet count answers
   * "how many pages would I have if I ticked this" - it has to see the pages its own section is
   * currently hiding, while still respecting the chapter, the people, and the search.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: categoryName and chapterName are redefined every render, so the list names the stable Maps they close over instead; depending on the functions would defeat the memo entirely
  const pagesBeforeFacets = useMemo(
    () =>
      board.pages.filter((page) => {
        if (chapter === NO_CHAPTER && page.chapter !== null) return false;
        if (chapter !== null && chapter !== NO_CHAPTER && page.chapter !== chapter) return false;
        if (people.size > 0 && !people.has(page.assigneeId ?? "unassigned")) return false;
        if (
          normalizedQuery &&
          !`${page.title}\n${page.description}\n${categoryName(page.category)}\n${chapterName(page.chapter)}\n${page.assigneeName ?? "unassigned"}`
            .toLowerCase()
            .includes(normalizedQuery)
        )
          return false;
        return true;
      }),
    [board.pages, categoriesBySlug, chapter, chaptersBySlug, normalizedQuery, people],
  );
  const matchesFacets = useMemo(() => facetPredicate(facets, facetContext), [facetContext, facets]);
  const filteredPages = useMemo(
    () => pagesBeforeFacets.filter(matchesFacets),
    [matchesFacets, pagesBeforeFacets],
  );

  const pagesByStatus = useMemo(
    () =>
      Object.fromEntries(
        BOARD_STATUSES.map((status) => [
          status,
          filteredPages
            .filter((page) => page.status === status)
            .sort(status === "done" ? compareCompletion : comparePosition)
            .slice(0, status === "done" ? DONE_COLUMN_LIMIT : undefined),
        ]),
      ) as Record<(typeof BOARD_STATUSES)[number], Page[]>,
    [filteredPages],
  );

  useEffect(() => {
    if (!initialParams.has("focus")) return;
    initialParams.delete("focus");
    history.replaceState({}, "", `${location.pathname}${initialParams.size ? `?${initialParams}` : ""}`);
  }, [initialParams]);

  const updateUrl = (
    nextQuery: string,
    nextPeople: Set<string>,
    nextChapter: ChapterFilter,
    nextFacets: FacetSelection = facets,
  ) => {
    const params = new URLSearchParams(location.search);
    params.delete("focus");
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    else params.delete("q");
    if (nextPeople.size) params.set("people", [...nextPeople].join(","));
    else params.delete("people");
    if (nextChapter) params.set("chapter", nextChapter);
    else params.delete("chapter");
    const encoded = encodeFacets(nextFacets);
    if (encoded) params.set("filters", encoded);
    else params.delete("filters");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const changeFacets = (next: FacetSelection) => {
    setFacets(next);
    updateUrl(query, people, chapter, next);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    updateUrl(value, people, chapter);
  };

  const togglePerson = (id: string) => {
    const next = new Set(people);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPeople(next);
    updateUrl(query, next, chapter);
  };

  const changeChapter = (value: ChapterFilter) => {
    setChapter(value);
    updateUrl(query, people, value);
  };

  return {
    query,
    people,
    facets,
    chapter,
    selectedChapter,
    facetContext,
    categoriesBySlug,
    categoryName,
    normalizedQuery,
    pagesBeforeFacets,
    filteredPages,
    pagesByStatus,
    changeQuery,
    togglePerson,
    changeFacets,
    changeChapter,
  };
}
