import { useEffect, useRef, useState } from "react";
import {
  CARD_CATEGORIES,
  CARD_STATUSES,
  type Card,
  type CardCategory,
  type CardStatus,
  type Member,
} from "../../shared/types";
import { initials } from "./initials";

const labels: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

const categoryLabels: Record<CardCategory, string> = {
  design: "Design",
  code: "Code",
  modeling: "Modeling",
  texturing: "Texturing",
  animation: "Animation",
  narrative: "Narrative",
  audio: "Audio",
  ui: "UI",
  vfx: "VFX",
  production: "Production",
};

type Props = {
  card: Card;
  cards: Card[];
  members: Member[];
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
};

export function CardDialog({ card, cards, members, onUpdate, onArchive, onClose }: Props) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [saveState, setSaveState] = useState("saved");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [findingBlocker, setFindingBlocker] = useState(false);
  const [blockerQuery, setBlockerQuery] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateRef = useRef(onUpdate);
  const draftRef = useRef({ title, description });
  const lastSavedRef = useRef({ title: card.title, description: card.description });

  updateRef.current = onUpdate;
  draftRef.current = { title, description };

  useEffect(() => {
    setTitle(card.title);
    setDescription(card.description);
    setSaveState("saved");
    setFindingBlocker(false);
    setBlockerQuery("");
    lastSavedRef.current = { title: card.title, description: card.description };
  }, [card.id]);

  const blockers = card.blockedBy
    .map((id) => cards.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Card => Boolean(candidate));
  const normalizedBlockerQuery = blockerQuery.trim().toLowerCase();
  const blockerResults = normalizedBlockerQuery
    ? cards
      .filter((candidate) =>
        candidate.id !== card.id &&
        candidate.status !== "done" &&
        !card.blockedBy.includes(candidate.id) &&
        `${candidate.title}\n${candidate.category ?? "uncategorized"}`.toLowerCase().includes(normalizedBlockerQuery))
      .slice(0, 6)
    : [];

  const addBlocker = async (id: string) => {
    await onUpdate({ blockedBy: [...card.blockedBy, id] });
    setFindingBlocker(false);
    setBlockerQuery("");
  };

  const removeBlocker = (id: string) => onUpdate({
    blockedBy: card.blockedBy.filter((dependencyId) => dependencyId !== id),
  });

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = { title: title.trim(), description: description.trim() };
    if (!next.title) {
      setSaveState("title required");
      return;
    }
    if (next.title === lastSavedRef.current.title && next.description === lastSavedRef.current.description) {
      setSaveState("saved");
      return;
    }

    setSaveState("changes pending");
    timerRef.current = setTimeout(() => {
      setSaveState("saving...");
      void updateRef.current(next).then(() => {
        lastSavedRef.current = next;
        const latest = { title: draftRef.current.title.trim(), description: draftRef.current.description.trim() };
        setSaveState(latest.title === next.title && latest.description === next.description ? "saved" : "changes pending");
      }).catch(() => setSaveState("save failed"));
    }, 500);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [title, description, card.id]);

  const close = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = { title: title.trim(), description: description.trim() };
    if (!next.title) {
      setSaveState("title required");
      return;
    }
    if (next.title !== lastSavedRef.current.title || next.description !== lastSavedRef.current.description) {
      setSaveState("saving...");
      try {
        await updateRef.current(next);
      } catch {
        setSaveState("save failed");
        return;
      }
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section aria-labelledby="card-dialog-title" aria-modal="true" className="card-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">card details</p><h2 id="card-dialog-title">Edit card</h2></div>
          <button aria-label="Close card" className="icon-button" onClick={() => void close()} type="button">×</button>
        </header>

        <div className="card-form">
          <label><span>Title</span><input name="title" onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label><span>Notes</span><textarea name="description" onChange={(event) => setDescription(event.target.value)} placeholder="Add only the context someone needs to act..." rows={6} value={description} /></label>
          <div aria-live="polite" className={`autosave-state ${saveState.replaceAll(" ", "-")}`}><span className="autosave-dot" />{saveState}</div>
        </div>

        <div className="dialog-section">
          <span className="field-label">Category</span>
          <div className="choice-grid category-choices">
            <button
              aria-label="Clear category"
              className={!card.category ? "choice active" : "choice"}
              onClick={() => onUpdate({ category: null })}
              type="button"
            >
              uncategorized
            </button>
            {CARD_CATEGORIES.map((category) => (
              <button
                aria-label={`Categorize as ${categoryLabels[category]}`}
                className={card.category === category ? "choice active" : "choice"}
                key={category}
                onClick={() => onUpdate({ category })}
                type="button"
              >
                <span className={`category-swatch category-${category}`} />{categoryLabels[category]}
              </button>
            ))}
          </div>
        </div>

        <div className="dialog-section dependency-section">
          <span className="field-label">Blocked by</span>
          {blockers.length > 0 ? (
            <div className="dependency-list">
              {blockers.map((blocker) => (
                <div className={blocker.status === "done" ? "dependency resolved" : "dependency"} key={blocker.id}>
                  <span className={`category-swatch category-${blocker.category ?? "none"}`} />
                  <span><strong>{blocker.title}</strong><small>{blocker.status === "done" ? "resolved" : labels[blocker.status]}</small></span>
                  <button aria-label={`Remove blocker ${blocker.title}`} onClick={() => void removeBlocker(blocker.id)} type="button">×</button>
                </div>
              ))}
            </div>
          ) : <p className="empty-dependencies">This card can move forward now.</p>}
          {findingBlocker ? (
            <div className="dependency-search">
              <label>
                <span className="sr-only">Find a blocking card</span>
                <input
                  aria-label="Find a blocking card"
                  autoFocus
                  onChange={(event) => setBlockerQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setFindingBlocker(false); }}
                  placeholder="Type a card title..."
                  type="search"
                  value={blockerQuery}
                />
              </label>
              {normalizedBlockerQuery && (
                <div className="dependency-results">
                  {blockerResults.map((candidate) => (
                    <button
                      aria-label={`Blocked by ${candidate.title}`}
                      key={candidate.id}
                      onClick={() => void addBlocker(candidate.id)}
                      type="button"
                    >
                      <span className={`category-swatch category-${candidate.category ?? "none"}`} />
                      <span><strong>{candidate.title}</strong><small>{candidate.category ?? "uncategorized"}</small></span>
                    </button>
                  ))}
                  {blockerResults.length === 0 && <p>No matching open cards.</p>}
                </div>
              )}
              <button className="text-button" onClick={() => { setFindingBlocker(false); setBlockerQuery(""); }} type="button">cancel</button>
            </div>
          ) : (
            <button aria-label="Add blocking card" className="add-dependency" onClick={() => setFindingBlocker(true)} type="button">+ add blocking card</button>
          )}
        </div>

        <div className="dialog-section">
          <span className="field-label">Who is working on it?</span>
          <div className="choice-grid assignee-choices">
            <button className={!card.assigneeId ? "choice active" : "choice"} onClick={() => onUpdate({ assigneeId: null })} type="button">unassigned</button>
            {members.map((member) => (
              <button
                aria-label={`Assign ${member.name}`}
                className={card.assigneeId === member.id ? "choice active" : "choice"}
                key={member.id}
                onClick={() => onUpdate({ assigneeId: member.id })}
                type="button"
              >
                <span className="avatar tiny">{initials(member.name)}</span>{member.name}
              </button>
            ))}
          </div>
        </div>

        <div className="dialog-section">
          <span className="field-label">Column</span>
          <div className="choice-grid status-choices">
            {CARD_STATUSES.map((status) => (
              <button
                aria-label={`Move to ${labels[status]}`}
                className={card.status === status ? "choice active" : "choice"}
                key={status}
                onClick={() => onUpdate({ status, position: 99_999 })}
                type="button"
              >
                <span className={`column-dot ${status}`} />{labels[status]}
              </button>
            ))}
          </div>
        </div>

        <footer className="dialog-footer">
          <span>created by {card.createdByName}</span>
          {confirmArchive ? (
            <div className="archive-confirm"><span>archive this card?</span><button className="danger-button" onClick={onArchive} type="button">yes, archive</button><button className="text-button" onClick={() => setConfirmArchive(false)} type="button">cancel</button></div>
          ) : <button className="text-button danger-text" onClick={() => setConfirmArchive(true)} type="button">archive card</button>}
        </footer>
      </section>
    </div>
  );
}
