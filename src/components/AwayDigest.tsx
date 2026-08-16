import { useMemo, useState } from "react";
import type { AuditChange, AuditEvent, AwayState, BoardWorkspace } from "../../shared/types";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";
import { dayLabel } from "./activity-copy";

const VISIBLE_LINES = 5;

export type DigestPart = { text: string; strong?: boolean };

export type DigestLine = {
  key: string;
  /** 1 about you · 2 finished work · 3 new and moving work · 4 ideas · 5 project and team */
  tier: 1 | 2 | 3 | 4 | 5;
  sequence: number;
  aboutYou: boolean;
  actorId: string | null;
  actorName: string;
  /** The agent that acted for them, or null for a person at a browser. */
  agentName: string | null;
  parts: DigestPart[];
};

/**
 * Rewrites raw activity events into the sentences a returning teammate reads.
 *
 * Lines about the reader always come first, own actions never arrive here (the
 * server excludes them), and repeat edits or same-column page runs collapse into
 * one line so five lines can honestly summarize a busy week.
 */
export function buildDigestLines(away: AwayState, board: BoardWorkspace): DigestLine[] {
  const me = board.currentUser;
  const lines: DigestLine[] = [];
  const editDeduper = new Set<string>();
  const creationRuns = new Map<string, { line: DigestLine; firstTitle: string; column: string; count: number }>();

  const push = (event: AuditEvent, tier: DigestLine["tier"], aboutYou: boolean, parts: DigestPart[]): DigestLine => {
    const line: DigestLine = {
      key: event.id,
      tier,
      sequence: event.sequence,
      aboutYou,
      actorId: event.actorId,
      actorName: event.actorName,
      agentName: event.agentName,
      parts,
    };
    lines.push(line);
    return line;
  };
  const change = (event: AuditEvent, field: string): AuditChange | undefined =>
    event.changes.find((candidate) => candidate.field === field);

  for (const event of away.events) {
    if (event.entityType === "page" && event.entityId) {
      const page = board.pages.find((candidate) => candidate.id === event.entityId);
      const mine = page?.assigneeId === me.id;

      if (event.action === "created") {
        // The promotion line covers the page its idea became.
        if (change(event, "promoted from an idea")) continue;
        const column = change(event, "column")?.to ?? "the board";
        const runKey = `${event.actorId}:${column}`;
        const run = creationRuns.get(runKey);
        if (run) {
          run.count += 1;
          run.line.parts = [
            { text: "added " },
            { text: run.firstTitle, strong: true },
            { text: ` and ${run.count - 1} more page${run.count > 2 ? "s" : ""} to ${run.column}` },
          ];
          continue;
        }
        const line = push(event, 3, false, [
          { text: "added " },
          { text: event.entityTitle, strong: true },
          { text: ` to ${column}` },
        ]);
        creationRuns.set(runKey, { line, firstTitle: event.entityTitle, column, count: 1 });
        continue;
      }

      if (event.action === "moved") {
        const column = change(event, "column");
        if (column?.to === "Done") {
          const unblocked = board.pages.filter(
            (candidate) => candidate.assigneeId === me.id && candidate.blockedBy.includes(event.entityId!),
          );
          if (unblocked.length > 0) {
            push(event, 1, true, [
              { text: "finished " },
              { text: event.entityTitle, strong: true },
              { text: " - your " },
              { text: unblocked[0].title, strong: true },
              { text: unblocked.length > 1 ? ` and ${unblocked.length - 1} more are no longer blocked` : " is no longer blocked" },
            ]);
          } else {
            push(event, 2, false, [{ text: "finished " }, { text: event.entityTitle, strong: true }]);
          }
          continue;
        }
        if (column?.from === "Done") {
          push(event, 2, false, [
            { text: "reopened " },
            { text: event.entityTitle, strong: true },
            { text: ` into ${column.to ?? "the board"}` },
          ]);
          continue;
        }
        if (column?.to === "In progress") {
          push(event, 3, mine, [{ text: "started " }, { text: event.entityTitle, strong: true }]);
          continue;
        }
        push(event, 3, mine, [
          { text: "moved " },
          { text: event.entityTitle, strong: true },
          { text: ` into ${column?.to ?? "another column"}` },
        ]);
        continue;
      }

      if (event.action === "updated") {
        const assignee = change(event, "assignee");
        if (assignee) {
          if (assignee.to === me.name) {
            push(event, 1, true, [{ text: "assigned you " }, { text: event.entityTitle, strong: true }]);
          } else if (assignee.from === me.name) {
            push(event, 1, true, [
              { text: "handed " },
              { text: event.entityTitle, strong: true },
              { text: ` to ${assignee.to ?? "no one"}` },
            ]);
          } else {
            push(event, 3, false, [
              { text: "assigned " },
              { text: event.entityTitle, strong: true },
              { text: ` to ${assignee.to ?? "no one"}` },
            ]);
          }
          continue;
        }
        const blockers = change(event, "blockers");
        if (blockers) {
          push(event, 3, mine, blockers.to
            ? [
              { text: "marked " },
              { text: event.entityTitle, strong: true },
              { text: " blocked by " },
              { text: blockers.to, strong: true },
            ]
            : [{ text: "cleared the blockers on " }, { text: event.entityTitle, strong: true }]);
          continue;
        }
        const dedupeKey = `page:${event.actorId}:${event.entityId}`;
        if (editDeduper.has(dedupeKey)) continue;
        editDeduper.add(dedupeKey);
        push(event, mine ? 1 : 3, mine, [
          { text: mine ? "edited your " : "edited " },
          { text: event.entityTitle, strong: true },
        ]);
        continue;
      }

      if (event.action === "archived") {
        push(event, 3, false, [{ text: "archived " }, { text: event.entityTitle, strong: true }]);
        continue;
      }
      if (event.action === "restored") {
        push(event, 3, false, [{ text: "restored " }, { text: event.entityTitle, strong: true }]);
        continue;
      }
      continue;
    }

    if (event.entityType === "idea") {
      if (event.action === "created") {
        push(event, 4, false, [{ text: "captured the idea " }, { text: event.entityTitle, strong: true }]);
      } else if (event.action === "moved") {
        const list = change(event, "list");
        const wording = list?.to === "Shortlist"
          ? [{ text: "shortlisted " }, { text: event.entityTitle, strong: true }]
          : list?.to === "Parked"
            ? [{ text: "parked " }, { text: event.entityTitle, strong: true }]
            : [{ text: "moved " }, { text: event.entityTitle, strong: true }, { text: " back to the idea inbox" }];
        push(event, 4, false, wording);
      } else if (event.action === "promoted") {
        push(event, 4, false, [
          { text: "promoted " },
          { text: event.entityTitle, strong: true },
          { text: " into the Backlog" },
        ]);
      } else if (event.action === "restored") {
        push(event, 4, false, [{ text: "restored the idea " }, { text: event.entityTitle, strong: true }]);
      } else if (event.action === "updated") {
        const dedupeKey = `idea:${event.actorId}:${event.entityId}`;
        if (editDeduper.has(dedupeKey)) continue;
        editDeduper.add(dedupeKey);
        push(event, 4, false, [{ text: "edited the idea " }, { text: event.entityTitle, strong: true }]);
      }
      continue;
    }

    if (event.entityType === "member") {
      if (event.action === "joined") push(event, 5, false, [{ text: "joined the project" }]);
      else if (event.action === "removed") {
        push(event, 5, false, [{ text: "removed " }, { text: event.entityTitle, strong: true }, { text: " from the project" }]);
      }
      // Invitation links are administrative noise; owners read them in the activity log.
      continue;
    }

    if (event.entityType === "project") {
      if (event.action === "renamed") {
        const name = change(event, "name");
        push(event, 5, false, [{ text: "renamed the project to " }, { text: name?.to ?? event.entityTitle, strong: true }]);
      } else if (event.action === "created") {
        push(event, 5, false, [{ text: "created the project " }, { text: event.entityTitle, strong: true }]);
      }
      continue;
    }

    if (event.entityType === "category") {
      const verb = event.action === "created" ? "added" : event.action === "deleted" ? "removed" : "edited";
      push(event, 5, false, [{ text: `${verb} the category ` }, { text: event.entityTitle, strong: true }]);
      continue;
    }

    if (event.entityType === "agent") {
      // A new credential is worth a teammate's attention - unattributed-looking writes may
      // follow it - and a revocation closes that loop.
      if (event.action === "created") {
        push(event, 5, false, [{ text: "gave agent access to " }, { text: event.entityTitle, strong: true }]);
      } else if (event.action === "removed") {
        push(event, 5, false, [{ text: "revoked agent access from " }, { text: event.entityTitle, strong: true }]);
      }
    }
  }

  return lines.sort((left, right) => left.tier - right.tier || left.sequence - right.sequence);
}

type Props = {
  away: AwayState;
  board: BoardWorkspace;
  onDismiss: () => void;
};

export function AwayDigest({ away, board, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => buildDigestLines(away, board), [away, board]);
  const meta = useMemo(() => {
    const actors = [...new Set(away.events.map((event) => event.actorName))];
    const oldest = away.events[0]?.createdAt;
    const since = oldest ? dayLabel(oldest, new Date()).toLowerCase() : null;
    return { actors, since };
  }, [away.events]);

  if (lines.length === 0) return null;
  const visible = expanded ? lines : lines.slice(0, VISIBLE_LINES);
  const hiddenCount = lines.length - visible.length;
  const beyondFetch = away.total - away.events.length;

  return (
    <section aria-label="While you were away" className="away-digest">
      <header className="away-digest-head">
        <p className="eyebrow">while you were away</p>
        <span className="away-digest-when">
          {meta.since ? `since ${meta.since} · ` : ""}
          {away.total} change{away.total === 1 ? "" : "s"} by {formatNames(meta.actors)}
        </span>
        <button aria-label="Dismiss the away summary" className="text-button" onClick={onDismiss} type="button">
          dismiss
        </button>
      </header>
      <Growing className="away-digest-lines">
        {visible.map((line) => (
          <p className={line.aboutYou ? "away-line about-you" : "away-line"} key={line.key}>
            <Avatar
              avatarUrl={board.members.find((member) => member.id === line.actorId)?.avatarUrl}
              className="avatar tiny"
              name={line.actorName}
            />
            <span className="away-line-text">
              {line.aboutYou && <span className="away-for-you">for you</span>}
              <strong>{line.actorName}</strong>
              {line.agentName && <span className="via-agent"> via {line.agentName}</span>}{" "}
              {line.parts.map((part, index) =>
                part.strong ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>,
              )}
            </span>
          </p>
        ))}
      </Growing>
      {(hiddenCount > 0 || (expanded && beyondFetch > 0)) && (
        <footer className="away-digest-foot">
          {hiddenCount > 0 ? (
            <button className="text-button" onClick={() => setExpanded(true)} type="button">
              + {hiddenCount} more change{hiddenCount === 1 ? "" : "s"} ▾
            </button>
          ) : (
            <span>and {beyondFetch} earlier change{beyondFetch === 1 ? "" : "s"} before that</span>
          )}
        </footer>
      )}
    </section>
  );
}

function formatNames(names: string[]): string {
  if (names.length === 0) return "the team";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
