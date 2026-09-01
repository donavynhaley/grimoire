import type { AuditEvent, Member } from "../../shared/types";
import { describeChange, describeEvent, timeLabel } from "../lib/activity-copy";
import { Avatar } from "./Avatar";

/**
 * One activity log entry, as every surface that lists them draws it: the activity
 * history and the agent review share this row so an event reads the same wherever
 * it is encountered.
 */
export function ActivityRow({
  event,
  members,
  onOpenPage,
}: {
  event: AuditEvent;
  members: Member[];
  onOpenPage?: (id: string) => void;
}) {
  const { lead, title } = describeEvent(event);
  const actor = members.find((member) => member.id === event.actorId);
  const body = (
    <>
      <Avatar avatarUrl={actor?.avatarUrl} className="avatar tiny" name={event.actorName} />
      <span className="activity-copy">
        <span className="activity-line">
          <strong>{event.actorName}</strong>
          {/* Machine writes must be tellable from the person's own, or delegating an
              agent would quietly launder its work into theirs. */}
          {event.agentName && <span className="via-agent"> via {event.agentName}</span>} {lead}
          {title && (
            <>
              {" "}
              <em>{title}</em>
            </>
          )}
        </span>
        {event.changes.length > 0 && (
          <span className="activity-changes">
            {event.changes.map((change) => (
              <span key={change.field}>{describeChange(change)}</span>
            ))}
          </span>
        )}
      </span>
      <time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time>
    </>
  );

  if (!onOpenPage || !event.entityId) {
    return (
      <article className="activity-row">
        <div className="activity-row-main">{body}</div>
      </article>
    );
  }
  return (
    <article className="activity-row">
      <button
        aria-label={`Open ${event.entityTitle}`}
        className="activity-row-main"
        onClick={() => onOpenPage(event.entityId!)}
        type="button"
      >
        {body}
      </button>
    </article>
  );
}
