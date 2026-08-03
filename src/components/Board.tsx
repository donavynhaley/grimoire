import { type DragEvent, type FormEvent, useEffect, useMemo, useState } from "react";
import { type BoardWorkspace, type Card, type CardStatus, type IdeaState, type IdeaWorkspace } from "../../shared/types";
import { AccountDialog } from "./AccountDialog";
import { BacklogDialog } from "./BacklogDialog";
import { CardDialog } from "./CardDialog";
import { DoneHistoryDialog } from "./DoneHistoryDialog";
import { initials } from "./initials";
import { type CaptureCardInput, QuickCapture } from "./QuickCapture";
import { TeamDialog } from "./TeamDialog";
import { IdeasBoard } from "./IdeasBoard";

const BOARD_STATUSES = ["ready", "in_progress", "done"] as const satisfies readonly CardStatus[];
const RECENT_DONE_LIMIT = 8;

const columnNames: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  done: "Done",
};

type Props = {
  board: BoardWorkspace;
  busy: boolean;
  ideas: IdeaWorkspace | null;
  view: "work" | "ideas";
  onCreate: (input: CaptureCardInput) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onCreateIdea: (input: { title: string }) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onMoveBacklogToNext: (id: string) => Promise<void>;
  onPromoteIdea: (id: string) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onUpdateIdea: (id: string, input: { title?: string; description?: string; state?: IdeaState; position?: number }) => Promise<void>;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

export function Board({ board, busy, ideas, view, onCreate, onUpdate, onArchive, onCreateInvite, onCreateIdea, onChangePassword, onLogout, onMoveBacklogToNext, onPromoteIdea, onRemoveMember, onUpdateIdea, onViewChange }: Props) {
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const initialParams = useMemo(() => new URLSearchParams(location.search), []);
  const [query, setQuery] = useState(() => initialParams.get("q") ?? "");
  const [people, setPeople] = useState<Set<string>>(
    () => new Set((initialParams.get("people") ?? "").split(",").filter(Boolean)),
  );
  const selectedCard = board.cards.find((card) => card.id === selectedId) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCards = useMemo(
    () => board.cards.filter((card) => {
      if (people.size > 0 && !people.has(card.assigneeId ?? "unassigned")) return false;
      if (normalizedQuery && !`${card.title}\n${card.description}\n${card.category ?? "uncategorized"}\n${card.assigneeName ?? "unassigned"}`.toLowerCase().includes(normalizedQuery)) return false;
      return true;
    }),
    [board.cards, normalizedQuery, people],
  );
  const activeCount = filteredCards.filter((card) => card.status === "ready" || card.status === "in_progress").length;
  const backlogCards = board.cards.filter((card) => card.status === "backlog");
  const completedCards = board.cards.filter((card) => card.status === "done");

  const cardsByStatus = useMemo(
    () =>
      Object.fromEntries(
        BOARD_STATUSES.map((status) => [
          status,
          filteredCards
            .filter((card) => card.status === status)
            .sort(status === "done" ? compareCompletion : comparePosition)
            .slice(0, status === "done" ? RECENT_DONE_LIMIT : undefined),
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
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
        const isEmptyCapture =
          target instanceof HTMLInputElement &&
          (target.id === "quick-card" || target.id === "capture-idea") &&
          target.value.length === 0;
        if (event.key.toLowerCase() === "b" || !isEmptyCapture) return;
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

  const createColumnCard = async (event: FormEvent, status: CardStatus) => {
    event.preventDefault();
    const title = columnTitle.trim();
    if (!title) return;
    setColumnTitle("");
    setAddingTo(null);
    await onCreate({ title, category: null, assigneeId: null, status });
  };

  const cardIdFromDrop = (event: DragEvent) => draggedId ?? event.dataTransfer.getData("text/plain");
  const moveCard = async (event: DragEvent, status: CardStatus, position: number) => {
    event.preventDefault();
    const id = cardIdFromDrop(event);
    setDraggedId(null);
    if (!id) return;
    const current = board.cards.find((card) => card.id === id);
    if (!current || (current.status === status && current.position === position)) return;
    await onUpdate(id, { status, position });
  };

  return (
    <div className="board-shell">
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
          <h1>{board.project.name}</h1>
        </div>
        <div className="board-actions">
          <div className="member-faces" aria-label={`${board.members.length} project members`}>
            {board.members.slice(0, 4).map((member) => (
              <span className="avatar" key={member.id} title={member.name}>{initials(member.name)}</span>
            ))}
          </div>
          <button className="quiet-button" onClick={() => setTeamOpen(true)} type="button">team</button>
          <button aria-label={`Open account settings for ${board.currentUser.name}`} className="account-button" onClick={() => setAccountOpen(true)} title="Account settings" type="button">
            <span className="avatar current">{initials(board.currentUser.name)}</span>
            <span>{board.currentUser.name}</span>
          </button>
        </div>
      </header>

      {view === "work" ? <main className="board-main">
        <div className="board-intro">
          <div>
            <h2>{activeCount} active card{activeCount === 1 ? "" : "s"}</h2>
          </div>
          <QuickCapture busy={busy} members={board.members} onCreate={onCreate} />
        </div>

        <div className="work-filters" aria-label="Work filters">
          <button
            aria-label={`Open backlog, ${backlogCards.length} card${backlogCards.length === 1 ? "" : "s"}`}
            className={`library-trigger ${draggedId ? "drop-ready" : ""}`}
            onClick={() => setBacklogOpen(true)}
            onDragOver={(event) => { if (draggedId) event.preventDefault(); }}
            onDrop={(event) => void moveCard(event, "backlog", backlogCards.length)}
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
                  <span className="avatar tiny" title={member.name}>{initials(member.name)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="kanban" aria-label="Wizard Simulator board">
          {BOARD_STATUSES.map((status) => {
            const cards = cardsByStatus[status];
            const visibleStatusCount = filteredCards.filter((card) => card.status === status).length;
            const fullColumnLength = board.cards.filter((card) => card.status === status).length;
            return (
              <section
                aria-label={columnNames[status]}
                className={`kanban-column column-${status}`}
                key={status}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void moveCard(event, status, fullColumnLength)}
              >
                <header className="column-header">
                  {status === "done" ? (
                    <button
                      aria-label={`Open completed work history, ${visibleStatusCount} total`}
                      className="done-history-trigger"
                      onClick={() => setHistoryOpen(true)}
                      type="button"
                    ><span className="column-dot" /><h3>{columnNames[status]}</h3></button>
                  ) : <div><span className="column-dot" /><h3>{columnNames[status]}</h3></div>}
                  <span className="column-count">{status === "done" && visibleStatusCount > RECENT_DONE_LIMIT ? `${cards.length} of ${visibleStatusCount}` : visibleStatusCount}</span>
                </header>
                <div className="card-list">
                  {cards.map((card) => {
                    const blockers = card.blockedBy
                      .map((id) => board.cards.find((candidate) => candidate.id === id))
                      .filter((candidate): candidate is Card => Boolean(candidate && candidate.status !== "done"));
                    return (
                      <article
                        className={`board-card category-${card.category ?? "none"} ${draggedId === card.id ? "dragging" : ""}`}
                        draggable
                        key={card.id}
                        onDragEnd={() => setDraggedId(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDragStart={(event) => {
                          setDraggedId(card.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", card.id);
                        }}
                        onDrop={(event) => {
                          event.stopPropagation();
                          void moveCard(event, status, card.position);
                        }}
                      >
                        <button
                          aria-label={`Open ${card.title}${card.description ? `. ${card.description}` : ""}. ${card.category ?? "uncategorized"}. ${blockers.length ? `Blocked by ${blockers.map((blocker) => blocker.title).join(", ")}. ` : ""}${card.assigneeName ?? "unassigned"}`}
                          className="card-open"
                          draggable
                          onClick={() => setSelectedId(card.id)}
                          type="button"
                        >
                          <span className="drag-grip" aria-hidden="true">⠿</span>
                          {(card.category || blockers.length > 0) && <span className="card-signals">
                            {card.category && <span className={`category-pill category-${card.category}`}>{card.category}</span>}
                            {blockers.length > 0 && <span className="card-blocked">blocked by {blockers.length}</span>}
                          </span>}
                          <strong>{card.title}</strong>
                          {card.description && <p>{card.description}</p>}
                          <span className={`assignee ${card.assigneeId ? "assigned" : ""}`}>
                            {card.assigneeName ? <><span className="avatar tiny">{initials(card.assigneeName)}</span>{card.assigneeName}</> : "unassigned"}
                          </span>
                        </button>
                      </article>
                    );
                  })}
                  {cards.length === 0 && <div className="empty-column">{status === "done" ? "completed work appears here" : "drop a card here"}</div>}
                </div>
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
            workspace={ideas}
            onCreate={onCreateIdea}
            onPromote={onPromoteIdea}
            onUpdate={onUpdateIdea}
          />
        ) : <main className="ideas-main"><p className="ideas-loading">opening the idea garden...</p></main>
      )}

      {selectedCard && (
        <CardDialog
          cards={board.cards}
          card={selectedCard}
          members={board.members}
          onArchive={async () => { await onArchive(selectedCard.id); setSelectedId(null); }}
          onClose={() => setSelectedId(null)}
          onUpdate={(input) => onUpdate(selectedCard.id, input)}
        />
      )}
      {backlogOpen && (
        <BacklogDialog
          allCards={board.cards}
          busy={busy}
          cards={backlogCards}
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
          members={board.members}
          onClose={() => setHistoryOpen(false)}
          onOpenCard={(id) => { setHistoryOpen(false); setSelectedId(id); }}
          onReopen={async (id) => {
            setHistoryOpen(false);
            await onUpdate(id, { status: "ready", position: board.cards.filter((card) => card.status === "ready").length });
          }}
        />
      )}
      {teamOpen && (
        <TeamDialog
          currentUser={board.currentUser}
          members={board.members}
          onClose={() => setTeamOpen(false)}
          onCreateInvite={onCreateInvite}
          onRemoveMember={onRemoveMember}
        />
      )}
      {accountOpen && (
        <AccountDialog
          onChangePassword={onChangePassword}
          onClose={() => setAccountOpen(false)}
          onLogout={onLogout}
          user={board.currentUser}
        />
      )}
      {busy && <div className="saving-indicator"><span className="connection-dot" />saving</div>}
    </div>
  );
}

function comparePosition(left: Card, right: Card): number {
  return left.position - right.position;
}

function compareCompletion(left: Card, right: Card): number {
  const timestamp = (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
  return timestamp || right.position - left.position;
}
