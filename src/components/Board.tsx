import { type DragEvent, type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type AuditPage, type AwayState, type BoardWorkspace, type Page, type PageStatus, type IdeaState, type IdeaWorkspace, type UserRole } from "../../shared/types";
import { AccountDialog } from "./AccountDialog";
import { ActivityDialog } from "./ActivityDialog";
import { Avatar } from "./Avatar";
import { AwayDigest } from "./AwayDigest";
import { BacklogDialog } from "./BacklogDialog";
import { PageDialog } from "./PageDialog";
import { type CategoryActions, CategoriesDialog } from "./CategoriesDialog";
import { type FieldActions, FieldsDialog } from "./FieldsDialog";
import { PageFieldChips } from "./PageFields";
import { type ChapterActions, ChaptersDialog } from "./ChaptersDialog";
import { type ChapterFilter, ChapterPicker, NO_CHAPTER } from "./ChapterPicker";
import { agentTokenIsLive, agentTokens } from "../api/client";
import { chapterWhen } from "./chapter-dates";
import { DoneHistoryDialog } from "./DoneHistoryDialog";
import { type ProjectActions, ProjectMenu } from "./ProjectMenu";
import { type ProjectSettingsActions, ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { AgentAccessDialog } from "./AgentAccessDialog";
import { type CapturePageInput, QuickCapture } from "./QuickCapture";
import { SearchDialog } from "./SearchDialog";
import { TeamDialog } from "./TeamDialog";
import { plainTextFromMarkdown } from "./markdown-text";
import { IdeasBoard } from "./IdeasBoard";
import { useFlip } from "./use-flip";

const BOARD_STATUSES = ["ready", "in_progress", "review", "done"] as const satisfies readonly PageStatus[];

/**
 * Done is a hybrid column: it reads like the other three until it outgrows them, then it
 * grows a backlog-style escape hatch instead of scrolling forever. Board filters run over
 * every page before this slice, so a match buried deep in the history still surfaces here.
 */
const DONE_COLUMN_LIMIT = 10;

const columnNames: Record<PageStatus, string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

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
  onCreateInvite: () => Promise<string>;
  onCreateIdea: (input: { title: string }) => Promise<void>;
  onLoadActivity: (options: { entityId?: string; before?: number; limit?: number }) => Promise<AuditPage>;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangeName: (name: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onLogout: () => Promise<void>;
  onMoveBacklogToNext: (id: string) => Promise<void>;
  onPromoteIdea: (id: string) => Promise<void>;
  onChangeMemberRole: (id: string, role: UserRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onRestorePage: (id: string) => Promise<void>;
  onUpdateIdea: (id: string, input: Record<string, unknown>) => Promise<void>;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

export function Board({ away, board, busy, categoryActions, chapterActions, fieldActions, ideas, online, projectActions, projectSettingsActions, revision, view, onCreate, onUpdate, onArchive, onCreateInvite, onCreateIdea, onChangeAvatar, onChangeName, onChangePassword, onLoadActivity, onLogout, onMoveBacklogToNext, onPromoteIdea, onRemoveAvatar, onChangeMemberRole, onRemoveMember, onRestorePage, onUpdateIdea, onViewChange }: Props) {
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
  const dragSession = useRef(0);
  const [flight, setFlight] = useState<CaptureFlight | null>(null);
  const [landed, setLanded] = useState<PageStatus | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<HTMLDivElement>(null);
  const kanbanRef = useRef<HTMLDivElement>(null);
  useFlip(kanbanRef);
  const [teamOpen, setTeamOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Bumped so choosing the same idea twice still reopens it in the garden.
  const [openIdea, setOpenIdea] = useState<{ id: string; token: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentCount, setAgentCount] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  // Once the history has been opened, its badge has done its job for this visit.
  const [activityVisited, setActivityVisited] = useState(false);
  const [awayDismissed, setAwayDismissed] = useState(false);
  // Pages the reader has opened this visit; their dots have been answered.
  const [openedUnseen, setOpenedUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const isOwner = board.currentUser.role === "owner";

  // The settings summary states how many agents have access, so the count has to be true
  // the first time settings opens - not only after the agent dialog has refreshed it.
  useEffect(() => {
    if (!settingsOpen || !isOwner) return;
    let cancelled = false;
    void agentTokens()
      .then(({ tokens }) => {
        if (!cancelled) setAgentCount(tokens.filter((token) => agentTokenIsLive(token)).length);
      })
      .catch(() => {
        // The section then shows its default copy; opening the dialog surfaces the error.
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, isOwner]);
  const unseenCount = away && !awayDismissed && !activityVisited ? away.total : 0;
  const unseenPageIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "page" && event.entityId && !openedUnseen.has(event.entityId)) ids.add(event.entityId);
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
  const selectedChapter = chapter === null || chapter === NO_CHAPTER
    ? undefined
    : board.chapters.find((value) => value.slug === chapter);
  // A chapter that was deleted, or a gate switched off, must not leave the board filtered
  // to something the reader can no longer see or reach.
  useEffect(() => {
    if (chapter === null || chapter === NO_CHAPTER) return;
    if (!chaptersOn || !board.chapters.some((value) => value.slug === chapter)) setChapter(null);
  }, [board.chapters, chapter, chaptersOn]);
  const selectedPage = board.pages.find((page) => page.id === selectedId) ?? null;

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
    slug === null ? "uncategorized" : categoriesBySlug.get(slug)?.name ?? slug;
  const normalizedQuery = query.trim().toLowerCase();
  const chaptersBySlug = useMemo(
    () => new Map(board.chapters.map((value) => [value.slug, value])),
    [board.chapters],
  );
  const chapterName = (slug: string | null) =>
    slug === null ? "no chapter" : chaptersBySlug.get(slug)?.name ?? slug;
  const filteredPages = useMemo(
    () => board.pages.filter((page) => {
      if (chapter === NO_CHAPTER && page.chapter !== null) return false;
      if (chapter !== null && chapter !== NO_CHAPTER && page.chapter !== chapter) return false;
      if (people.size > 0 && !people.has(page.assigneeId ?? "unassigned")) return false;
      if (normalizedQuery && !`${page.title}\n${page.description}\n${categoryName(page.category)}\n${chapterName(page.chapter)}\n${page.assigneeName ?? "unassigned"}`.toLowerCase().includes(normalizedQuery)) return false;
      return true;
    }),
    [board.pages, categoriesBySlug, chapter, chaptersBySlug, normalizedQuery, people],
  );
  const activeCount = filteredPages.filter((page) => page.status === "ready" || page.status === "in_progress" || page.status === "review").length;
  const backlogPages = board.pages.filter((page) => page.status === "backlog");
  const completedPages = board.pages.filter((page) => page.status === "done");
  const offBoardMatches = useMemo(
    () => ({
      backlog: filteredPages.filter((page) => page.status === "backlog").length,
      completed: Math.max(0, filteredPages.filter((page) => page.status === "done").length - DONE_COLUMN_LIMIT),
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
    const useKeyboardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
    window.addEventListener("keydown", useKeyboardShortcut);
    return () => window.removeEventListener("keydown", useKeyboardShortcut);
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

  const updateUrl = (nextQuery: string, nextPeople: Set<string>, nextChapter: ChapterFilter) => {
    const params = new URLSearchParams(location.search);
    params.delete("focus");
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    else params.delete("q");
    if (nextPeople.size) params.set("people", [...nextPeople].join(","));
    else params.delete("people");
    if (nextChapter) params.set("chapter", nextChapter);
    else params.delete("chapter");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
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
    const open = board.chapters.find((value) => value.state === "open");
    if (open && open.slug !== slug) await chapterActions.update(open.slug, { state: "closed" });
    await chapterActions.update(slug, { state: "open" });
    changeChapter(slug);
  };

  const spawnFlight = (input: CapturePageInput) => {
    const shell = shellRef.current;
    if (!shell) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setLanded(input.status);
      return;
    }
    const home = shell.querySelector(".workspace-capture");
    const target = input.status === "backlog"
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
    dragSession.current += 1;
    setDrag(null);
    setDropHint(null);
  };

  const startPageDrag = (event: DragEvent<HTMLElement>, page: Page, slot: number) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", page.id);
    const height = event.currentTarget.offsetHeight;
    const session = ++dragSession.current;
    // Hide the page one frame later so the browser captures a visible drag image first.
    requestAnimationFrame(() => {
      if (dragSession.current !== session) return;
      setDrag({ id: page.id, height });
      setDropHint({ status: page.status, index: slot });
    });
  };

  const trackColumnDrag = (event: DragEvent<HTMLElement>, status: PageStatus) => {
    event.preventDefault();
    if (!drag) return;
    const pageNodes = event.currentTarget.querySelectorAll<HTMLElement>("article.board-page:not(.drag-hidden)");
    let index = pageNodes.length;
    for (let position = 0; position < pageNodes.length; position += 1) {
      const rect = pageNodes[position].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        index = position;
        break;
      }
    }
    setDropHint((current) => (current?.status === status && current.index === index ? current : { status, index }));
  };

  const dropPage = async (event: DragEvent, status: PageStatus) => {
    event.preventDefault();
    const id = drag?.id ?? event.dataTransfer.getData("text/plain");
    const hint = dropHint;
    finishDrag();
    if (!id) return;
    const current = board.pages.find((page) => page.id === id);
    if (!current) return;
    const column = board.pages.filter((page) => page.status === status).sort(comparePosition);
    const without = column.filter((page) => page.id !== id);
    let position = without.length;
    if (hint && hint.status === status && status !== "backlog") {
      const visibleBase = pagesByStatus[status as (typeof BOARD_STATUSES)[number]]
        .filter((page) => page.id !== id);
      const anchor = visibleBase[Math.min(hint.index, visibleBase.length)];
      const anchored = anchor ? without.findIndex((page) => page.id === anchor.id) : -1;
      position = anchored >= 0 ? anchored : without.length;
    }
    if (current.status === status && column.findIndex((page) => page.id === id) === position) return;
    await onUpdate(id, { status, position });
  };

  return (
    <div className="board-shell" ref={shellRef}>
      <header className="board-topbar">
        <div className="brand-lockup">
          <span className="brand-mark">g</span>
          <span className="brand-word">grimoire</span>
          <nav className="workspace-tabs" aria-label="Project spaces">
            <button aria-current={view === "work" ? "page" : undefined} aria-label="work" onClick={() => void onViewChange("work")} title="Work (1)" type="button">work <kbd aria-hidden="true">1</kbd></button>
            <button aria-current={view === "ideas" ? "page" : undefined} aria-label="ideas" onClick={() => void onViewChange("ideas")} title="Ideas (2)" type="button">ideas <kbd aria-hidden="true">2</kbd></button>
          </nav>
        </div>
        <div className="board-project">
          <ProjectMenu
            actions={projectActions}
            busy={busy}
            isOwner={board.currentUser.role === "owner"}
            onOpenSettings={() => setSettingsOpen(true)}
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
              onClick={() => { setActivityOpen(true); setActivityVisited(true); }}
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
          <button className="quiet-button" onClick={() => setTeamOpen(true)} type="button">team</button>
          <button aria-label={`Open account settings for ${board.currentUser.name}`} className="account-button" onClick={() => setAccountOpen(true)} title="Account settings" type="button">
            <Avatar avatarUrl={board.currentUser.avatarUrl} className="avatar current" name={board.currentUser.name} />
            <span>{board.currentUser.name}</span>
          </button>
        </div>
      </header>

      {away && !awayDismissed && (
        <AwayDigest away={away} board={board} onDismiss={() => setAwayDismissed(true)} />
      )}

      {view === "work" ? <main className="board-main">
        <div className="board-intro">
          <div>
            {/* A chapter names itself and says when it runs in one sentence. That is the whole
                reporting surface: no chart, no percentage, nothing to keep up to date. */}
            <h2>{selectedChapter ? selectedChapter.name : `${activeCount} active page${activeCount === 1 ? "" : "s"}`}</h2>
            {selectedChapter && (
              <p className="chapter-line">
                {activeCount} active page{activeCount === 1 ? "" : "s"}
                {/* The chapter's own reserve belongs in its sentence. Repeating it beneath the
                    filters put a second count next to the Backlog pill that already carries one. */}
                {offBoardMatches.backlog > 0 && <> <span aria-hidden="true">·</span> {offBoardMatches.backlog} in backlog</>}
                {chapterWhen(selectedChapter) && <> <span aria-hidden="true">·</span> <em>{chapterWhen(selectedChapter)}</em></>}
              </p>
            )}
            {selectedChapter?.description && (
              <p className="chapter-intent">{plainTextFromMarkdown(selectedChapter.description)}</p>
            )}
          </div>
          <QuickCapture busy={busy} categories={board.categories} chapters={chaptersOn ? board.chapters : []} members={board.members} onCreate={capturePage} />
        </div>

        <div className="work-filters" aria-label="Work filters">
          <button
            aria-label={`Open backlog, ${backlogPages.length} page${backlogPages.length === 1 ? "" : "s"}`}
            className={`library-trigger ${drag ? "drop-ready" : ""} ${landed === "backlog" ? "landed" : ""}`}
            onClick={() => setBacklogOpen(true)}
            onDragOver={(event) => { if (drag) { event.preventDefault(); setDropHint(null); } }}
            onDrop={(event) => void dropPage(event, "backlog")}
            title="Backlog (B)"
            type="button"
          >
            <span>Backlog</span><strong>{backlogPages.length}</strong><kbd aria-hidden="true">B</kbd>
          </button>
          {chaptersOn && (
            <ChapterPicker
              pages={board.pages}
              chapters={board.chapters}
              isOwner={isOwner}
              onChange={changeChapter}
              onManage={() => setChaptersOpen(true)}
              onMakeCurrent={makeChapterCurrent}
              value={chapter}
            />
          )}
          <label className="page-search">
            <span className="sr-only">Search pages</span>
            <input aria-label="Search pages" name="pageSearch" onChange={(event) => changeQuery(event.target.value)} placeholder="Search pages..." type="search" value={query} />
          </label>
          <div className="people-filters">
            <button aria-pressed={people.has("unassigned")} className={people.has("unassigned") ? "active" : ""} onClick={() => togglePerson("unassigned")} type="button">unassigned</button>
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
            {offBoardMatches.backlog > 0 && (
              <span>{offBoardMatches.backlog} in Backlog</span>
            )}
            {offBoardMatches.completed > 0 && (
              <span>{offBoardMatches.completed} more completed</span>
            )}
            <button className="text-button search-everything" onClick={() => setSearchOpen(true)} type="button">
              search everything <kbd aria-hidden="true">/</kbd>
            </button>
          </div>
        )}

        <div className="kanban" aria-label={`${board.project.name} board`} ref={kanbanRef}>
          {BOARD_STATUSES.map((status) => {
            const pages = pagesByStatus[status];
            const basePages = drag ? pages.filter((page) => page.id !== drag.id) : pages;
            const hintIndex = drag && dropHint?.status === status ? Math.min(dropHint.index, basePages.length) : null;
            const placeholder = drag
              ? <div aria-hidden="true" className="drop-placeholder" data-flip-id="drop-placeholder" style={{ height: drag.height }} />
              : null;
            const visibleStatusCount = filteredPages.filter((page) => page.status === status).length;
            return (
              <section
                aria-label={columnNames[status]}
                className={`kanban-column column-${status} ${landed === status ? "landed" : ""}`}
                key={status}
                onDragOver={(event) => trackColumnDrag(event, status)}
                onDrop={(event) => void dropPage(event, status)}
              >
                <header className="column-header">
                  <div><span className="column-dot" /><h3>{columnNames[status]}</h3></div>
                  <span className="column-count">{status === "done" && visibleStatusCount > DONE_COLUMN_LIMIT ? `${pages.length} of ${visibleStatusCount}` : visibleStatusCount}</span>
                </header>
                <div className="page-list">
                  {pages.map((page) => {
                    const hidden = drag?.id === page.id;
                    const slot = hidden ? -1 : basePages.findIndex((candidate) => candidate.id === page.id);
                    const blockers = page.blockedBy
                      .map((id) => board.pages.find((candidate) => candidate.id === id))
                      .filter((candidate): candidate is Page => Boolean(candidate && candidate.status !== "done"));
                    const category = page.category ? categoriesBySlug.get(page.category) : undefined;
                    const preview = page.description ? plainTextFromMarkdown(page.description) : "";
                    const unseen = unseenPageIds.has(page.id);
                    return (
                      <Fragment key={page.id}>
                      {!hidden && slot === hintIndex && placeholder}
                      <article
                        className={`board-page ${page.category ? "" : "category-none"} ${hidden ? "drag-hidden" : ""} ${unseen ? "unseen" : ""}`}
                        data-flip-id={page.id}
                        draggable
                        onDragEnd={finishDrag}
                        onDragStart={(event) => startPageDrag(event, page, slot)}
                        style={category ? ({ "--category-color": category.color } as React.CSSProperties) : undefined}
                      >
                        <button
                          aria-label={`Open ${page.title}${preview ? `. ${preview}` : ""}. ${categoryName(page.category)}. ${blockers.length ? `Blocked by ${blockers.map((blocker) => blocker.title).join(", ")}. ` : ""}${page.assigneeName ?? "unassigned"}${unseen ? ". Changed while you were away" : ""}`}
                          className="page-open"
                          draggable
                          onClick={() => setSelectedId(page.id)}
                          type="button"
                        >
                          <span className="drag-grip" aria-hidden="true">⠿</span>
                          {(page.category || blockers.length > 0) && <span className="page-signals">
                            {page.category && <span className="category-pill">{categoryName(page.category)}</span>}
                            {blockers.length > 0 && <span className="page-blocked">blocked by {blockers.length}</span>}
                          </span>}
                          <strong>{page.title}</strong>
                          {preview && <p>{preview}</p>}
                          <PageFieldChips fields={board.fields} values={page.fields} />
                          <span className={`assignee ${page.assigneeId ? "assigned" : ""}`}>
                            {page.assigneeName ? <>
                              <Avatar
                                avatarUrl={board.members.find((member) => member.id === page.assigneeId)?.avatarUrl}
                                className="avatar tiny"
                                name={page.assigneeName}
                              />
                              {page.assigneeName}
                            </> : "unassigned"}
                          </span>
                        </button>
                      </article>
                      </Fragment>
                    );
                  })}
                  {hintIndex !== null && hintIndex === basePages.length && placeholder}
                  {pages.length === 0 && hintIndex === null && <div className="empty-column">{status === "done" ? "completed work appears here" : "drop a page here"}</div>}
                </div>
                {status === "done" && completedPages.length > DONE_COLUMN_LIMIT && (
                  <button
                    aria-label={`Search all completed work, ${completedPages.length} pages`}
                    className="library-trigger completed-trigger"
                    onClick={() => setHistoryOpen(true)}
                    type="button"
                  >
                    <span>all completed</span><strong>{completedPages.length}</strong>
                  </button>
                )}
                {status !== "done" && (addingTo === status ? (
                  <form className="column-add-form" onSubmit={(event) => void createColumnPage(event, status)}>
                    <label className="sr-only" htmlFor={`new-${status}`}>New {columnNames[status]} page</label>
                    <input
                      autoFocus
                      id={`new-${status}`}
                      name={`new-${status}`}
                      onChange={(event) => setColumnTitle(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setAddingTo(null); }}
                      placeholder="Page title"
                      value={columnTitle}
                    />
                    <div><button className="primary-button compact" disabled={!columnTitle.trim()} type="submit">add</button><button className="text-button" onClick={() => setAddingTo(null)} type="button">cancel</button></div>
                  </form>
                ) : (
                  <button className="add-to-column" onClick={() => { setAddingTo(status); setColumnTitle(""); }} type="button">+ add page</button>
                ))}
              </section>
            );
          })}
        </div>
      </main> : (
        ideas ? (
          <IdeasBoard
            busy={busy}
            openIdea={openIdea}
            unseenIdeaIds={unseenIdeaIds}
            workspace={ideas}
            onCreate={onCreateIdea}
            onPromote={onPromoteIdea}
            onUpdate={onUpdateIdea}
          />
        ) : <main className="ideas-main"><p className="ideas-loading">opening the idea garden...</p></main>
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
          members={board.members}
          revision={revision}
          onArchive={async () => { await onArchive(selectedPage.id); setSelectedId(null); }}
          onClose={() => setSelectedId(null)}
          onLoadActivity={onLoadActivity}
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
          onOpenPage={(id) => { setBacklogOpen(false); setSelectedId(id); }}
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
          onOpenPage={(id) => { setHistoryOpen(false); setSelectedId(id); }}
          onReopen={async (id) => {
            setHistoryOpen(false);
            await onUpdate(id, { status: "ready", position: board.pages.filter((page) => page.status === "ready").length });
          }}
        />
      )}
      {categoriesOpen && (
        <CategoriesDialog
          actions={categoryActions}
          busy={busy}
          categories={board.categories}
          // Opened from settings, closing returns there rather than dumping the reader on
          // the board, so the trip out and back reads as one place.
          onClose={() => { setCategoriesOpen(false); setSettingsOpen(true); }}
        />
      )}
      {fieldsOpen && (
        <FieldsDialog
          actions={fieldActions}
          busy={busy}
          fields={board.fields}
          onClose={() => { setFieldsOpen(false); setSettingsOpen(true); }}
        />
      )}
      {chaptersOpen && (
        <ChaptersDialog
          actions={chapterActions}
          busy={busy}
          pages={board.pages}
          chapters={board.chapters}
          onClose={() => setChaptersOpen(false)}
          onSetPageChapter={(id, value) => onUpdate(id, { chapter: value })}
        />
      )}
      {agentsOpen && (
        <AgentAccessDialog
          // Opened from settings, closing returns there, the same trip the other sections make.
          onClose={() => { setAgentsOpen(false); setSettingsOpen(true); }}
          onCountChange={setAgentCount}
        />
      )}
      {settingsOpen && (
        <ProjectSettingsDialog
          actions={projectSettingsActions}
          agentCount={agentCount}
          busy={busy}
          canArchive={board.projects.length > 1}
          canManageAgents={isOwner}
          pages={board.pages}
          categories={board.categories}
          chapters={board.chapters}
          chaptersEnabled={chaptersOn}
          onClose={() => setSettingsOpen(false)}
          onManageAgents={() => { setSettingsOpen(false); setAgentsOpen(true); }}
          canManageFields={isOwner}
          fields={board.fields}
          onManageCategories={() => { setSettingsOpen(false); setCategoriesOpen(true); }}
          onManageChapters={() => { setSettingsOpen(false); setChaptersOpen(true); }}
          onManageFields={() => { setSettingsOpen(false); setFieldsOpen(true); }}
          project={board.project}
        />
      )}
      {teamOpen && (
        <TeamDialog
          currentUser={board.currentUser}
          members={board.members}
          online={online}
          onClose={() => setTeamOpen(false)}
          onCreateInvite={onCreateInvite}
          onChangeMemberRole={onChangeMemberRole}
          onRemoveMember={onRemoveMember}
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
      {busy && <div className="saving-indicator"><span className="connection-dot" />saving</div>}
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

function comparePosition(left: Page, right: Page): number {
  return left.position - right.position;
}

function compareCompletion(left: Page, right: Page): number {
  const timestamp = (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
  return timestamp || right.position - left.position;
}
