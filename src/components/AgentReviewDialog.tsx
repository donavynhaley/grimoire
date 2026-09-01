import { useMemo, useState } from "react";
import type { AgentReview, AuditEvent, BoardWorkspace } from "../../shared/types";
import { agentTokenIsLive } from "../api/client";
import { timeLabel } from "../lib/activity-copy";
import { dayLabel } from "../lib/chapter-dates";
import { ActivityRow } from "./ActivityRow";
import { Avatar } from "./Avatar";
import { ConfirmInline } from "./ConfirmInline";
import { Drawer } from "./Drawer";

type Props = {
  board: BoardWorkspace;
  review: AgentReview;
  onClose: () => void;
  onOpenPage: (id: string) => void;
  onRevoke: (id: string) => Promise<void>;
};

type PageGroup = {
  key: string;
  title: string;
  events: AuditEvent[];
  newest: number;
};

/**
 * Everything agents did since this reader last reviewed them, page by page.
 *
 * This is where "no agent approves its own work" becomes a surface rather than a rule:
 * agents report, and a person reads the report. Closing the review is what marks it
 * read, so nothing is consumed by merely standing near the board - and the credential
 * rail beside the work is what makes revoking one tap instead of a trip to settings.
 */
export function AgentReviewDialog({ board, review, onClose, onOpenPage, onRevoke }: Props) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const groups = useMemo(() => groupByEntity(review.events), [review.events]);
  const liveCredentials = useMemo(
    () => (review.credentials ?? []).filter((token) => agentTokenIsLive(token)),
    [review.credentials],
  );
  const quiet = review.events.length === 0 && review.waiting.length === 0;
  const held = review.total - review.events.length;

  const summary = [
    review.total > 0 ? `${review.total} change${review.total === 1 ? "" : "s"}` : null,
    review.waiting.length > 0
      ? `${review.waiting.length} open question${review.waiting.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const revoke = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await onRevoke(id);
      setRevoking(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The credential could not be revoked");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      backdropClassName="library-backdrop"
      className="library-dialog"
      labelledBy="agent-review-title"
      onClose={onClose}
    >
      <header className="dialog-header library-header">
        <div>
          <p className="eyebrow">delegated work</p>
          <h2 id="agent-review-title">Agent review</h2>
          <p>
            {summary
              ? `${summary} since you last looked.`
              : "What agents do collects here for a person to review."}
          </p>
        </div>
        <button aria-label="Close agent review" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="history-results activity-results" aria-live="polite">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        {review.waiting.length > 0 && (
          <section className="history-group" key="waiting">
            <header>
              <h3>Waiting on a person</h3>
              <span>{review.waiting.length}</span>
            </header>
            <div>
              {review.waiting.map((thread) => (
                <article className="activity-row" key={thread.id}>
                  <button
                    aria-label={`Open ${thread.pageTitle}`}
                    className="activity-row-main"
                    onClick={() => onOpenPage(thread.pageId)}
                    type="button"
                  >
                    <Avatar
                      avatarUrl={board.members.find((member) => member.id === thread.authorId)?.avatarUrl}
                      className="avatar tiny"
                      name={thread.authorName}
                    />
                    <span className="activity-copy">
                      <span className="activity-line">
                        <strong>{thread.authorName}</strong>
                        {thread.agentName && <span className="via-agent"> via {thread.agentName}</span>} asks
                        on <em>{thread.pageTitle}</em>
                      </span>
                      <span className="activity-changes">
                        <span>{thread.body}</span>
                      </span>
                    </span>
                    <time dateTime={thread.createdAt}>{timeLabel(thread.createdAt)}</time>
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {groups.map((group) => (
          <section className="history-group" key={group.key}>
            <header>
              <h3>{group.title}</h3>
              <span>{group.events.length}</span>
            </header>
            <div>
              {group.events.map((event) => (
                <ActivityRow
                  event={event}
                  key={event.id}
                  members={board.members}
                  onOpenPage={
                    event.entityType === "page" &&
                    event.entityId &&
                    board.pages.some((page) => page.id === event.entityId)
                      ? onOpenPage
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        ))}

        {held > 0 && (
          <p className="review-cap-note">
            and {held} more change{held === 1 ? "" : "s"} after these - closing the review keeps them waiting
            for your next look
          </p>
        )}

        {quiet && (
          <div className="library-empty">
            <strong>No agent has done anything new.</strong>
            <span>Everything a credential writes lands here until a person has looked at it.</span>
          </div>
        )}

        {liveCredentials.length > 0 && (
          <section className="history-group" key="credentials">
            <header>
              <h3>Credentials</h3>
              <span>{liveCredentials.length}</span>
            </header>
            <ul className="agent-list">
              {liveCredentials.map((token) => (
                <li className="agent-row" key={token.id}>
                  <div className="agent-row-main">
                    <span className="agent-name">{token.name}</span>
                    <span className="agent-meta">
                      {token.scope === "write" ? "read and write" : "read only"} · acts as {token.ownerName} ·{" "}
                      {token.lastUsedAt
                        ? `last used ${dayLabel(token.lastUsedAt.slice(0, 10))}`
                        : "never used"}
                    </span>
                  </div>
                  <ConfirmInline
                    className="archive-confirm"
                    confirmDisabled={busy}
                    onCancel={() => setRevoking(null)}
                    onConfirm={() => void revoke(token.id)}
                    onOpen={() => setRevoking(token.id)}
                    open={revoking === token.id}
                    question={`revoke ${token.name}?`}
                    trigger="revoke"
                    triggerClass="danger-text"
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}

/**
 * The review reads page by page rather than as one stream, because a person reviews
 * delegated work the way they would review a branch: by the thing it touched. Groups
 * stand newest-first while the changes inside each keep story order.
 */
function groupByEntity(events: AuditEvent[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const event of events) {
    const key = `${event.entityType}:${event.entityId ?? "project"}`;
    const group = groups.get(key) ?? { key, title: event.entityTitle, events: [], newest: 0 };
    group.events.push(event);
    // The last event holds the newest title snapshot, so a renamed page reads by its
    // current name rather than the one it wore when the agent first touched it.
    group.title = event.entityTitle;
    group.newest = event.sequence;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.newest - left.newest);
}
