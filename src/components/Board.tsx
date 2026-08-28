import { type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  type AuditPage,
  type AwayState,
  type BoardWorkspace,
  type DiscussionThread,
  type Page,
  type PageStatus,
  type IdeaWorkspace,
  type ProjectRole,
  PAGE_STATUS_LABELS,
} from "../../shared/types";
import { AwayDigest } from "./AwayDigest";
import { BoardDialogs } from "./BoardDialogs";
import { BoardTopBar } from "./BoardTopBar";
import { Growing } from "./Growing";
import { type CategoryActions } from "./CategoriesSection";
import { type FieldActions } from "./FieldsSection";
import { PageTile } from "./PageTile";
import { type ChapterActions } from "./ChaptersSection";
import { NO_CHAPTER } from "./ChapterPicker";
import { chapterWhen } from "../lib/chapter-dates";
import { type ProjectActions } from "./ProjectMenu";
import {
  type ProjectSettingsActions,
  type SettingsSection,
  settingsSectionsFor,
} from "./ProjectSettingsDialog";
import { type CapturePageInput, QuickCapture } from "./QuickCapture";
import { plainTextFromMarkdown } from "../lib/markdown-text";
import { IdeasBoard } from "./IdeasBoard";
import { LiftedGhost } from "./LiftedGhost";
import { MoveSlot } from "./MoveSlot";
import { MovingBar } from "./MovingBar";
import {
  BOARD_STATUSES,
  comparePosition,
  DONE_COLUMN_LIMIT,
  useBoardFilters,
} from "../hooks/use-board-filters";
import { useBoardShortcuts } from "../hooks/use-board-shortcuts";
import { type CardHint, useCardBoard } from "../hooks/use-card-board";
import { useCaptureFlight } from "../hooks/use-capture-flight";
import { useFlip } from "../hooks/use-flip";
import { type DragPoint, gapIndexIn, pointWithin } from "../hooks/use-pointer-drag";
import { WorkFilters } from "./WorkFilters";

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
    // arrival pass below rewrites the address bar to the current spelling.
    () => {
      const params = new URLSearchParams(location.search);
      return params.get("page") ?? params.get("card");
    },
  );
  const columnNodes = useRef(new Map<PageStatus, HTMLElement>());
  const backlogNode = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const { flight, flightRef, landed, spawnFlight } = useCaptureFlight(shellRef);
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
  const changeSettingsSection = (section: SettingsSection | null) => {
    setSettingsSection(section);
    const params = new URLSearchParams(location.search);
    if (section) params.set("settings", section);
    else params.delete("settings");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };
  const unseenCount = away && !awayDismissed && !activityVisited ? away.total : 0;
  const unseenIdeaIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "idea" && event.entityId) ids.add(event.entityId);
    }
    return ids;
  }, [away, awayDismissed]);
  const filters = useBoardFilters(board);
  const {
    query,
    chapter,
    selectedChapter,
    categoriesBySlug,
    categoryName,
    normalizedQuery,
    filteredPages,
    pagesByStatus,
    changeChapter,
  } = filters;
  const chaptersOn = board.project.chaptersEnabled;
  const selectedPage = board.pages.find((page) => page.id === selectedId) ?? null;

  // The open page lives in the URL, so the address bar is always a shareable link to
  // exactly what is on screen; the write happens here, in the handler that changes the
  // selection, never in a sync effect.
  const changeSelectedPage = (id: string | null) => {
    setSelectedId(id);
    const params = new URLSearchParams(location.search);
    params.delete("card");
    if (id && board.pages.some((page) => page.id === id)) params.set("page", id);
    else params.delete("page");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  // A shared link is reconciled once on arrival: the pre-rename `card` spelling becomes
  // `page`, and a link to a page this board no longer has simply falls away. Every later
  // write goes through changeSelectedPage.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.delete("card");
    if (selectedPage) params.set("page", selectedPage.id);
    else params.delete("page");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    // Runs only for the URL the board arrived with; the state it reads is the mount seed.
  }, []);
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

  useBoardShortcuts({
    view,
    onOpenBacklog: () => setBacklogOpen(true),
    onOpenSearch: () => setSearchOpen(true),
    onViewChange,
  });

  const openPageFromSearch = (id: string) => {
    setSearchOpen(false);
    setBacklogOpen(false);
    setHistoryOpen(false);
    if (view === "ideas") void onViewChange("work");
    changeSelectedPage(id);
  };

  const openIdeaFromSearch = (id: string) => {
    setSearchOpen(false);
    setOpenIdea({ id, token: Date.now() });
    if (view !== "ideas") void onViewChange("ideas");
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

  /**
   * Which gap on the board a point is asking for.
   *
   * The Backlog control answers first: it overlaps nothing, and a page released on it is
   * leaving the board rather than being placed within a column.
   */
  const hintAt = (point: DragPoint): CardHint<PageStatus> | null => {
    const backlog = backlogNode.current?.getBoundingClientRect();
    if (backlog && pointWithin(backlog, point)) return { slot: "backlog", index: 0 };
    for (const status of BOARD_STATUSES) {
      const node = columnNodes.current.get(status);
      if (!node || !pointWithin(node.getBoundingClientRect(), point)) continue;
      return { slot: status, index: gapIndexIn(node, "article.board-page:not(.drag-hidden)", point.y) };
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
  const positionFor = (id: string, status: PageStatus, hint: CardHint<PageStatus> | null) => {
    const column = board.pages.filter((page) => page.status === status).sort(comparePosition);
    const without = column.filter((page) => page.id !== id);
    if (!hint || hint.slot !== status || status === "backlog") return { column, position: without.length };
    const visibleBase = pagesByStatus[status as (typeof BOARD_STATUSES)[number]].filter(
      (page) => page.id !== id,
    );
    const anchor = visibleBase[Math.min(hint.index, visibleBase.length)];
    const anchored = anchor ? without.findIndex((page) => page.id === anchor.id) : -1;
    return { column, position: anchored >= 0 ? anchored : without.length };
  };

  const placePage = async (id: string, status: PageStatus, hint: CardHint<PageStatus> | null) => {
    const current = board.pages.find((page) => page.id === id);
    if (!current) return;
    const { column, position } = positionFor(id, status, hint);
    // A page put back exactly where it came from is not a change worth writing.
    if (current.status === status && column.findIndex((page) => page.id === id) === position) return;
    await onUpdate(id, { status, position });
  };

  const {
    drag,
    dropHint,
    moving,
    movingItem: movingPage,
    liftedId,
    liftedItem: liftedPage,
    openedUnseen,
    pointerDrag,
    placeMoving,
    toggleMoving,
    cancelMoving,
  } = useCardBoard<PageStatus, Page>({
    items: board.pages,
    selectedId,
    hintAt,
    liftHint: (page) => ({ slot: page.status, index: slotOf(pagesByStatus, page) }),
    place: (id, hint) => placePage(id, hint.slot, hint),
  });

  const unseenPageIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "page" && event.entityId && !openedUnseen.has(event.entityId))
        ids.add(event.entityId);
    }
    return ids;
  }, [away, awayDismissed, openedUnseen]);

  return (
    <div className="board-shell" ref={shellRef}>
      <BoardTopBar
        board={board}
        busy={busy}
        projectActions={projectActions}
        unseenCount={unseenCount}
        view={view}
        onOpenAccount={() => setAccountOpen(true)}
        onOpenActivity={() => {
          setActivityOpen(true);
          setActivityVisited(true);
        }}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={changeSettingsSection}
        onViewChange={onViewChange}
      />

      {/* The wrapper stays when the digest goes, so dismissing it travels instead of jumping. */}
      <Growing className="away-digest-slot">
        {away && !awayDismissed && (
          <AwayDigest away={away} board={board} onDismiss={() => setAwayDismissed(true)} />
        )}
      </Growing>

      {movingPage && <MovingBar onCancel={cancelMoving} title={movingPage.title} />}

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

          <WorkFilters
            backlogRef={backlogNode}
            backlogPages={backlogPages}
            board={board}
            drag={drag}
            dropHint={dropHint}
            filters={filters}
            landed={landed}
            moving={moving}
            movingPage={movingPage}
            online={online}
            onMakeChapterCurrent={makeChapterCurrent}
            onManageChapters={() => changeSettingsSection("chapters")}
            onOpenBacklog={() => setBacklogOpen(true)}
            placeMoving={placeMoving}
          />

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
              const basePages = liftedId ? pages.filter((page) => page.id !== liftedId) : pages;
              const hintIndex =
                drag && dropHint?.slot === status ? Math.min(dropHint.index, basePages.length) : null;
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
                        slot={status}
                        slotName={columnNames[status]}
                        title={movingPage.title}
                      />
                    )}
                    {pages.map((page) => {
                      const hidden = liftedId === page.id;
                      const slot = hidden ? -1 : basePages.findIndex((candidate) => candidate.id === page.id);
                      return (
                        <Fragment key={page.id}>
                          {!hidden && slot === hintIndex && placeholder}
                          <PageTile
                            page={page}
                            pages={board.pages}
                            category={page.category ? categoriesBySlug.get(page.category) : undefined}
                            categoryLabel={categoryName(page.category)}
                            estimatesEnabled={board.project.estimatesEnabled}
                            fields={board.fields}
                            members={board.members}
                            hidden={hidden}
                            moving={moving === page.id}
                            unseen={unseenPageIds.has(page.id)}
                            guardClick={pointerDrag.consumeClick}
                            onOpen={() => changeSelectedPage(page.id)}
                            onPointerDown={(event) => pointerDrag.start(event, page.id)}
                            onToggleMove={() => toggleMoving(page.id)}
                          />
                          {movingPage && !hidden && (
                            <MoveSlot
                              index={slot + 1}
                              onPlace={placeMoving}
                              slot={status}
                              slotName={columnNames[status]}
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
                  {status !== "done" && (
                    <Growing className="column-add">
                      {addingTo === status ? (
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
                      )}
                    </Growing>
                  )}
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

      <BoardDialogs
        accountOpen={accountOpen}
        activityOpen={activityOpen}
        away={away}
        backlogOpen={backlogOpen}
        backlogPages={backlogPages}
        board={board}
        busy={busy}
        categoryActions={categoryActions}
        chapter={chapter}
        chapterActions={chapterActions}
        completedPages={completedPages}
        fieldActions={fieldActions}
        historyOpen={historyOpen}
        initialQuery={query}
        online={online}
        projectSettingsActions={projectSettingsActions}
        revision={revision}
        searchOpen={searchOpen}
        selectedPage={selectedPage}
        settingsSection={settingsSection}
        onAddMember={onAddMember}
        onArchive={onArchive}
        onAsk={onAsk}
        onChangeAvatar={onChangeAvatar}
        onChangeMemberRole={onChangeMemberRole}
        onChangeName={onChangeName}
        onChangePassword={onChangePassword}
        onCloseAccount={() => setAccountOpen(false)}
        onCloseActivity={() => setActivityOpen(false)}
        onCloseBacklog={() => setBacklogOpen(false)}
        onCloseHistory={() => setHistoryOpen(false)}
        onCloseSearch={() => setSearchOpen(false)}
        onCreateInvite={onCreateInvite}
        onLoadActivity={onLoadActivity}
        onLoadDiscussion={onLoadDiscussion}
        onLogout={onLogout}
        onMoveBacklogToNext={onMoveBacklogToNext}
        onOpenIdeaFromSearch={openIdeaFromSearch}
        onOpenPageFromSearch={openPageFromSearch}
        onRemoveAvatar={onRemoveAvatar}
        onRemoveMember={onRemoveMember}
        onReply={onReply}
        onRestorePage={onRestorePage}
        onSectionChange={changeSettingsSection}
        onSeeDiscussion={onSeeDiscussion}
        onSelectPage={changeSelectedPage}
        onSetAnswered={onSetAnswered}
        onUpdate={onUpdate}
      />
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
      {pointerDrag.lift && liftedPage && (
        <LiftedGhost
          cardClass="board-page"
          labelClass="page-open"
          lift={pointerDrag.lift}
          title={liftedPage.title}
        />
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

/** Where a page currently sits among the ones its column is showing. */
function slotOf(pagesByStatus: Record<(typeof BOARD_STATUSES)[number], Page[]>, page: Page): number {
  const column = pagesByStatus[page.status as (typeof BOARD_STATUSES)[number]];
  const index = column?.findIndex((candidate) => candidate.id === page.id) ?? -1;
  return index >= 0 ? index : 0;
}
