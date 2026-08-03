import { type DragEvent, type FormEvent, useEffect, useMemo, useState } from "react";
import { CARD_STATUSES, type BoardWorkspace, type Card, type CardStatus, type IdeaState, type IdeaWorkspace } from "../../shared/types";
import { AccountDialog } from "./AccountDialog";
import { CardDialog } from "./CardDialog";
import { TeamDialog } from "./TeamDialog";
import { IdeasBoard } from "./IdeasBoard";

const columnNames: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
};

type Props = {
  board: BoardWorkspace;
  busy: boolean;
  ideas: IdeaWorkspace | null;
  view: "work" | "ideas";
  onCreate: (input: { title: string; status: CardStatus }) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onCreateIdea: (input: { title: string }) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onPromoteIdea: (id: string) => Promise<void>;
  onUpdateIdea: (id: string, input: { title?: string; description?: string; state?: IdeaState; position?: number }) => Promise<void>;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

export function Board({ board, busy, ideas, view, onCreate, onUpdate, onArchive, onCreateInvite, onCreateIdea, onChangePassword, onLogout, onPromoteIdea, onUpdateIdea, onViewChange }: Props) {
  const [quickTitle, setQuickTitle] = useState("");
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const initialParams = useMemo(() => new URLSearchParams(location.search), []);
  const [query, setQuery] = useState(() => initialParams.get("q") ?? "");
  const [people, setPeople] = useState<Set<string>>(
    () => new Set((initialParams.get("people") ?? "").split(",").filter(Boolean)),
  );
  const selectedCard = board.cards.find((card) => card.id === selectedId) ?? null;
  const filtersActive = query.trim() !== "" || people.size > 0;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCards = useMemo(
    () => board.cards.filter((card) => {
      if (people.size > 0 && !people.has(card.assigneeId ?? "unassigned")) return false;
      if (normalizedQuery && !`${card.title}\n${card.description}\n${card.assigneeName ?? "unassigned"}`.toLowerCase().includes(normalizedQuery)) return false;
      return true;
    }),
    [board.cards, normalizedQuery, people],
  );
  const openCount = filteredCards.filter((card) => card.status !== "done").length;

  const cardsByStatus = useMemo(
    () =>
      Object.fromEntries(
        CARD_STATUSES.map((status) => [
          status,
          filteredCards.filter((card) => card.status === status).sort((a, b) => a.position - b.position),
        ]),
      ) as Record<CardStatus, Card[]>,
    [filteredCards],
  );

  useEffect(() => {
    if (!initialParams.has("focus")) return;
    initialParams.delete("focus");
    history.replaceState({}, "", `${location.pathname}${initialParams.size ? `?${initialParams}` : ""}`);
  }, [initialParams]);

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

  const createQuickCard = async (event: FormEvent) => {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    setQuickTitle("");
    await onCreate({ title, status: "backlog" });
  };

  const createColumnCard = async (event: FormEvent, status: CardStatus) => {
    event.preventDefault();
    const title = columnTitle.trim();
    if (!title) return;
    setColumnTitle("");
    setAddingTo(null);
    await onCreate({ title, status });
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
            <button aria-current={view === "work" ? "page" : undefined} onClick={() => void onViewChange("work")} type="button">work</button>
            <button aria-current={view === "ideas" ? "page" : undefined} onClick={() => void onViewChange("ideas")} type="button">ideas</button>
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
            <h2>{openCount} open card{openCount === 1 ? "" : "s"}</h2>
          </div>
          <form className="quick-add" onSubmit={createQuickCard}>
            <label className="sr-only" htmlFor="quick-card">Add a card to backlog</label>
            <input
              id="quick-card"
              name="quickCard"
              onChange={(event) => setQuickTitle(event.target.value)}
              placeholder="Capture a thought..."
              value={quickTitle}
            />
            <button className="primary-button" disabled={busy || !quickTitle.trim()} type="submit">add card</button>
          </form>
        </div>

        <div className="work-filters" aria-label="Work filters">
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
                  <span className="avatar tiny" title={member.name}>{initials(member.name)}</span>
                  {isCurrentUser && <span>me</span>}
                </button>
              );
            })}
          </div>
          {filtersActive && <span className="filter-note">dragging paused while filtered</span>}
        </div>

        <div className="kanban" aria-label="Wizard Simulator board">
          {CARD_STATUSES.map((status) => {
            const cards = cardsByStatus[status];
            return (
              <section
                aria-label={columnNames[status]}
                className={`kanban-column column-${status}`}
                key={status}
                onDragOver={(event) => { if (!filtersActive) event.preventDefault(); }}
                onDrop={(event) => { if (!filtersActive) void moveCard(event, status, cards.length); }}
              >
                <header className="column-header">
                  <div><span className="column-dot" /><h3>{columnNames[status]}</h3></div>
                  <span className="column-count">{cards.length}</span>
                </header>
                <div className="card-list">
                  {cards.map((card, index) => (
                    <article
                      className={`board-card ${draggedId === card.id ? "dragging" : ""}`}
                      draggable={!filtersActive}
                      key={card.id}
                      onDragEnd={() => setDraggedId(null)}
                      onDragOver={(event) => { if (!filtersActive) event.preventDefault(); }}
                      onDragStart={(event) => {
                        setDraggedId(card.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", card.id);
                      }}
                      onDrop={(event) => {
                        event.stopPropagation();
                        if (!filtersActive) void moveCard(event, status, index);
                      }}
                    >
                      <button
                        aria-label={`Open ${card.title}${card.description ? `. ${card.description}` : ""}. ${card.assigneeName ?? "unassigned"}`}
                        className="card-open"
                        draggable
                        onClick={() => setSelectedId(card.id)}
                        type="button"
                      >
                        <span className="drag-grip" aria-hidden="true">⠿</span>
                        <strong>{card.title}</strong>
                        {card.description && <p>{card.description}</p>}
                        <span className={`assignee ${card.assigneeId ? "assigned" : ""}`}>
                          {card.assigneeName ? <><span className="avatar tiny">{initials(card.assigneeName)}</span>{card.assigneeName}</> : "unassigned"}
                        </span>
                      </button>
                    </article>
                  ))}
                  {cards.length === 0 && <div className="empty-column">drop a card here</div>}
                </div>
                {addingTo === status ? (
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
                )}
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
          card={selectedCard}
          members={board.members}
          onArchive={async () => { await onArchive(selectedCard.id); setSelectedId(null); }}
          onClose={() => setSelectedId(null)}
          onUpdate={(input) => onUpdate(selectedCard.id, input)}
        />
      )}
      {teamOpen && (
        <TeamDialog
          currentUser={board.currentUser}
          members={board.members}
          onClose={() => setTeamOpen(false)}
          onCreateInvite={onCreateInvite}
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

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
