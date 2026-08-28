import { type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  type AuditPage,
  type AwayState,
  type BoardWorkspace,
  type DiscussionThread,
  type Page,
  type PageStatus,
  type IdeaState,
  type IdeaWorkspace,
  type ProjectRole,
  PAGE_STATUS_LABELS,
} from "../../shared/types";
import { AccountDialog } from "./AccountDialog";
import { ActivityDialog } from "./ActivityDialog";
import { Avatar } from "./Avatar";
import { AwayDigest } from "./AwayDigest";
import { BacklogDialog } from "./BacklogDialog";
import { PageDialog } from "./PageDialog";
import { type CategoryActions } from "./CategoriesSection";
import { type FieldActions } from "./FieldsSection";
import { PageFieldChips } from "./PageFields";
import { PageFilters } from "./PageFilters";
import {
  decodeFacets,
  encodeFacets,
  facetPredicate,
  type FacetContext,
  type FacetSelection,
} from "../lib/page-facets";
import { type ChapterActions } from "./ChaptersSection";
import { type ChapterFilter, ChapterPicker, NO_CHAPTER } from "./ChapterPicker";
import { chapterWhen } from "../lib/chapter-dates";
import { DoneHistoryDialog } from "./DoneHistoryDialog";
import { type ProjectActions, ProjectMenu } from "./ProjectMenu";
import {
  type ProjectSettingsActions,
  ProjectSettingsDialog,
  type SettingsSection,
  settingsSectionsFor,
} from "./ProjectSettingsDialog";
import { type CapturePageInput, QuickCapture } from "./QuickCapture";
import { SearchDialog } from "./SearchDialog";
import { categoryColorStyle } from "../lib/category-style";
import { plainTextFromMarkdown } from "../lib/markdown-text";
import { compareCompletion } from "../lib/page-order";
import { IdeasBoard } from "./IdeasBoard";
import { useFlip } from "../hooks/use-flip";
import { type DragPoint, gapIndexIn, pointWithin, usePointerDrag } from "../hooks/use-pointer-drag";
import packageJson from "../../package.json";

const BOARD_STATUSES = ["ready", "in_progress", "review", "done"] as const satisfies readonly PageStatus[];

/**
 * Done is a hybrid column: it reads like the other three until it outgrows them, then it
 * grows a backlog-style escape hatch instead of scrolling forever. Board filters run over
 * every page before this slice, so a match buried deep in the history still surfaces here.
 */
const DONE_COLUMN_LIMIT = 10;

const columnNames = PAGE_STATUS_LABELS;

type Props = {
  away: AwayState | null;
  board: BoardWorkspace;
  busy: boolean;
  categoryActions: CategoryActions;
  fieldActions: FieldActions;
  chapterActions: ChapterActions;
  ideas: IdeaWorkspace | null;
  online: ReadonlySet<string>;
  projectActions: ProjectActions;
  projectSettingsActions: ProjectSettingsActions;
  revision: number;
  view: "work" | "ideas";
  onCreate: (input: CapturePageInput) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onAddMember: (email: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onCreateIdea: (input: { title: string }) => Promise<void>;
  onLoadActivity: (options: { entityId?: string; before?: number; limit?: number }) => Promise<AuditPage>;
  onLoadDiscussion: (pageId: string) => Promise<{ threads: DiscussionThread[] }>;
  onAsk: (pageId: string, body: string) => Promise<void>;
  onReply: (pageId: string, threadId: string, body: string) => Promise<void>;
  onSetAnswered: (pageId: string, threadId: string, answered: boolean) => Promise<void>;
  onSeeDiscussion: (pageId: string) => Promise<void>;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangeName: (name: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onLogout: () => Promise<void>;
  onMoveBacklogToNext: (id: string) => Promise<void>;
  onPromoteIdea: (id: string) => Promise<void>;
  onChangeMemberRole: (id: string, role: ProjectRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onRestorePage: (id: string) => Promise<void>;
  /** Puts a board-surface failure on the global banner; dialog failures stay in the dialog. */
  onSurfaceError: (message: string) => void;
  onUpdateIdea: (id: string, input: Record<string, unknown>) => Promise<void>;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

export function Board({
  away,
  board,
  busy,
  categoryActions,
  chapterActions,
  fieldActions,
  ideas,
  online,
  projectActions,
  projectSettingsActions,
  revision,
  view,
  onCreate,
  onUpdate,
  onArchive,
  onAddMember,
  onCreateInvite,
  onCreateIdea,
  onChangeAvatar,
  onChangeName,
  onChangePassword,
  onLoadActivity,
  onLoadDiscussion,
  onAsk,
  onReply,
  onSetAnswered,
  onSeeDiscussion,
  onLogout,
  onMoveBacklogToNext,
  onPromoteIdea,
  onRemoveAvatar,
  onChangeMemberRole,
  onRemoveMember,
  onRestorePage,
  onSurfaceError,
  onUpdateIdea,
  onViewChange,
}: Props) {
  const [addingTo, setAddingTo] = useState<PageStatus | null>(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    // A link shared before the rename says `card`; it still opens the right page, and the
    // effect below rewrites the address bar to the current spelling.
    () => {
      const params = new URLSearchParams(location.search);
      return params.get("page") ?? params.get("card");
    },
  );
  const [drag, setDrag] = useState<{ id: string; height: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ status: PageStatus; index: number } | null>(null);
  /**
   * The page picked up by tap or key rather than carried by a pointer.
   *
   * Dragging is a gesture some people cannot make and some devices cannot report. Lifting a
   * page into this state turns every gap on the board into an ordinary button, which is the
   * same move performed with one tap, or with Tab and Enter, and it is the only way a
   * keyboard has ever been able to reorder this board at all.
   */
  const [moving, setMoving] = useState<string | null>(null);
  const columnNodes = useRef(new Map<PageStatus, HTMLElement>());
  const backlogNode = useRef<HTMLButtonElement>(null);
  const [flight, setFlight] = useState<CaptureFlight | null>(null);
  const [landed, setLanded] = useState<PageStatus | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<HTMLDivElement>(null);
  const kanbanRef = useRef<HTMLDivElement>(null);
  useFlip(kanbanRef);
  const [accountOpen, setAccountOpen] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Bumped so choosing the same idea twice still reopens it in the garden.
  const [openIdea, setOpenIdea] = useState<{ id: string; token: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  // Once the history has been opened, its badge has done its job for this visit.
  const [activityVisited, setActivityVisited] = useState(false);
  const [awayDismissed, setAwayDismissed] = useState(false);
  // Pages the reader has opened this visit; their dots have been answered.
  const [openedUnseen, setOpenedUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const isOwner = board.viewerIsOwner;

  // Which settings section is open lives in the URL, so a reload - or the remount a project
  // switch causes - reopens exactly where the reader was, and a link can point at a section.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(() => {
    const requested = new URLSearchParams(location.search).get("settings");
    return (
      settingsSectionsFor(board.viewerIsOwner, board.currentUser.role === "admin") as readonly string[]
    ).includes(requested ?? "")
      ? (requested as SettingsSection)
      : null;
  });
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (settingsSection) params.set("settings", settingsSection);
    else params.delete("settings");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [settingsSection]);
  const unseenCount = away && !awayDismissed && !activityVisited ? away.total : 0;
  const unseenPageIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "page" && event.entityId && !openedUnseen.has(event.entityId))
        ids.add(event.entityId);
    }
    return ids;
  }, [away, awayDismissed, openedUnseen]);
  const unseenIdeaIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "idea" && event.entityId) ids.add(event.entityId);
    }
    return ids;
  }, [away, awayDismissed]);
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
  const selectedPage = board.pages.find((page) => page.id === selectedId) ?? null;
  const movingPage = moving ? (board.pages.find((page) => page.id === moving) ?? null) : null;

  // A page put down by tap is put down by Escape too, the same key that calls off a drag.
  useEffect(() => {
    if (!moving) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMoving(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [moving]);

  // Opening a page answers its dot, whichever surface the page was opened from.
  useEffect(() => {
    if (!selectedId) return;
    setOpenedUnseen((current) => {
      if (current.has(selectedId)) return current;
      const next = new Set(current);
      next.add(selectedId);
      return next;
    });
  }, [selectedId]);

  // The open page lives in the URL, so the address bar is always a shareable
  // link to exactly what is on screen. A link to a page this board no longer
  // has simply falls away.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.delete("card");
    if (selectedPage) params.set("page", selectedPage.id);
    else params.delete("page");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [selectedPage?.id]);
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
   * The board as the bar's own controls leave it, before the filter panel has its say.
   *
   * The panel counts against this rather than the finished list, because a facet count answers
   * "how many pages would I have if I ticked this" - it has to see the pages its own section is
   * currently hiding, while still respecting the chapter, the people, and the search.
   */
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
  const activeCount = filteredPages.filter(
    (page) => page.status === "ready" || page.status === "in_progress" || page.status === "review",
  ).length;
  const backlogPages = board.pages.filter((page) => page.status === "backlog");
  const completedPages = board.pages.filter((page) => page.status === "done");
  const offBoardMatches = useMemo(
    () => ({
      backlog: filteredPages.filter((page) => page.status === "backlog").length,
      completed: Math.max(
        0,
        filteredPages.filter((page) => page.status === "done").length - DONE_COLUMN_LIMIT,
      ),
    }),
    [filteredPages],
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

  useEffect(() => {
    const runShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      // An open dialog owns the keyboard: a board shortcut fired underneath one would
      // act on a surface the reader cannot see.
      if (document.querySelector(".modal-backdrop")) return;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) {
        const isEmptyCapture =
          target instanceof HTMLInputElement &&
          (target.id === "quick-page" || target.id === "capture-idea") &&
          target.value.length === 0;
        if (event.key.toLowerCase() === "b" || !isEmptyCapture) return;
      }
      // Search reaches the whole project, so it answers from either workspace.
      if (event.key === "/") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "b" && view === "work") {
        event.preventDefault();
        setBacklogOpen(true);
        return;
      }
      const nextView = event.key === "1" ? "work" : event.key === "2" ? "ideas" : null;
      if (!nextView) return;
      event.preventDefault();
      void onViewChange(nextView);
    };
    window.addEventListener("keydown", runShortcut);
    return () => window.removeEventListener("keydown", runShortcut);
  }, [onViewChange, view]);

  const openPageFromSearch = (id: string) => {
    setSearchOpen(false);
    setBacklogOpen(false);
    setHistoryOpen(false);
    if (view === "ideas") void onViewChange("work");
    setSelectedId(id);
  };

  const openIdeaFromSearch = (id: string) => {
    setSearchOpen(false);
    setOpenIdea({ id, token: Date.now() });
    if (view !== "ideas") void onViewChange("ideas");
  };

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

  /**
   * Promotes a chapter to the current one, closing whichever is open first.
   *
   * One chapter is open at a time, so this is two writes that read as a single decision. The
   * board follows the promotion, because saying "this is what we are working on now" and then
   * being left looking at something else would be a strange place to land.
   */
  const makeChapterCurrent = async (slug: string) => {
    try {
      const open = board.chapters.find((value) => value.state === "open");
      if (open && open.slug !== slug) await chapterActions.update(open.slug, { state: "closed" });
      await chapterActions.update(slug, { state: "open" });
      changeChapter(slug);
    } catch (value) {
      // Promotion runs from the board, not a dialog, so its refusal belongs on the banner.
      onSurfaceError(value instanceof Error ? value.message : "The chapter could not be opened");
    }
  };

  const spawnFlight = (input: CapturePageInput) => {
    const shell = shellRef.current;
    if (!shell) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setLanded(input.status);
      return;
    }
    const home = shell.querySelector(".workspace-capture");
    const target =
      input.status === "backlog"
        ? shell.querySelector(".library-trigger")
        : shell.querySelector(`.column-${input.status}`);
    if (!home || !target) {
      setLanded(input.status);
      return;
    }
    const from = home.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    setFlight({
      id: Date.now(),
      title: input.title,
      status: input.status,
      from: { x: from.left, y: from.top, width: Math.min(from.width, 280) },
      to: { x: to.left + to.width / 2, y: to.top + Math.min(to.height / 2, 40) },
    });
  };

  useEffect(() => {
    if (!flight) return;
    const node = flightRef.current;
    if (!node || typeof node.animate !== "function") {
      setFlight(null);
      setLanded(flight.status);
      return;
    }
    const chip = node.getBoundingClientRect();
    const dx = flight.to.x - (chip.left + chip.width / 2);
    const dy = flight.to.y - (chip.top + chip.height / 2);
    const animation = node.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.3 },
      ],
      { duration: 480, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
    const finish = () => {
      setFlight(null);
      setLanded(flight.status);
    };
    animation.addEventListener("finish", finish);
    return () => {
      animation.removeEventListener("finish", finish);
      animation.cancel();
    };
  }, [flight]);

  useEffect(() => {
    if (!landed) return;
    const timeout = window.setTimeout(() => setLanded(null), 700);
    return () => window.clearTimeout(timeout);
  }, [landed]);

  const capturePage = async (input: CapturePageInput) => {
    spawnFlight(input);
    await onCreate(input);
  };

  const createColumnPage = async (event: FormEvent, status: PageStatus) => {
    event.preventDefault();
    const title = columnTitle.trim();
    if (!title) return;
    setColumnTitle("");
    setAddingTo(null);
    // Adding straight into a column while looking at a chapter lands the page in that
    // chapter, because that is plainly where the reader meant to put it.
    const intoChapter = chaptersOn && chapter !== null && chapter !== NO_CHAPTER ? chapter : null;
    await onCreate({ title, category: null, chapter: intoChapter, assigneeId: null, status });
  };

  const finishDrag = () => {
    setDrag(null);
    setDropHint(null);
  };

  /**
   * Which gap on the board a point is asking for.
   *
   * The Backlog control answers first: it overlaps nothing, and a page released on it is
   * leaving the board rather than being placed within a column.
   */
  const hintAt = (point: DragPoint): { status: PageStatus; index: number } | null => {
    const backlog = backlogNode.current?.getBoundingClientRect();
    if (backlog && pointWithin(backlog, point)) return { status: "backlog", index: 0 };
    for (const status of BOARD_STATUSES) {
      const node = columnNodes.current.get(status);
      if (!node || !pointWithin(node.getBoundingClientRect(), point)) continue;
      return { status, index: gapIndexIn(node, "article.board-page:not(.drag-hidden)", point.y) };
    }
    return null;
  };

  /**
   * Where a page lands in its column's real order, given the gap it was dropped into.
   *
   * The hint counts the gaps the reader can see, and Done only ever shows its most recent
   * few, so the visible gap is translated through the page it sits above before it becomes
   * a position. Without that step a drop into a filtered column would renumber the pages
   * hidden behind the filter.
   */
  const positionFor = (
    id: string,
    status: PageStatus,
    hint: { status: PageStatus; index: number } | null,
  ) => {
    const column = board.pages.filter((page) => page.status === status).sort(comparePosition);
    const without = column.filter((page) => page.id !== id);
    if (!hint || hint.status !== status || status === "backlog") return { column, position: without.length };
    const visibleBase = pagesByStatus[status as (typeof BOARD_STATUSES)[number]].filter(
      (page) => page.id !== id,
    );
    const anchor = visibleBase[Math.min(hint.index, visibleBase.length)];
    const anchored = anchor ? without.findIndex((page) => page.id === anchor.id) : -1;
    return { column, position: anchored >= 0 ? anchored : without.length };
  };

  const placePage = async (
    id: string,
    status: PageStatus,
    hint: { status: PageStatus; index: number } | null,
  ) => {
    const current = board.pages.find((page) => page.id === id);
    if (!current) return;
    const { column, position } = positionFor(id, status, hint);
    // A page put back exactly where it came from is not a change worth writing.
    if (current.status === status && column.findIndex((page) => page.id === id) === position) return;
    await onUpdate(id, { status, position });
  };

  const pointerDrag = usePointerDrag({
    onLift: (id, height) => {
      const page = board.pages.find((candidate) => candidate.id === id);
      setDrag({ id, height });
      setDropHint(page ? { status: page.status, index: slotOf(pagesByStatus, page) } : null);
      // A page cannot be carried and tapped into place at the same time.
      setMoving(null);
    },
    onMove: (point) => {
      const hint = hintAt(point);
      setDropHint((current) => (sameHint(current, hint) ? current : hint));
    },
    onDrop: async (point) => {
      const id = drag?.id;
      const hint = hintAt(point) ?? dropHint;
      finishDrag();
      if (!id || !hint) return;
      await placePage(id, hint.status, hint);
    },
    onCancel: finishDrag,
  });

  /** Puts a page down where a tap asked for it, and leaves the moving state either way. */
  const placeMoving = async (status: PageStatus, index: number) => {
    const id = moving;
    setMoving(null);
    if (!id) return;
    await placePage(id, status, { status, index });
  };

  const liftedPage = pointerDrag.lift
    ? (board.pages.find((page) => page.id === pointerDrag.lift?.id) ?? null)
    : null;

  return (
    <div className="board-shell" ref={shellRef}>
      <header className="board-topbar">
        <div className="brand-lockup">
          <span className="brand-mark">g</span>
          <span className="brand-word">grimoire</span>
          <span className="app-version">v{packageJson.version}</span>
          <nav className="workspace-tabs" aria-label="Project spaces">
            <button
              aria-current={view === "work" ? "page" : undefined}
              aria-label="work"
              onClick={() => void onViewChange("work")}
              title="Work (1)"
              type="button"
            >
              work <kbd aria-hidden="true">1</kbd>
            </button>
            <button
              aria-current={view === "ideas" ? "page" : undefined}
              aria-label="ideas"
              onClick={() => void onViewChange("ideas")}
              title="Ideas (2)"
              type="button"
            >
              ideas <kbd aria-hidden="true">2</kbd>
            </button>
          </nav>
        </div>
        <div className="board-project">
          <ProjectMenu
            actions={projectActions}
            activityBadge={unseenCount}
            busy={busy}
            isOwner={board.viewerIsOwner}
            onOpenActivity={
              isOwner
                ? () => {
                    setActivityOpen(true);
                    setActivityVisited(true);
                  }
                : undefined
            }
            onOpenSettings={() => setSettingsSection("general")}
            onOpenTeam={() => setSettingsSection("team")}
            project={board.project}
            projects={board.projects}
          />
        </div>
        <div className="board-actions">
          {/* Presence lives on the people filters, not here: this row is mostly the signed-in person. */}
          <div className="member-faces" aria-label={`${board.members.length} project members`}>
            {board.members.slice(0, 4).map((member) => (
              <Avatar avatarUrl={member.avatarUrl} key={member.id} name={member.name} title={member.name} />
            ))}
          </div>
          {isOwner && (
            <button
              className="quiet-button activity-trigger"
              onClick={() => {
                setActivityOpen(true);
                setActivityVisited(true);
              }}
              type="button"
            >
              activity
              {unseenCount > 0 && (
                <span aria-label={`${unseenCount} changes since your last visit`} className="away-badge">
                  {unseenCount > 99 ? "99+" : unseenCount}
                </span>
              )}
            </button>
          )}
          {/*
            Search reaches the whole project from either workspace, and used to be reachable
            only by pressing "/" - a key a phone does not have, on a surface where the one
            visible way in appeared solely once a filter had been typed.
          */}
          <button
            aria-label="Search"
            className="quiet-button search-trigger"
            onClick={() => setSearchOpen(true)}
            title="Search (/)"
            type="button"
          >
            <span aria-hidden="true">⌕</span>
            <span className="search-trigger-label">search</span>
          </button>
          {/* A shortcut into the one settings surface, landing on its Team section. */}
          <button
            className="quiet-button team-trigger"
            onClick={() => setSettingsSection("team")}
            type="button"
          >
            team
          </button>
          <button
            aria-label={`Open account settings for ${board.currentUser.name}`}
            className="account-button"
            onClick={() => setAccountOpen(true)}
            title="Account settings"
            type="button"
          >
            <Avatar
              avatarUrl={board.currentUser.avatarUrl}
              className="avatar current"
              name={board.currentUser.name}
            />
            <span>{board.currentUser.name}</span>
          </button>
        </div>
      </header>

      {away && !awayDismissed && (
        <AwayDigest away={away} board={board} onDismiss={() => setAwayDismissed(true)} />
      )}

      {/* While a page is held, the board says so and offers the way out, because the gaps
          that have opened everywhere are otherwise unexplained. */}
      {movingPage && (
        <div className="moving-bar" role="status">
          <span>
            Moving <strong>{movingPage.title}</strong> — choose where it goes
          </span>
          <button className="text-button" onClick={() => setMoving(null)} type="button">
            cancel <kbd aria-hidden="true">esc</kbd>
          </button>
        </div>
      )}

      {view === "work" ? (
        <main className="board-main">
          <div className="board-intro">
            <div>
              {/* A chapter names itself and says when it runs in one sentence. That is the whole
                reporting surface: no chart, no percentage, nothing to keep up to date. */}
              <h2>
                {selectedChapter
                  ? selectedChapter.name
                  : `${activeCount} active page${activeCount === 1 ? "" : "s"}`}
              </h2>
              {selectedChapter && (
                <p className="chapter-line">
                  {activeCount} active page{activeCount === 1 ? "" : "s"}
                  {/* The chapter's own reserve belongs in its sentence. Repeating it beneath the
                    filters put a second count next to the Backlog pill that already carries one. */}
                  {offBoardMatches.backlog > 0 && (
                    <>
                      {" "}
                      <span aria-hidden="true">·</span> {offBoardMatches.backlog} in backlog
                    </>
                  )}
                  {chapterWhen(selectedChapter) && (
                    <>
                      {" "}
                      <span aria-hidden="true">·</span> <em>{chapterWhen(selectedChapter)}</em>
                    </>
                  )}
                </p>
              )}
              {selectedChapter?.description && (
                <p className="chapter-intent">{plainTextFromMarkdown(selectedChapter.description)}</p>
              )}
            </div>
            <QuickCapture
              busy={busy}
              categories={board.categories}
              chapters={chaptersOn ? board.chapters : []}
              fields={board.fields}
              members={board.members}
              onCreate={capturePage}
            />
          </div>

          <div className="work-filters" aria-label="Work filters">
            <button
              aria-label={
                moving
                  ? `Move ${board.pages.find((page) => page.id === moving)?.title ?? "page"} to the backlog`
                  : `Open backlog, ${backlogPages.length} page${backlogPages.length === 1 ? "" : "s"}`
              }
              className={`library-trigger ${drag ? "drop-ready" : ""} ${dropHint?.status === "backlog" ? "drop-over" : ""} ${moving ? "move-target" : ""} ${landed === "backlog" ? "landed" : ""}`}
              onClick={() => {
                if (moving) void placeMoving("backlog", 0);
                else setBacklogOpen(true);
              }}
              ref={backlogNode}
              title="Backlog (B)"
              type="button"
            >
              <span>Backlog</span>
              <strong>{backlogPages.length}</strong>
              <kbd aria-hidden="true">B</kbd>
            </button>
            {chaptersOn && (
              <ChapterPicker
                pages={board.pages}
                chapters={board.chapters}
                isOwner={isOwner}
                onChange={changeChapter}
                onManage={() => setSettingsSection("chapters")}
                onMakeCurrent={makeChapterCurrent}
                value={chapter}
              />
            )}
            <label className="page-search">
              <span className="sr-only">Search pages</span>
              <input
                aria-label="Search pages"
                name="pageSearch"
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="Search pages..."
                type="search"
                value={query}
              />
            </label>
            {/* Everything else a page can be narrowed by, next to the people it can be narrowed to. */}
            <PageFilters
              context={facetContext}
              onChange={changeFacets}
              pages={pagesBeforeFacets}
              selection={facets}
            />
            <div className="people-filters">
              <button
                aria-pressed={people.has("unassigned")}
                className={people.has("unassigned") ? "active" : ""}
                onClick={() => togglePerson("unassigned")}
                type="button"
              >
                unassigned
              </button>
              {board.members.map((member) => {
                const isCurrentUser = member.id === board.currentUser.id;
                return (
                  <button
                    aria-label={isCurrentUser ? "Filter to my work" : `Filter by ${member.name}`}
                    aria-pressed={people.has(member.id)}
                    className={`${people.has(member.id) ? "active" : ""} ${isCurrentUser ? "self-filter" : ""}`}
                    key={member.id}
                    onClick={() => togglePerson(member.id)}
                    type="button"
                  >
                    {isCurrentUser && <span className="self-filter-label">me</span>}
                    {/* The self chip clips its contents and slides on toggle, so the glow stays off it. */}
                    <Avatar
                      avatarUrl={member.avatarUrl}
                      className="avatar tiny"
                      name={member.name}
                      online={!isCurrentUser && online.has(member.id)}
                      title={online.has(member.id) ? `${member.name} (online)` : member.name}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* The board can only draw four columns, so a filter that found nothing here has
            not searched the project. This says where the rest of the matches are. */}
          {/* Only a search needs this: it reports matches the four columns cannot show and offers
            the way to reach them. A chapter's own counts live in its line above the filters. */}
          {normalizedQuery && (
            <div className="off-board-hint">
              {offBoardMatches.backlog > 0 && <span>{offBoardMatches.backlog} in Backlog</span>}
              {offBoardMatches.completed > 0 && <span>{offBoardMatches.completed} more completed</span>}
              <button
                className="text-button search-everything"
                onClick={() => setSearchOpen(true)}
                type="button"
              >
                search everything <kbd aria-hidden="true">/</kbd>
              </button>
            </div>
          )}

          <div className="kanban" aria-label={`${board.project.name} board`} ref={kanbanRef}>
            {BOARD_STATUSES.map((status) => {
              const pages = pagesByStatus[status];
              // Whichever way a page was picked up, it leaves the flow of its column so the
              // gaps being offered are the ones that will exist once it lands.
              const liftedId = drag?.id ?? moving;
              const basePages = liftedId ? pages.filter((page) => page.id !== liftedId) : pages;
              const hintIndex =
                drag && dropHint?.status === status ? Math.min(dropHint.index, basePages.length) : null;
              const placeholder = drag ? (
                <div
                  aria-hidden="true"
                  className="drop-placeholder"
                  data-flip-id="drop-placeholder"
                  style={{ height: drag.height }}
                />
              ) : null;
              const visibleStatusCount = filteredPages.filter((page) => page.status === status).length;
              return (
                <section
                  aria-label={columnNames[status]}
                  className={`kanban-column column-${status} ${landed === status ? "landed" : ""} ${moving ? "moving-open" : ""}`}
                  key={status}
                  ref={(node) => {
                    if (node) columnNodes.current.set(status, node);
                    else columnNodes.current.delete(status);
                  }}
                >
                  <header className="column-header">
                    <div>
                      <span className="column-dot" />
                      <h3>{columnNames[status]}</h3>
                    </div>
                    <span className="column-count">
                      {status === "done" && visibleStatusCount > DONE_COLUMN_LIMIT
                        ? `${pages.length} of ${visibleStatusCount}`
                        : visibleStatusCount}
                    </span>
                  </header>
                  <div className="page-list">
                    {movingPage && (
                      <MoveSlot
                        index={0}
                        onPlace={placeMoving}
                        status={status}
                        statusName={columnNames[status]}
                        title={movingPage.title}
                      />
                    )}
                    {pages.map((page) => {
                      const hidden = liftedId === page.id;
                      const slot = hidden ? -1 : basePages.findIndex((candidate) => candidate.id === page.id);
                      const blockers = page.blockedBy
                        .map((id) => board.pages.find((candidate) => candidate.id === id))
                        .filter((candidate): candidate is Page =>
                          Boolean(candidate && candidate.status !== "done"),
                        );
                      const category = page.category ? categoriesBySlug.get(page.category) : undefined;
                      const preview = page.description ? plainTextFromMarkdown(page.description) : "";
                      const unseen = unseenPageIds.has(page.id);
                      return (
                        <Fragment key={page.id}>
                          {!hidden && slot === hintIndex && placeholder}
                          <article
                            className={`board-page ${page.category ? "" : "category-none"} ${hidden ? "drag-hidden" : ""} ${unseen ? "unseen" : ""}`}
                            data-flip-id={page.id}
                            onPointerDown={(event) => pointerDrag.start(event, page.id)}
                            style={category ? categoryColorStyle(category.color) : undefined}
                          >
                            <button
                              aria-label={`Move ${page.title}`}
                              aria-pressed={moving === page.id}
                              className="drag-grip"
                              onClick={() => {
                                if (pointerDrag.consumeClick()) return;
                                setMoving((current) => (current === page.id ? null : page.id));
                              }}
                              title={`Move ${page.title}`}
                              type="button"
                            >
                              ⠿
                            </button>
                            <button
                              aria-label={`Open ${page.title}${preview ? `. ${preview}` : ""}. ${categoryName(page.category)}. ${blockers.length ? `Blocked by ${blockers.map((blocker) => blocker.title).join(", ")}. ` : ""}${page.assigneeName ?? "unassigned"}${unseen ? ". Changed while you were away" : ""}`}
                              className="page-open"
                              onClick={() => {
                                if (!pointerDrag.consumeClick()) setSelectedId(page.id);
                              }}
                              type="button"
                            >
                              {(page.category ||
                                blockers.length > 0 ||
                                page.github ||
                                page.openThreads > 0 ||
                                (board.project.estimatesEnabled && page.estimate !== null)) && (
                                <span className="page-signals">
                                  {page.category && (
                                    <span className="category-pill">{categoryName(page.category)}</span>
                                  )}
                                  {blockers.length > 0 && (
                                    <span className="page-blocked">blocked by {blockers.length}</span>
                                  )}
                                  {board.project.estimatesEnabled && page.estimate !== null && (
                                    <span className="estimate-pill" title={`Estimated at ${page.estimate}`}>
                                      {page.estimate}
                                    </span>
                                  )}
                                  {/*
                              Only unanswered threads are worth a tile: a page whose questions
                              have all been answered looks exactly as it did before anyone
                              asked one.
                            */}
                                  {page.openThreads > 0 && (
                                    <span
                                      className="discussion-pill"
                                      title={
                                        page.openThreads === 1
                                          ? "1 open thread"
                                          : `${page.openThreads} open threads`
                                      }
                                    >
                                      {page.openThreads} open
                                    </span>
                                  )}
                                  {page.github && (
                                    <span
                                      className={`github-pill github-state-${page.githubStatus?.state ?? "unchecked"}`}
                                    >
                                      {page.githubStatus?.prNumber
                                        ? `#${page.githubStatus.prNumber}`
                                        : page.github.kind === "pr"
                                          ? `#${page.github.number}`
                                          : `⎇ ${page.github.name}`}
                                    </span>
                                  )}
                                </span>
                              )}
                              <strong>{page.title}</strong>
                              {preview && <p>{preview}</p>}
                              <PageFieldChips fields={board.fields} values={page.fields} />
                              <span className={`assignee ${page.assigneeId ? "assigned" : ""}`}>
                                {page.assigneeName ? (
                                  <>
                                    <Avatar
                                      avatarUrl={
                                        board.members.find((member) => member.id === page.assigneeId)
                                          ?.avatarUrl
                                      }
                                      className="avatar tiny"
                                      name={page.assigneeName}
                                    />
                                    {page.assigneeName}
                                  </>
                                ) : (
                                  "unassigned"
                                )}
                              </span>
                            </button>
                          </article>
                          {movingPage && !hidden && (
                            <MoveSlot
                              index={slot + 1}
                              onPlace={placeMoving}
                              status={status}
                              statusName={columnNames[status]}
                              title={movingPage.title}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                    {hintIndex !== null && hintIndex === basePages.length && placeholder}
                    {pages.length === 0 && hintIndex === null && !movingPage && (
                      <div className="empty-column">
                        {status === "done" ? "completed work appears here" : "drop a page here"}
                      </div>
                    )}
                  </div>
                  {status === "done" && completedPages.length > DONE_COLUMN_LIMIT && (
                    <button
                      aria-label={`Search all completed work, ${completedPages.length} pages`}
                      className="library-trigger completed-trigger"
                      onClick={() => setHistoryOpen(true)}
                      type="button"
                    >
                      <span>all completed</span>
                      <strong>{completedPages.length}</strong>
                    </button>
                  )}
                  {status !== "done" &&
                    (addingTo === status ? (
                      <form
                        className="column-add-form"
                        onSubmit={(event) => void createColumnPage(event, status)}
                      >
                        <label className="sr-only" htmlFor={`new-${status}`}>
                          New {columnNames[status]} page
                        </label>
                        <input
                          autoFocus
                          id={`new-${status}`}
                          name={`new-${status}`}
                          onChange={(event) => setColumnTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setAddingTo(null);
                          }}
                          placeholder="Page title"
                          value={columnTitle}
                        />
                        <div>
                          <button
                            className="primary-button compact"
                            disabled={!columnTitle.trim()}
                            type="submit"
                          >
                            add
                          </button>
                          <button className="text-button" onClick={() => setAddingTo(null)} type="button">
                            cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button
                        className="add-to-column"
                        onClick={() => {
                          setAddingTo(status);
                          setColumnTitle("");
                        }}
                        type="button"
                      >
                        + add page
                      </button>
                    ))}
                </section>
              );
            })}
          </div>
        </main>
      ) : ideas ? (
        <IdeasBoard
          busy={busy}
          openIdea={openIdea}
          unseenIdeaIds={unseenIdeaIds}
          workspace={ideas}
          onCreate={onCreateIdea}
          onPromote={onPromoteIdea}
          onUpdate={onUpdateIdea}
        />
      ) : (
        <main className="ideas-main">
          <p className="ideas-loading">opening the idea garden...</p>
        </main>
      )}

      {searchOpen && (
        <SearchDialog
          initialQuery={query}
          onClose={() => setSearchOpen(false)}
          onOpenPage={openPageFromSearch}
          onOpenIdea={openIdeaFromSearch}
          onRestorePage={onRestorePage}
        />
      )}
      {selectedPage && (
        <PageDialog
          pages={board.pages}
          page={selectedPage}
          categories={board.categories}
          chapters={chaptersOn ? board.chapters : []}
          fields={board.fields}
          currentUserId={board.currentUser.id}
          estimatesEnabled={board.project.estimatesEnabled}
          githubRepo={board.project.githubRepo}
          members={board.members}
          revision={revision}
          onArchive={async () => {
            await onArchive(selectedPage.id);
            setSelectedId(null);
          }}
          onClose={() => setSelectedId(null)}
          onLoadActivity={onLoadActivity}
          onLoadDiscussion={onLoadDiscussion}
          onAsk={onAsk}
          onReply={onReply}
          onSetAnswered={onSetAnswered}
          onSeeDiscussion={onSeeDiscussion}
          onUpdate={(input) => onUpdate(selectedPage.id, input)}
        />
      )}
      {activityOpen && (
        <ActivityDialog
          awaySince={away?.since}
          members={board.members}
          revision={revision}
          onClose={() => setActivityOpen(false)}
          onLoad={onLoadActivity}
          onOpenPage={(id) => {
            if (!board.pages.some((page) => page.id === id)) return;
            setActivityOpen(false);
            setSelectedId(id);
          }}
        />
      )}
      {backlogOpen && (
        <BacklogDialog
          allPages={board.pages}
          busy={busy}
          pages={backlogPages}
          categories={board.categories}
          chapters={chaptersOn ? board.chapters : []}
          members={board.members}
          onClose={() => setBacklogOpen(false)}
          onMoveToNext={onMoveBacklogToNext}
          onOpenPage={(id) => {
            setBacklogOpen(false);
            setSelectedId(id);
          }}
          onSetChapter={(id, value) => onUpdate(id, { chapter: value })}
          targetChapter={chaptersOn && chapter !== NO_CHAPTER ? chapter : null}
        />
      )}
      {historyOpen && (
        <DoneHistoryDialog
          busy={busy}
          pages={completedPages}
          categories={board.categories}
          members={board.members}
          onClose={() => setHistoryOpen(false)}
          onOpenPage={(id) => {
            setHistoryOpen(false);
            setSelectedId(id);
          }}
          onReopen={async (id) => {
            setHistoryOpen(false);
            await onUpdate(id, {
              status: "ready",
              position: board.pages.filter((page) => page.status === "ready").length,
            });
          }}
        />
      )}
      {settingsSection && (
        <ProjectSettingsDialog
          actions={projectSettingsActions}
          busy={busy}
          canArchive={board.projects.length > 1}
          categories={board.categories}
          categoryActions={categoryActions}
          chapterActions={chapterActions}
          chapters={board.chapters}
          chaptersEnabled={chaptersOn}
          velocity={board.velocity}
          currentUser={board.currentUser}
          fieldActions={fieldActions}
          fields={board.fields}
          isOwner={isOwner}
          members={board.members}
          onChangeMemberRole={onChangeMemberRole}
          onClose={() => setSettingsSection(null)}
          onAddMember={onAddMember}
          onCreateInvite={onCreateInvite}
          online={online}
          onRemoveMember={onRemoveMember}
          onSectionChange={setSettingsSection}
          onSetPageChapter={(id, value) => onUpdate(id, { chapter: value })}
          pages={board.pages}
          project={board.project}
          section={settingsSection}
        />
      )}
      {accountOpen && (
        <AccountDialog
          onChangeAvatar={onChangeAvatar}
          onChangeName={onChangeName}
          onChangePassword={onChangePassword}
          onClose={() => setAccountOpen(false)}
          onLogout={onLogout}
          onRemoveAvatar={onRemoveAvatar}
          user={board.currentUser}
        />
      )}
      {flight && (
        <div
          aria-hidden="true"
          className="capture-flight"
          key={flight.id}
          ref={flightRef}
          style={{ left: flight.from.x, top: flight.from.y, width: flight.from.width }}
        >
          {flight.title}
        </div>
      )}
      {/* The card itself stays out of the flow while it is carried; this is what the pointer
          actually holds, drawn over the board it is crossing. */}
      {pointerDrag.lift && liftedPage && (
        <div
          aria-hidden="true"
          className="board-page lifted"
          style={{
            left: pointerDrag.lift.left,
            top: pointerDrag.lift.top,
            width: pointerDrag.lift.width,
            height: pointerDrag.lift.height,
            transform: `translate(${pointerDrag.lift.dx}px, ${pointerDrag.lift.dy}px)`,
          }}
        >
          <span className="page-open">
            <strong>{liftedPage.title}</strong>
          </span>
        </div>
      )}
      {busy && (
        <div className="saving-indicator">
          <span className="connection-dot" />
          saving
        </div>
      )}
    </div>
  );
}

type CaptureFlight = {
  id: number;
  title: string;
  status: PageStatus;
  from: { x: number; y: number; width: number };
  to: { x: number; y: number };
};

/**
 * One place a held page can be put down.
 *
 * These are ordinary buttons, which is the whole point: the gap a mouse finds by hovering
 * over it is the same gap a finger finds by tapping it and a keyboard finds by tabbing to it.
 */
function MoveSlot({
  index,
  onPlace,
  status,
  statusName,
  title,
}: {
  index: number;
  onPlace: (status: PageStatus, index: number) => Promise<void>;
  status: PageStatus;
  statusName: string;
  title: string;
}) {
  return (
    <button
      aria-label={`Place ${title} in ${statusName}, position ${index + 1}`}
      className="move-slot"
      onClick={() => void onPlace(status, index)}
      type="button"
    >
      <span aria-hidden="true">place here</span>
    </button>
  );
}

function sameHint(
  left: { status: PageStatus; index: number } | null,
  right: { status: PageStatus; index: number } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.status === right.status && left.index === right.index;
}

/** Where a page currently sits among the ones its column is showing. */
function slotOf(pagesByStatus: Record<(typeof BOARD_STATUSES)[number], Page[]>, page: Page): number {
  const column = pagesByStatus[page.status as (typeof BOARD_STATUSES)[number]];
  const index = column?.findIndex((candidate) => candidate.id === page.id) ?? -1;
  return index >= 0 ? index : 0;
}

function comparePosition(left: Page, right: Page): number {
  return left.position - right.position;
}
