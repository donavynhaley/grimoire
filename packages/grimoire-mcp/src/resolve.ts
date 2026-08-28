import type { Board, FieldValue, Page, ProjectField } from "./client.js";

/**
 * Turning what an agent says into what the API needs.
 *
 * The REST surface is identifier-shaped: blockers are UUIDs, an assignee is an email, and a
 * category or chapter is a project-scoped slug. An agent handed that spends most of its turns
 * looking identifiers up and still gets them wrong, so every tool here accepts the names a
 * person would use and resolves them against the board.
 *
 * Resolution is deliberately strict. Guessing at an ambiguous name would write the wrong
 * thing somewhere a person has to notice and undo, so an unresolvable name is an error that
 * lists the real options instead.
 */

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

const COLUMN_NAMES: Record<string, string> = {
  backlog: "backlog",
  "up next": "ready",
  ready: "ready",
  "in progress": "in_progress",
  in_progress: "in_progress",
  doing: "in_progress",
  review: "review",
  "in review": "review",
  done: "done",
  complete: "done",
  completed: "done",
};

/** The board's columns in reading order; the render loop and the labels share it. */
export const PAGE_COLUMNS = ["backlog", "ready", "in_progress", "review", "done"] as const;

const COLUMN_LABELS: Record<(typeof PAGE_COLUMNS)[number], string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export function columnLabel(status: string): string {
  // Tolerant of a status this build has never heard of: the server is the authority on
  // the vocabulary, and an unknown word reads better than a refused board.
  return (COLUMN_LABELS as Record<string, string | undefined>)[status] ?? status;
}

/** Accepts what a person would say for a column, not only the stored enum value. */
export function resolveStatus(value: string): string {
  const key = value.trim().toLowerCase();
  const status = COLUMN_NAMES[key];
  if (!status) {
    throw new ResolutionError(
      `"${value}" is not a column. Use one of: ${Object.values(COLUMN_LABELS).join(", ")}.`,
    );
  }
  return status;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveCategory(board: Board, value: string): string {
  const wanted = normalise(value);
  const match = board.categories.find(
    (category) => normalise(category.name) === wanted || category.slug === wanted,
  );
  if (!match) {
    const available = board.categories.map((category) => category.name).join(", ") || "none defined";
    throw new ResolutionError(`"${value}" is not a category in this project. Available: ${available}.`);
  }
  return match.slug;
}

export function resolveChapter(board: Board, value: string): string {
  const wanted = normalise(value);
  const match = board.chapters.find(
    (chapter) => normalise(chapter.name) === wanted || chapter.slug === wanted,
  );
  if (!match) {
    const available = board.chapters.map((chapter) => chapter.name).join(", ") || "none defined";
    throw new ResolutionError(`"${value}" is not a chapter in this project. Available: ${available}.`);
  }
  return match.slug;
}

/** Assignment takes a member id, so a name or an email has to become one. */
export function resolveAssignee(board: Board, value: string): string {
  const wanted = normalise(value);
  if (wanted === "me" || wanted === "self") return board.currentUser.id;
  const matches = board.members.filter(
    (member) => normalise(member.name) === wanted || normalise(member.email) === wanted,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new ResolutionError(
      `"${value}" matches more than one member. Use their email instead: ${matches
        .map((member) => member.email)
        .join(", ")}.`,
    );
  }
  const available = board.members.map((member) => `${member.name} <${member.email}>`).join(", ");
  throw new ResolutionError(`"${value}" is not a member of this project. Members: ${available}.`);
}

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds one page from an id or its exact title, and nothing looser.
 *
 * A partial title never resolves, even when only one page matches it: these tools rewrite
 * page bodies, and a half-remembered word silently landing on whichever live page happens
 * to contain it is precisely the guess this module exists to refuse. The close matches are
 * listed instead, with ids, so the correction costs one turn.
 */
export function resolvePage(board: Board, value: string): Page {
  const byId = board.pages.find((page) => page.id === value);
  if (byId) return byId;

  // An id that is not on the board names something real that cannot be edited - most
  // likely an archived page found through search. Saying "use search" here would send the
  // caller in a circle, because search is where the id came from.
  if (UUID_SHAPE.test(value)) {
    throw new ResolutionError(
      `No page with id ${value} is on the board. It has probably been archived - archived pages ` +
        "cannot be edited or moved by an agent. A person can restore it from search in Grimoire.",
    );
  }

  const wanted = normalise(value);
  const exact = board.pages.filter((page) => normalise(page.title) === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new ResolutionError(
      `"${value}" is the title of ${exact.length} pages. Pass the id of the one you mean:\n` +
        exact.map((page) => `- ${page.id} · ${page.title} (${columnLabel(page.status)})`).join("\n"),
    );
  }

  const close = board.pages.filter((page) => normalise(page.title).includes(wanted));
  if (close.length === 0) {
    throw new ResolutionError(
      `No page matches "${value}". Use grimoire_search to find it, then pass its id.`,
    );
  }
  throw new ResolutionError(
    `No page is titled exactly "${value}". Close match${close.length === 1 ? "" : "es"}:\n` +
      close.map((page) => `- ${page.id} · ${page.title} (${columnLabel(page.status)})`).join("\n") +
      "\nPass the id, or the exact title.",
  );
}

export function resolveBlockers(board: Board, values: string[]): string[] {
  return values.map((value) => resolvePage(board, value).id);
}

/**
 * Turns a project's own fields into the keys and values the API stores.
 *
 * A field can be named by its key or by the label a person reads, and an option can be given
 * in any casing, because "P0" and "p0" are the same thing said by two callers. Everything
 * else is refused with the real options listed: a select exists precisely to have a closed
 * set of answers, so quietly writing a sixth one would defeat the field.
 */
export function resolveFields(
  board: Board,
  values: Record<string, FieldValue | null>,
): Record<string, FieldValue | null> {
  const definitions = board.fields ?? [];
  const resolved: Record<string, FieldValue | null> = {};
  for (const [name, value] of Object.entries(values)) {
    const wanted = normalise(name);
    const field = definitions.find(
      (candidate) => candidate.key === wanted || normalise(candidate.label) === wanted,
    );
    if (!field) {
      const available = definitions.map((candidate) => candidate.label).join(", ") || "none defined";
      throw new ResolutionError(`"${name}" is not a field in this project. Available: ${available}.`);
    }
    resolved[field.key] = value === null ? null : resolveFieldValue(field, value);
  }
  return resolved;
}

function resolveFieldValue(field: ProjectField, value: FieldValue): FieldValue {
  if (field.type === "select" || field.type === "search-select") {
    const wanted = normalise(String(value));
    const option = field.options.find((candidate) => normalise(candidate) === wanted);
    if (!option) {
      throw new ResolutionError(
        `"${value}" is not an option for ${field.label}. Options: ${field.options.join(", ")}.`,
      );
    }
    return option;
  }
  if (field.type === "number" && typeof value !== "number") {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new ResolutionError(`${field.label} takes a number, not "${value}".`);
    return parsed;
  }
  if (field.type === "checkbox" && typeof value !== "boolean") {
    const key = normalise(String(value));
    if (["true", "yes", "on"].includes(key)) return true;
    if (["false", "no", "off"].includes(key)) return false;
    throw new ResolutionError(`${field.label} takes true or false, not "${value}".`);
  }
  return value;
}

/** How a field's value reads back to a person: a checkbox is yes or no, not true or false. */
export function fieldSummary(board: Board, fields: Record<string, FieldValue> | undefined): string[] {
  if (!fields) return [];
  const definitions = board.fields ?? [];
  return Object.entries(fields).map(([key, value]) => {
    const label = definitions.find((candidate) => candidate.key === key)?.label ?? key;
    return `${label}: ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`;
  });
}

/** The label a person would recognise, for a category slug. */
export function categoryName(board: Board, slug: string | null): string | null {
  if (!slug) return null;
  return board.categories.find((category) => category.slug === slug)?.name ?? slug;
}

export function chapterName(board: Board, slug: string | null): string | null {
  if (!slug) return null;
  return board.chapters.find((chapter) => chapter.slug === slug)?.name ?? slug;
}
