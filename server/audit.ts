import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AuditAction,
  AuditChange,
  AuditEntityType,
  AuditEvent,
  AuditPage,
  Card,
  Chapter,
  Idea,
} from "../shared/types";

export const AUDIT_PAGE_SIZE = 40;
export const AUDIT_MAX_PAGE_SIZE = 200;
export const AWAY_EVENT_LIMIT = 200;

export const CARD_COLUMN_LABELS: Record<Card["status"], string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export const IDEA_LIST_LABELS: Record<Idea["state"], string> = {
  inbox: "Idea inbox",
  shortlist: "Shortlist",
  parked: "Parked",
};

export type AuditActor = {
  id: string;
  name: string;
};

export type RecordAuditInput = {
  projectId: string;
  actor: AuditActor;
  entityType: AuditEntityType;
  entityId: string | null;
  entityTitle: string;
  action: AuditAction;
  changes?: AuditChange[];
};

/**
 * Appends one event to the project history.
 *
 * The actor name and entity title are snapshots taken at write time so the timeline
 * still reads correctly after a card is renamed or archived. Reads prefer the live
 * account name when it is still available, which keeps a renamed person consistent
 * across their whole history.
 */
export function recordAuditEvent(database: DatabaseSync, input: RecordAuditInput): void {
  database
    .prepare(
      `INSERT INTO audit_events (
        id, project_id, actor_id, actor_name, entity_type, entity_id, entity_title, action, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.projectId,
      input.actor.id,
      input.actor.name,
      input.entityType,
      input.entityId,
      input.entityTitle,
      input.action,
      JSON.stringify(input.changes ?? []),
      new Date().toISOString(),
    );
}

export function listAuditEvents(
  database: DatabaseSync,
  projectId: string,
  options: { entityId?: string; before?: number; limit?: number } = {},
): AuditPage {
  const limit = Math.max(1, Math.min(options.limit ?? AUDIT_PAGE_SIZE, AUDIT_MAX_PAGE_SIZE));
  const filters = ["audit_events.project_id = ?"];
  const params: Array<string | number> = [projectId];
  if (options.entityId) {
    filters.push("audit_events.entity_id = ?");
    params.push(options.entityId);
  }
  if (options.before !== undefined) {
    filters.push("audit_events.sequence < ?");
    params.push(options.before);
  }
  // One extra row answers "is there more" without a second count query.
  const values = database
    .prepare(
      `SELECT audit_events.*, users.name AS current_actor_name
       FROM audit_events LEFT JOIN users ON users.id = audit_events.actor_id
       WHERE ${filters.join(" AND ")}
       ORDER BY audit_events.sequence DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<Record<string, string | number | null>>;

  return {
    events: values.slice(0, limit).map(publicAuditEvent),
    hasMore: values.length > limit,
  };
}

/** The newest sequence a project has written, or 0 for an untouched log. */
export function latestAuditSequence(database: DatabaseSync, projectId: string): number {
  const value = database
    .prepare("SELECT MAX(sequence) AS latest FROM audit_events WHERE project_id = ?")
    .get(projectId) as { latest: number | null } | undefined;
  return Number(value?.latest ?? 0);
}

/**
 * Everything that happened after a reader's cursor, excluding their own actions.
 *
 * Events return oldest first because the digest reads them as a story, and the cap
 * keeps a months-long absence from turning one request into the whole history. The
 * total is exact either way so the digest can be honest about what it left out.
 */
export function listUnseenEvents(
  database: DatabaseSync,
  projectId: string,
  options: { after: number; excludeActorId: string },
): { events: AuditEvent[]; total: number } {
  const predicate =
    "audit_events.project_id = ? AND audit_events.sequence > ? AND (audit_events.actor_id IS NULL OR audit_events.actor_id != ?)";
  const params = [projectId, options.after, options.excludeActorId];
  const counted = database
    .prepare(`SELECT COUNT(*) AS total FROM audit_events WHERE ${predicate}`)
    .get(...params) as { total: number };
  const values = database
    .prepare(
      `SELECT audit_events.*, users.name AS current_actor_name
       FROM audit_events LEFT JOIN users ON users.id = audit_events.actor_id
       WHERE ${predicate}
       ORDER BY audit_events.sequence ASC
       LIMIT ?`,
    )
    .all(...params, AWAY_EVENT_LIMIT) as Array<Record<string, string | number | null>>;
  return { events: values.map(publicAuditEvent), total: Number(counted.total) };
}

function publicAuditEvent(value: Record<string, string | number | null>): AuditEvent {
  return {
    sequence: Number(value.sequence),
    id: String(value.id),
    actorId: value.actor_id === null ? null : String(value.actor_id),
    actorName: String(value.current_actor_name ?? value.actor_name),
    entityType: value.entity_type as AuditEntityType,
    entityId: value.entity_id === null ? null : String(value.entity_id),
    entityTitle: String(value.entity_title),
    action: value.action as AuditAction,
    changes: parseChanges(value.changes),
    createdAt: String(value.created_at),
  };
}

function parseChanges(value: string | number | null): AuditChange[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditChange[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves slugs and identifiers to the names a reader recognises.
 *
 * Implementations are expected to be lazy, because most edits change neither the
 * category nor the blockers and should not pay to load either.
 */
export type CardLabels = {
  categoryName: (slug: string | null) => string;
  chapterName: (slug: string | null) => string;
  cardTitle: (id: string) => string;
};

/** Fields a person would recognise, in the order they appear on the card. */
export function cardChanges(before: Card, after: Card, labels: CardLabels): AuditChange[] {
  const changes: AuditChange[] = [];
  if (before.title !== after.title) changes.push({ field: "title", from: before.title, to: after.title });
  if (before.description !== after.description) {
    changes.push({ field: "notes", from: summarize(before.description), to: summarize(after.description) });
  }
  if (before.category !== after.category) {
    changes.push({
      field: "category",
      from: labels.categoryName(before.category),
      to: labels.categoryName(after.category),
    });
  }
  if (before.chapter !== after.chapter) {
    changes.push({
      field: "chapter",
      from: labels.chapterName(before.chapter),
      to: labels.chapterName(after.chapter),
    });
  }
  if (before.assigneeId !== after.assigneeId) {
    changes.push({
      field: "assignee",
      from: before.assigneeName ?? "unassigned",
      to: after.assigneeName ?? "unassigned",
    });
  }
  if (before.status !== after.status) {
    changes.push({
      field: "column",
      from: CARD_COLUMN_LABELS[before.status],
      to: CARD_COLUMN_LABELS[after.status],
    });
  }
  if (!sameIds(before.blockedBy, after.blockedBy)) {
    changes.push({
      field: "blockers",
      from: describeIds(before.blockedBy, labels),
      to: describeIds(after.blockedBy, labels),
    });
  }
  return changes;
}

/**
 * Records where a new card landed, rather than diffing it against a fictional empty
 * card that would report every field as an edit.
 */
export function cardCreationChanges(card: Card, labels: CardLabels): AuditChange[] {
  const changes: AuditChange[] = [{ field: "column", from: null, to: CARD_COLUMN_LABELS[card.status] }];
  if (card.category) changes.push({ field: "category", from: null, to: labels.categoryName(card.category) });
  if (card.chapter) changes.push({ field: "chapter", from: null, to: labels.chapterName(card.chapter) });
  if (card.assigneeName) changes.push({ field: "assignee", from: null, to: card.assigneeName });
  return changes;
}

export const CHAPTER_STATE_LABELS: Record<Chapter["state"], string> = {
  planned: "planned",
  open: "open",
  closed: "closed",
};

/** What a chapter arrived carrying, so its first log entry is not an empty "created". */
export function chapterCreationChanges(chapter: Chapter): AuditChange[] {
  const changes: AuditChange[] = [{ field: "state", from: null, to: CHAPTER_STATE_LABELS[chapter.state] }];
  if (chapter.startsOn) changes.push({ field: "starts", from: null, to: chapter.startsOn });
  if (chapter.endsOn) changes.push({ field: "ends", from: null, to: chapter.endsOn });
  return changes;
}

export function chapterChanges(before: Chapter, after: Chapter): AuditChange[] {
  const changes: AuditChange[] = [];
  if (before.name !== after.name) changes.push({ field: "name", from: before.name, to: after.name });
  if (before.description !== after.description) {
    changes.push({ field: "intent", from: summarize(before.description), to: summarize(after.description) });
  }
  if (before.state !== after.state) {
    changes.push({
      field: "state",
      from: CHAPTER_STATE_LABELS[before.state],
      to: CHAPTER_STATE_LABELS[after.state],
    });
  }
  if (before.startsOn !== after.startsOn) {
    changes.push({ field: "starts", from: before.startsOn, to: after.startsOn });
  }
  if (before.endsOn !== after.endsOn) changes.push({ field: "ends", from: before.endsOn, to: after.endsOn });
  return changes;
}

/**
 * Opening and closing a chapter read as moves, because that is what a reader is scanning the
 * log for. Renaming one or editing its intent is an ordinary edit.
 */
export function chapterAction(changes: AuditChange[]): AuditAction {
  return changes.some((change) => change.field === "state") ? "moved" : "updated";
}

export function ideaChanges(before: Idea, after: Idea): AuditChange[] {
  const changes: AuditChange[] = [];
  if (before.title !== after.title) changes.push({ field: "title", from: before.title, to: after.title });
  if (before.description !== after.description) {
    changes.push({ field: "notes", from: summarize(before.description), to: summarize(after.description) });
  }
  if (before.state !== after.state) {
    changes.push({ field: "list", from: IDEA_LIST_LABELS[before.state], to: IDEA_LIST_LABELS[after.state] });
  }
  return changes;
}

/**
 * A column change reads as a move; anything else reads as an edit.
 *
 * Reordering within one column produces no changes at all, so callers skip the write
 * rather than burying real edits under a drag-shaped log.
 */
export function changeAction(changes: AuditChange[]): AuditAction | null {
  if (changes.length === 0) return null;
  return changes.some((change) => change.field === "column" || change.field === "list") ? "moved" : "updated";
}

export function summarize(value: string): string | null {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeIds(ids: string[], labels: CardLabels): string | null {
  return ids.length === 0 ? null : ids.map((id) => labels.cardTitle(id)).join(", ");
}
