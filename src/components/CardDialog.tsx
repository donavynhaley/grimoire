import { useEffect, useRef, useState } from "react";
import { CARD_STATUSES, type Card, type CardStatus, type Member } from "../../shared/types";
import { initials } from "./Board";

const labels: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
};

type Props = {
  card: Card;
  members: Member[];
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
};

export function CardDialog({ card, members, onUpdate, onArchive, onClose }: Props) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [saveState, setSaveState] = useState("saved");
  const [confirmArchive, setConfirmArchive] = useState(false);
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
    lastSavedRef.current = { title: card.title, description: card.description };
  }, [card.id]);

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
