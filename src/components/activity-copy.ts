import type { AuditChange, AuditEntityType, AuditEvent } from "../../shared/types";

export const ENTITY_LABELS: Record<AuditEntityType, string> = {
  page: "pages",
  idea: "ideas",
  project: "project",
  category: "categories",
  chapter: "chapters",
  member: "team",
  agent: "agents",
  field: "fields",
};

const PROJECT_VERBS: Partial<Record<AuditEvent["action"], string>> = {
  created: "created",
  renamed: "renamed",
  updated: "changed settings on",
  archived: "archived",
};

const PAGE_VERBS: Partial<Record<AuditEvent["action"], string>> = {
  created: "added",
  updated: "edited",
  moved: "moved",
  archived: "archived",
  restored: "restored",
  promoted: "promoted",
  deleted: "deleted",
  renamed: "renamed",
  // Discussion reads as something someone did to the page, because that is where it lives.
  asked: "asked something on",
  replied: "replied on",
  answered: "answered a question on",
  reopened: "reopened a question on",
};

/**
 * Turns one stored event into a sentence.
 *
 * The actor's name is prefixed by the caller, so every phrase here continues from it:
 * "Donavyn" + "edited page" + "Fix the workbench".
 */
export function describeEvent(event: AuditEvent): { lead: string; title: string } {
  if (event.entityType === "member") {
    if (event.action === "joined") return { lead: "joined the project", title: "" };
    if (event.action === "invited") return { lead: "created an invitation link", title: "" };
    return { lead: "removed", title: event.entityTitle };
  }
  if (event.entityType === "agent") {
    // Credentials get their own wording: borrowing the project verbs here would announce
    // "created the project Planning agent" to everyone, which is alarming and untrue.
    if (event.action === "created") return { lead: "gave agent access to", title: event.entityTitle };
    if (event.action === "removed") return { lead: "revoked agent access from", title: event.entityTitle };
    return { lead: `${event.action} agent`, title: event.entityTitle };
  }
  if (event.entityType === "project") {
    // Defaulting an unrecognised action to "archived" would report something alarming and
    // untrue, so an unknown verb stays literal instead.
    const verb = PROJECT_VERBS[event.action] ?? event.action;
    return { lead: `${verb} the project`, title: event.entityTitle };
  }
  const noun = event.entityType === "category" ? "category" : event.entityType;
  return { lead: `${PAGE_VERBS[event.action] ?? event.action} ${noun}`, title: event.entityTitle };
}

export function describeChange(change: AuditChange): string {
  if (change.from === null && change.to === null) return change.field;
  if (change.from === null) return `${change.field}: ${change.to}`;
  if (change.to === null) return `${change.field} cleared`;
  return `${change.field}: ${change.from} → ${change.to}`;
}

export function eventText(event: AuditEvent): string {
  const { lead, title } = describeEvent(event);
  return `${event.actorName} ${lead} ${title} ${event.changes.map(describeChange).join(" ")}`.toLowerCase();
}

export function dayLabel(timestamp: string, now: Date): string {
  const value = new Date(timestamp);
  const days = daysBetween(value, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: value.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(value);
}

export function timeLabel(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

/** Relative wording for the compact page history, where a full timestamp is too heavy. */
export function relativeLabel(timestamp: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(timestamp).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function daysBetween(value: Date, now: Date): number {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - start.getTime()) / 86_400_000);
}
