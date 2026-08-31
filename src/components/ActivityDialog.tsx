import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AUDIT_ENTITY_TYPES,
  type AuditEntityType,
  type AuditEvent,
  type AuditPage,
  type Member,
} from "../../shared/types";
import { useTypingFocus } from "../hooks/use-typing-focus";
import { dayLabel, ENTITY_LABELS, eventText } from "../lib/activity-copy";
import { ActivityRow } from "./ActivityRow";
import { Drawer } from "./Drawer";

const PAGE_SIZE = 60;

type Props = {
  /** The reader's last-seen sequence; events above it are new since their last visit. */
  awaySince?: number;
  members: Member[];
  revision: number;
  onClose: () => void;
  onLoad: (options: { entityId?: string; before?: number; limit?: number }) => Promise<AuditPage>;
  onOpenPage: (id: string) => void;
};

export function ActivityDialog({ awaySince, members, revision, onClose, onLoad, onOpenPage }: Props) {
  const focusForTyping = useTypingFocus<HTMLInputElement>();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<AuditEntityType | null>(null);
  const now = useMemo(() => new Date(), [events]);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError("");
      try {
        const page = await onLoad({ before, limit: PAGE_SIZE });
        setEvents((current) => (before === undefined ? page.events : [...current, ...page.events]));
        setHasMore(page.hasMore);
      } catch (value) {
        setError(value instanceof Error ? value.message : "The history could not be loaded");
      } finally {
        setLoading(false);
      }
    },
    [onLoad],
  );

  useEffect(() => {
    void load();
  }, [load, revision]);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      events.filter((event) => {
        if (person && event.actorId !== person) return false;
        if (entityType && event.entityType !== entityType) return false;
        return !normalizedQuery || eventText(event).includes(normalizedQuery);
      }),
    [entityType, events, normalizedQuery, person],
  );
  const usedTypes = useMemo(
    () => AUDIT_ENTITY_TYPES.filter((type) => events.some((event) => event.entityType === type)),
    [events],
  );
  const groups = useMemo(() => groupByDay(visible, now), [now, visible]);

  // The unread line sits before the first already-seen event, provided something
  // newer sits above it - a fully-read log needs no line at all.
  const dividerBeforeId = useMemo(() => {
    if (awaySince === undefined) return null;
    const firstSeen = visible.findIndex((event) => event.sequence <= awaySince);
    return firstSeen > 0 ? visible[firstSeen]!.id : null;
  }, [awaySince, visible]);

  return (
    <Drawer
      backdropClassName="library-backdrop"
      className="library-dialog"
      labelledBy="activity-dialog-title"
      onClose={onClose}
    >
      <header className="dialog-header library-header">
        <div>
          <p className="eyebrow">project record</p>
          <h2 id="activity-dialog-title">Activity</h2>
          <p>Who changed what, newest first.</p>
        </div>
        <button aria-label="Close activity" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="library-tools">
        <label className="library-search">
          <span className="sr-only">Search activity</span>
          <input
            aria-label="Search activity"
            ref={focusForTyping}
            id="activity-search"
            name="activitySearch"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search activity..."
            type="search"
            value={query}
          />
        </label>
        <div aria-label="Activity people" className="library-filters">
          {members.map((member) => (
            <button
              aria-pressed={person === member.id}
              className={person === member.id ? "active" : ""}
              key={member.id}
              onClick={() => setPerson(person === member.id ? null : member.id)}
              type="button"
            >
              {member.name}
            </button>
          ))}
        </div>
        {usedTypes.length > 1 && (
          <div aria-label="Activity kinds" className="library-filters">
            {usedTypes.map((type) => (
              <button
                aria-pressed={entityType === type}
                className={entityType === type ? "active" : ""}
                key={type}
                onClick={() => setEntityType(entityType === type ? null : type)}
                type="button"
              >
                {ENTITY_LABELS[type]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="history-results activity-results" aria-live="polite">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {groups.map(([label, dayEvents]) => (
          <section className="history-group" key={label}>
            <header>
              <h3>{label}</h3>
              <span>{dayEvents.length}</span>
            </header>
            <div>
              {dayEvents.map((event) => (
                <Fragment key={event.id}>
                  {event.id === dividerBeforeId && (
                    <div className="unread-divider" role="separator">
                      new since your last visit
                    </div>
                  )}
                  <ActivityRow
                    event={event}
                    members={members}
                    onOpenPage={event.entityType === "page" && event.entityId ? onOpenPage : undefined}
                  />
                </Fragment>
              ))}
            </div>
          </section>
        ))}
        {visible.length === 0 && !loading && !error && (
          <div className="library-empty">
            <strong>{events.length === 0 ? "Nothing has happened yet." : "No activity matches."}</strong>
            <span>
              {events.length === 0
                ? "Changes to pages, ideas, and the team collect here."
                : "Try a broader search or remove a filter."}
            </span>
          </div>
        )}
        {hasMore && (
          <button
            className="quiet-button load-more"
            disabled={loading}
            onClick={() => void load(events[events.length - 1]?.sequence)}
            type="button"
          >
            {loading ? "loading..." : "load older activity"}
          </button>
        )}
      </div>
    </Drawer>
  );
}

function groupByDay(events: AuditEvent[], now: Date): Array<[string, AuditEvent[]]> {
  const groups = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const label = dayLabel(event.createdAt, now);
    groups.set(label, [...(groups.get(label) ?? []), event]);
  }
  return [...groups.entries()];
}
