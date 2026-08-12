import { type DragEvent, type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type AuditPage, type AwayState, type BoardWorkspace, type Card, type CardStatus, type IdeaState, type IdeaWorkspace } from "../../shared/types";
import { AccountDialog } from "./AccountDialog";
import { ActivityDialog } from "./ActivityDialog";
import { Avatar } from "./Avatar";
import { AwayDigest } from "./AwayDigest";
import { BacklogDialog } from "./BacklogDialog";
import { CardDialog } from "./CardDialog";
import { type CategoryActions, CategoriesDialog } from "./CategoriesDialog";
import { DoneHistoryDialog } from "./DoneHistoryDialog";
import { type ProjectActions, ProjectMenu } from "./ProjectMenu";
import { type CaptureCardInput, QuickCapture } from "./QuickCapture";
import { SearchDialog } from "./SearchDialog";
import { TeamDialog } from "./TeamDialog";
import { plainTextFromMarkdown } from "./markdown-text";
import { IdeasBoard } from "./IdeasBoard";
import { useFlip } from "./use-flip";

const BOARD_STATUSES = ["ready", "in_progress", "review", "done"] as const satisfies readonly CardStatus[];

/**
 * Done is a hybrid column: it reads like the other three until it outgrows them, then it
 * grows a backlog-style escape hatch instead of scrolling forever. Board filters run over
 * every card before this slice, so a match buried deep in the history still surfaces here.
 */
const DONE_COLUMN_LIMIT = 10;

const columnNames: Record<CardStatus, string> = {
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
  ideas: IdeaWorkspace | null;
  online: ReadonlySet<string>;
  projectActions: ProjectActions;
  revision: number;
  view: "work" | "ideas";
  onCreate: (input: CaptureCardInput) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onCreateIdea: (input: { title: string }) => Promise<void>;
  onLoadActivity: (options: { entityId?: string; before?: number; limit?: number }) => Promise<AuditPage>;
  onChangeAvatar: (file: File) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onLogout: () => Promise<void>;
  onMoveBacklogToNext: (id: string) => Promise<void>;
  onPromoteIdea: (id: string) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onUpdateIdea: (id: string, input: Record<string, unknown>) => Promise<void>;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

export function Board({ away, board, busy, categoryActions, ideas, online, projectActions, revision, view, onCreate, onUpdate, onArchive, onCreateInvite, onCreateIdea, onChangeAvatar, onChangePassword, onLoadActivity, onLogout, onMoveBacklogToNext, onPromoteIdea, onRemoveAvatar, onRemoveMember, onUpdateIdea, onViewChange }: Props) {
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("card"),
  );
  const [drag, setDrag] = useState<{ id: string; height: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ status: CardStatus; index: number } | null>(null);
  const dragSession = useRef(0);
  const [flight, setFlight] = useState<CaptureFlight | null>(null);
  const [landed, setLanded] = useState<CardStatus | null>(null);
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
  const [activityOpen, setActivityOpen] = useState(false);
  // Once the history has been opened, its badge has done its job for this visit.
  const [activityVisited, setActivityVisited] = useState(false);
  const [awayDismissed, setAwayDismissed] = useState(false);
  // Cards the reader has opened this visit; their dots have been answered.
  const [openedUnseen, setOpenedUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const isOwner = board.currentUser.role === "owner";
  const unseenCount = away && !awayDismissed && !activityVisited ? away.total : 0;
  const unseenCardIds = useMemo(() => {
    const ids = new Set<string>();
    if (!away || awayDismissed) return ids;
    for (const event of away.events) {
      if (event.entityType === "card" && event.entityId && !openedUnseen.has(event.entityId)) ids.add(event.entityId);
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
  const selectedCard = board.cards.find((card) => card.id === selectedId) ?? null;

  // Opening a card answers its dot, whichever surface the card was opened from.
  useEffect(() => {
    if (!selectedId) return;
    setOpenedUnseen((current) => {
      if (current.has(selectedId)) return current;
      const next = new Set(current);
      next.add(selectedId);
      return next;
    });
  }, [selectedId]);

  // The open card lives in the URL, so the address bar is always a shareable
  // link to exactly what is on screen. A link to a card this board no longer
  // has simply falls away.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (selectedCard) params.set("card", selectedCard.id);
    else params.delete("card");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [selectedCard?.id]);
  const categoriesBySlug = useMemo(
    () => new Map(board.categories.map((category) => [category.slug, category])),
    [board.categories],
  );
  const categoryName = (slug: string | null) =>
    slug === null ? "uncategorized" : categoriesBySlug.get(slug)?.name ?? slug;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCards = useMemo(
    () => board.cards.filter((card) => {
      if (people.size > 0 && !people.has(card.assigneeId ?? "unassigned")) return false;
      if (normalizedQuery && !`${card.title}\n${card.description}\n${categoryName(card.category)}\n${card.assigneeName ?? "unassigned"}`.toLowerCase().includes(normalizedQuery)) return false;
      return true;
    }),
    [board.cards, categoriesBySlug, normalizedQuery, people],
  );
  const activeCount = filteredCards.filter((card) => card.status === "ready" || card.status === "in_progress" || card.status === "review").length;
  const backlogCards = board.cards.filter((card) => card.status === "backlog");
  const completedCards = board.cards.filter((card) => card.status === "done");
  const offBoardMatches = useMemo(
    () => ({
      backlog: filteredCards.filter((card) => card.status === "backlog").length,
      completed: Math.max(0, filteredCards.filter((card) => card.status === "done").length - DONE_COLUMN_LIMIT),
    }),
    [filteredCards],
  );

  const cardsByStatus = useMemo(
    () =>
      Object.fromEntries(
        BOARD_STATUSES.map((status) => [
          status,
          filteredCards
            .filter((card) => card.status === status)
            .sort(status === "done" ? compareCompletion : comparePosition)
            .slice(0, status === "done" ? DONE_COLUMN_LIMIT : undefined),
        ]),
      ) as Record<(typeof BOARD_STATUSES)[number], Card[]>,
    [filteredCards],
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
          (target.id === "quick-card" || target.id === "capture-idea") &&
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

  const openCardFromSearch = (id: string) => {
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

  const updateUrl = (nextQuery: string, nextPeople: Set<string>) => {
    const params = new URLSearchParams(location.search);
    params.delete("focus");
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    else params.delete("q");
    if (nextPeople.size) params.set("people", [...nextPeople].join(","));
    else params.delete("people");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    updateUrl(value, people);
  };

  const togglePerson = (id: string) => {
    const next = new Set(people);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPeople(next);
    updateUrl(query, next);
  };

  const spawnFlight = (input: CaptureCardInput) => {
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

  const captureCard = async (input: CaptureCardInput) => {
    spawnFlight(input);
    await onCreate(input);
  };

  const createColumnCard = async (event: FormEvent, status: CardStatus) => {
    event.preventDefault();
    const title = columnTitle.trim();
    if (!title) return;
    setColumnTitle("");
    setAddingTo(null);
    await onCreate({ title, category: null, assigneeId: null, status });
  };

  const finishDrag = () => {
    dragSession.current += 1;
    setDrag(null);
    setDropHint(null);
  };

  const startCardDrag = (event: DragEvent<HTMLElement>, card: Card, slot: number) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.id);
    const height = event.currentTarget.offsetHeight;
    const session = ++dragSession.current;
    // Hide the card one frame later so the browser captures a visible drag image first.
    requestAnimationFrame(() => {
      if (dragSession.current !== session) return;
      setDrag({ id: card.id, height });
      setDropHint({ status: card.status, index: slot });
    });
  };

  const trackColumnDrag = (event: DragEvent<HTMLElement>, status: CardStatus) => {
    event.preventDefault();
    if (!drag) return;
    const cardNodes = event.currentTarget.querySelectorAll<HTMLElement>("article.board-card:not(.drag-hidden)");
    let index = cardNodes.length;
    for (let position = 0; position < cardNodes.length; position += 1) {
      const rect = cardNodes[position].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        index = position;
        break;
      }
    }
    setDropHint((current) => (current?.status === status && current.index === index ? current : { status, index }));
  };

  const dropCard = async (event: DragEvent, status: CardStatus) => {
    event.preventDefault();
    const id = drag?.id ?? event.dataTransfer.getData("text/plain");
    const hint = dropHint;
    finishDrag();
    if (!id) return;
    const current = board.cards.find((card) => card.id === id);
    if (!current) return;
    const column = board.cards.filter((card) => card.status === status).sort(comparePosition);
    const without = column.filter((card) => card.id !== id);
    let position = without.length;
    if (hint && hint.status === status && status !== "backlog") {
      const visibleBase = cardsByStatus[status as (typeof BOARD_STATUSES)[number]]
        .filter((card) => card.id !== id);
      const anchor = visibleBase[Math.min(hint.index, visibleBase.length)];
      const anchored = anchor ? without.findIndex((card) => card.id === anchor.id) : -1;
      position = anchored >= 0 ? anchored : without.length;
    }
    if (current.status === status && column.findIndex((card) => card.id === id) === position) return;
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
            onManageCategories={() => setCategoriesOpen(true)}
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
            <h2>{activeCount} active card{activeCount === 1 ? "" : "s"}</h2>
          </div>
          <QuickCapture busy={busy} categories={board.categories} members={board.members} onCreate={captureCard} />
        </div>

        <div className="work-filters" aria-label="Work filters">
          <button
            aria-label={`Open backlog, ${backlogCards.length} card${backlogCards.length === 1 ? "" : "s"}`}
            className={`library-trigger ${drag ? "drop-ready" : ""} ${landed === "backlog" ? "landed" : ""}`}
            onClick={() => setBacklogOpen(true)}
            onDragOver={(event) => { if (drag) { event.preventDefault(); setDropHint(null); } }}
            onDrop={(event) => void dropCard(event, "backlog")}
            title="Backlog (B)"
            type="button"
          >
            <span>Backlog</span><strong>{backlogCards.length}</strong><kbd aria-hidden="true">B</kbd>
          </button>
          <label className="card-search">
            <span className="sr-only">Search cards</span>
            <input aria-label="Search cards" name="cardSearch" onChange={(event) => changeQuery(event.target.value)} placeholder="Search cards..." type="search" value={query} />
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

        <div className="kanban" aria-label="Wizard Simulator board" ref={kanbanRef}>
          {BOARD_STATUSES.map((status) => {
            const cards = cardsByStatus[status];
            const baseCards = drag ? cards.filter((card) => card.id !== drag.id) : cards;
            const hintIndex = drag && dropHint?.status === status ? Math.min(dropHint.index, baseCards.length) : null;
            const placeholder = drag
              ? <div aria-hidden="true" className="drop-placeholder" data-flip-id="drop-placeholder" style={{ height: drag.height }} />
              : null;
            const visibleStatusCount = filteredCards.filter((card) => card.status === status).length;
            return (
              <section
                aria-label={columnNames[status]}
                className={`kanban-column column-${status} ${landed === status ? "landed" : ""}`}
                key={status}
                onDragOver={(event) => trackColumnDrag(event, status)}
                onDrop={(event) => void dropCard(event, status)}
              >
                <header className="column-header">
                  <div><span className="column-dot" /><h3>{columnNames[status]}</h3></div>
                  <span className="column-count">{status === "done" && visibleStatusCount > DONE_COLUMN_LIMIT ? `${cards.length} of ${visibleStatusCount}` : visibleStatusCount}</span>
                </header>
                <div className="card-list">
                  {cards.map((card) => {
                    const hidden = drag?.id === card.id;
                    const slot = hidden ? -1 : baseCards.findIndex((candidate) => candidate.id === card.id);
                    const blockers = card.blockedBy
                      .map((id) => board.cards.find((candidate) => candidate.id === id))
                      .filter((candidate): candidate is Card => Boolean(candidate && candidate.status !== "done"));
                    const category = card.category ? categoriesBySlug.get(card.category) : undefined;
                    const preview = card.description ? plainTextFromMarkdown(card.description) : "";
                    const unseen = unseenCardIds.has(card.id);
                    return (
                      <Fragment key={card.id}>
                      {!hidden && slot === hintIndex && placeholder}
                      <article
                        className={`board-card ${card.category ? "" : "category-none"} ${hidden ? "drag-hidden" : ""} ${unseen ? "unseen" : ""}`}
                        data-flip-id={card.id}
                        draggable
                        onDragEnd={finishDrag}
                        onDragStart={(event) => startCardDrag(event, card, slot)}
                        style={category ? ({ "--category-color": category.color } as React.CSSProperties) : undefined}
                      >
                        <button
                          aria-label={`Open ${card.title}${preview ? `. ${preview}` : ""}. ${categoryName(card.category)}. ${blockers.length ? `Blocked by ${blockers.map((blocker) => blocker.title).join(", ")}. ` : ""}${card.assigneeName ?? "unassigned"}${unseen ? ". Changed while you were away" : ""}`}
                          className="card-open"
                          draggable
                          onClick={() => setSelectedId(card.id)}
                          type="button"
                        >
                          <span className="drag-grip" aria-hidden="true">⠿</span>
                          {(card.category || blockers.length > 0) && <span className="card-signals">
                            {card.category && <span className="category-pill">{categoryName(card.category)}</span>}
                            {blockers.length > 0 && <span className="card-blocked">blocked by {blockers.length}</span>}
                          </span>}
                          <strong>{card.title}</strong>
                          {preview && <p>{preview}</p>}
                          <span className={`assignee ${card.assigneeId ? "assigned" : ""}`}>
                            {card.assigneeName ? <>
                              <Avatar
                                avatarUrl={board.members.find((member) => member.id === card.assigneeId)?.avatarUrl}
                                className="avatar tiny"
                                name={card.assigneeName}
                              />
                              {card.assigneeName}
                            </> : "unassigned"}
                          </span>
                        </button>
                      </article>
                      </Fragment>
                    );
                  })}
                  {hintIndex !== null && hintIndex === baseCards.length && placeholder}
                  {cards.length === 0 && hintIndex === null && <div className="empty-column">{status === "done" ? "completed work appears here" : "drop a card here"}</div>}
                </div>
                {status === "done" && completedCards.length > DONE_COLUMN_LIMIT && (
                  <button
                    aria-label={`Search all completed work, ${completedCards.length} cards`}
                    className="library-trigger completed-trigger"
                    onClick={() => setHistoryOpen(true)}
                    type="button"
                  >
                    <span>all completed</span><strong>{completedCards.length}</strong>
                  </button>
                )}
                {status !== "done" && (addingTo === status ? (
                  <form className="column-add-form" onSubmit={(event) => void createColumnCard(event, status)}>
                    <label className="sr-only" htmlFor={`new-${status}`}>New {columnNames[status]} card</label>
                    <input
                      autoFocus
                      id={`new-${status}`}
                      name={`new-${status}`}
                      onChange={(event) => setColumnTitle(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setAddingTo(null); }}
                      placeholder="Card title"
                      value={columnTitle}
                    />
                    <div><button className="primary-button compact" disabled={!columnTitle.trim()} type="submit">add</button><button className="text-button" onClick={() => setAddingTo(null)} type="button">cancel</button></div>
                  </form>
                ) : (
                  <button className="add-to-column" onClick={() => { setAddingTo(status); setColumnTitle(""); }} type="button">+ add card</button>
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
          onOpenCard={openCardFromSearch}
          onOpenIdea={openIdeaFromSearch}
        />
      )}
      {selectedCard && (
        <CardDialog
          cards={board.cards}
          card={selectedCard}
          categories={board.categories}
          currentUserId={board.currentUser.id}
          members={board.members}
          revision={revision}
          onArchive={async () => { await onArchive(selectedCard.id); setSelectedId(null); }}
          onClose={() => setSelectedId(null)}
          onLoadActivity={onLoadActivity}
          onUpdate={(input) => onUpdate(selectedCard.id, input)}
        />
      )}
      {activityOpen && (
        <ActivityDialog
          awaySince={away?.since}
          members={board.members}
          revision={revision}
          onClose={() => setActivityOpen(false)}
          onLoad={onLoadActivity}
          onOpenCard={(id) => {
            if (!board.cards.some((card) => card.id === id)) return;
            setActivityOpen(false);
            setSelectedId(id);
          }}
        />
      )}
      {backlogOpen && (
        <BacklogDialog
          allCards={board.cards}
          busy={busy}
          cards={backlogCards}
          categories={board.categories}
          members={board.members}
          onClose={() => setBacklogOpen(false)}
          onMoveToNext={onMoveBacklogToNext}
          onOpenCard={(id) => { setBacklogOpen(false); setSelectedId(id); }}
        />
      )}
      {historyOpen && (
        <DoneHistoryDialog
          busy={busy}
          cards={completedCards}
          categories={board.categories}
          members={board.members}
          onClose={() => setHistoryOpen(false)}
          onOpenCard={(id) => { setHistoryOpen(false); setSelectedId(id); }}
          onReopen={async (id) => {
            setHistoryOpen(false);
            await onUpdate(id, { status: "ready", position: board.cards.filter((card) => card.status === "ready").length });
          }}
        />
      )}
      {categoriesOpen && (
        <CategoriesDialog
          actions={categoryActions}
          busy={busy}
          categories={board.categories}
          onClose={() => setCategoriesOpen(false)}
        />
      )}
      {teamOpen && (
        <TeamDialog
          currentUser={board.currentUser}
          members={board.members}
          online={online}
          onClose={() => setTeamOpen(false)}
          onCreateInvite={onCreateInvite}
          onRemoveMember={onRemoveMember}
        />
      )}
      {accountOpen && (
        <AccountDialog
          onChangeAvatar={onChangeAvatar}
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
  status: CardStatus;
  from: { x: number; y: number; width: number };
  to: { x: number; y: number };
};

function comparePosition(left: Card, right: Card): number {
  return left.position - right.position;
}

function compareCompletion(left: Card, right: Card): number {
  const timestamp = (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
  return timestamp || right.position - left.position;
}
