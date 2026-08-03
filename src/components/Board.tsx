import { type DragEvent, type FormEvent, useMemo, useState } from "react";
import { CARD_STATUSES, type BoardWorkspace, type Card, type CardStatus } from "../../shared/types";
import { CardDialog } from "./CardDialog";
import { TeamDialog } from "./TeamDialog";

const columnNames: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
};

type Props = {
  board: BoardWorkspace;
  busy: boolean;
  onCreate: (input: { title: string; status: CardStatus }) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onLogout: () => Promise<void>;
};

export function Board({ board, busy, onCreate, onUpdate, onArchive, onCreateInvite, onLogout }: Props) {
  const [quickTitle, setQuickTitle] = useState("");
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  const [columnTitle, setColumnTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const selectedCard = board.cards.find((card) => card.id === selectedId) ?? null;
  const openCount = board.cards.filter((card) => card.status !== "done").length;

  const cardsByStatus = useMemo(
    () =>
      Object.fromEntries(
        CARD_STATUSES.map((status) => [
          status,
          board.cards.filter((card) => card.status === status).sort((a, b) => a.position - b.position),
        ]),
      ) as Record<CardStatus, Card[]>,
    [board.cards],
  );

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
        </div>
        <div className="board-project">
          <span className="eyebrow">project board</span>
          <h1>{board.project.name}</h1>
        </div>
        <div className="board-actions">
          <div className="member-faces" aria-label={`${board.members.length} project members`}>
            {board.members.slice(0, 4).map((member) => (
              <span className="avatar" key={member.id} title={member.name}>{initials(member.name)}</span>
            ))}
          </div>
          <button className="quiet-button" onClick={() => setTeamOpen(true)} type="button">team</button>
          <button className="account-button" onClick={onLogout} title="Sign out" type="button">
            <span className="avatar current">{initials(board.currentUser.name)}</span>
            <span>{board.currentUser.name}</span>
          </button>
        </div>
      </header>

      <main className="board-main">
        <div className="board-intro">
          <div>
            <p className="eyebrow">one board, one source of truth</p>
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

        <div className="kanban" aria-label="Wizard Simulator board">
          {CARD_STATUSES.map((status) => {
            const cards = cardsByStatus[status];
            return (
              <section
                aria-label={columnNames[status]}
                className={`kanban-column column-${status}`}
                key={status}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void moveCard(event, status, cards.length)}
              >
                <header className="column-header">
                  <div><span className="column-dot" /><h3>{columnNames[status]}</h3></div>
                  <span className="column-count">{cards.length}</span>
                </header>
                <div className="card-list">
                  {cards.map((card, index) => (
                    <article
                      className={`board-card ${draggedId === card.id ? "dragging" : ""}`}
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
                        void moveCard(event, status, index);
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
      </main>

      {selectedCard && (
        <CardDialog
          busy={busy}
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
      {busy && <div className="saving-indicator"><span className="connection-dot" />saving</div>}
    </div>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
