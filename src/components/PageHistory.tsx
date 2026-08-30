import { useMemo } from "react";
import type { AuditEvent, Member } from "../../shared/types";
import { describeChange, describeEvent, relativeLabel } from "../lib/activity-copy";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";

/**
 * The header is always present so the section never appears or resizes on its own;
 * only what someone asked to see is drawn.
 */
export function PageHistory({
  events,
  members,
  onToggle,
  open,
}: {
  events: AuditEvent[] | null;
  members: Member[];
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <Growing className="dialog-section page-history">
      <button aria-expanded={open} className="history-toggle" onClick={onToggle} type="button">
        <span aria-hidden="true" className="history-caret">
          {open ? "▾" : "▸"}
        </span>
        <span className="field-label">History</span>
      </button>
      {open && <HistoryEvents events={events} members={members} />}
    </Growing>
  );
}

function HistoryEvents({ events, members }: { events: AuditEvent[] | null; members: Member[] }) {
  const now = useMemo(() => new Date(), [events]);
  if (events === null) return <p className="empty-dependencies">Reading the record...</p>;
  if (events.length === 0) return <p className="empty-dependencies">No recorded changes yet.</p>;
  return (
    <ol>
      {events.map((event) => {
        const { lead } = describeEvent(event);
        const actor = members.find((member) => member.id === event.actorId);
        return (
          <li key={event.id}>
            <Avatar avatarUrl={actor?.avatarUrl} className="avatar tiny" name={event.actorName} />
            <span>
              <strong>{event.actorName}</strong>
              {event.agentName && <span className="via-agent"> via {event.agentName}</span>} {lead}
              {event.changes.length > 0 && (
                <span className="activity-changes">
                  {event.changes.map((change) => (
                    <span key={change.field}>{describeChange(change)}</span>
                  ))}
                </span>
              )}
            </span>
            <time dateTime={event.createdAt}>{relativeLabel(event.createdAt, now)}</time>
          </li>
        );
      })}
    </ol>
  );
}
