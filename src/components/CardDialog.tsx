import { type FormEvent, useEffect, useState } from "react";
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
  busy: boolean;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
};

export function CardDialog({ card, members, busy, onUpdate, onArchive, onClose }: Props) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    setTitle(card.title);
    setDescription(card.description);
  }, [card.id, card.title, card.description]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onUpdate({ title: title.trim(), description: description.trim() });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="card-dialog-title" aria-modal="true" className="card-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">card details</p><h2 id="card-dialog-title">Edit card</h2></div>
          <button aria-label="Close card" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <form className="card-form" onSubmit={save}>
          <label><span>Title</span><input name="title" onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label><span>Notes</span><textarea name="description" onChange={(event) => setDescription(event.target.value)} placeholder="Add only the context someone needs to act..." rows={6} value={description} /></label>
          <button className="primary-button save-card" disabled={busy || !title.trim()} type="submit">save changes</button>
        </form>

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
