import {
  type Chapter,
  type FieldValue,
  fieldHasOptions,
  type Member,
  type ProjectCategory,
  type ProjectField,
} from "../../shared/types";
import type { CapturePageInput } from "../components/QuickCapture";

export type CaptureSettings = Omit<CapturePageInput, "title" | "fields"> & {
  fields: Record<string, FieldValue>;
};
export type PickerKind = "category" | "chapter" | "assignee" | "status" | "field" | "field-cmd";
export type PickerState = {
  kind: PickerKind;
  /** Which of the project's fields is open, when `kind` is "field". */
  fieldKey?: string;
  query: string;
  commandStart: number | null;
};
export type PickerOption = {
  id: string;
  label: string;
  search: string;
  value: string | boolean | null;
  color?: string;
  /** Which project field this option belongs to, for options reached through "!". */
  fieldKey?: string;
  /** True for the entry that opens a written field's panel rather than holding a value. */
  opensPanel?: boolean;
  /** Whose answer this is, drawn quietly beside the value in the "!" list. */
  hint?: string;
};

/**
 * The one person a page can safely be assumed to be for, when there is only one.
 *
 * A project with a single member has no ambiguity to preserve: every page on it is that
 * person's, and leaving each one unassigned is asking them to say so again about work
 * nobody else could be doing. Two members is where the question becomes real, so that is
 * where the answer goes back to being unassigned.
 */
export function soleMemberId(members: Member[]): string | null {
  return members.length === 1 ? (members[0]?.id ?? null) : null;
}

/**
 * What a fresh capture starts as: the current chapter, and the one person there is.
 *
 * New work belongs to the chapter the project has declared current, when it has one.
 */
export function defaultCaptureSettings(chapters: Chapter[], members: Member[]): CaptureSettings {
  return {
    category: null,
    chapter: chapters.find((chapter) => chapter.state === "open")?.slug ?? null,
    assigneeId: soleMemberId(members),
    status: "backlog",
    fields: {},
  };
}

/** Whether a field answers with a choice among options, or has to be written in. */
export function picksFromList(field: ProjectField): boolean {
  return fieldHasOptions(field.type) || field.type === "checkbox";
}

/** How a written value becomes the field's value; null means "could not". */
export function parseWritten(field: ProjectField, raw: string): FieldValue | null {
  const value = raw.trim();
  if (!value) return null;
  if (field.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return value;
}

/** What kind of answer a field takes, said in a word beside its name in the "!" list. */
function fieldKindWord(field: ProjectField): string {
  if (fieldHasOptions(field.type)) return "choice";
  if (field.type === "checkbox") return "yes / no";
  return field.type;
}

export function commandAtEnd(value: string, caret: number): PickerState | null {
  if (caret !== value.length) return null;
  const match = value.match(/(^|\s)([#@/~!])([^\s]*)$/);
  if (!match) return null;
  const kind =
    match[2] === "#"
      ? "category"
      : match[2] === "~"
        ? "chapter"
        : match[2] === "@"
          ? "assignee"
          : match[2] === "!"
            ? "field-cmd"
            : "status";
  return {
    kind,
    query: match[3]!.toLowerCase(),
    commandStart: value.length - match[2]!.length - match[3]!.length,
  };
}

export function pickerOptions(
  picker: PickerState | null,
  categories: ProjectCategory[],
  chapters: Chapter[],
  members: Member[],
  fields: ProjectField[],
): PickerOption[] {
  const kind = picker?.kind ?? null;
  if (kind === "field-cmd") {
    return fields.map((field) => ({
      id: `cmd-${field.key}`,
      label: field.label,
      search: `${field.label} ${field.key}`.toLowerCase(),
      value: null,
      fieldKey: field.key,
      opensPanel: true,
      hint: fieldKindWord(field),
    }));
  }
  if (kind === "field") {
    const field = fields.find((candidate) => candidate.key === picker?.fieldKey);
    if (!field) return [];
    if (field.type === "checkbox") {
      return [
        { id: `field-${field.key}-none`, label: "Not set", search: "not set none clear", value: null },
        { id: `field-${field.key}-yes`, label: "Yes", search: "yes true checked", value: true },
        { id: `field-${field.key}-no`, label: "No", search: "no false unchecked", value: false },
      ];
    }
    return [
      { id: `field-${field.key}-none`, label: "Not set", search: "not set none clear", value: null },
      ...field.options.map((option) => ({
        id: `field-${field.key}-${option}`,
        label: option,
        search: option.toLowerCase(),
        value: option,
      })),
    ];
  }
  if (kind === "category") {
    return [
      { id: "category-none", label: "No category", search: "none uncategorized", value: null },
      ...categories.map((category) => ({
        id: `category-${category.slug}`,
        label: category.name,
        search: `${category.name} ${category.slug}`.toLowerCase(),
        value: category.slug,
        color: category.color,
      })),
    ];
  }
  if (kind === "chapter") {
    return [
      { id: "chapter-none", label: "No chapter", search: "none no chapter", value: null },
      ...chapters.map((chapter) => ({
        id: `chapter-${chapter.slug}`,
        label: chapter.state === "open" ? `${chapter.name} (open)` : chapter.name,
        search: `${chapter.name} ${chapter.slug}`.toLowerCase(),
        value: chapter.slug,
      })),
    ];
  }
  if (kind === "assignee") {
    return [
      { id: "assignee-none", label: "Unassigned", search: "unassigned none", value: null },
      ...members.map((member) => ({
        id: `assignee-${member.id}`,
        label: member.name,
        search: `${member.name} ${member.email}`.toLowerCase(),
        value: member.id,
      })),
    ];
  }
  if (kind === "status") {
    return [
      { id: "status-backlog", label: "Backlog", search: "backlog", value: "backlog" },
      { id: "status-ready", label: "Up Next", search: "up next ready", value: "ready" },
      {
        id: "status-in-progress",
        label: "In progress",
        search: "in progress active working",
        value: "in_progress",
      },
      { id: "status-review", label: "Review", search: "review check verify", value: "review" },
    ];
  }
  return [];
}

export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  if (!query) return options;
  return options
    .filter((option) => option.search.includes(query))
    .sort((left, right) => Number(!left.search.startsWith(query)) - Number(!right.search.startsWith(query)));
}

export function selectedValue(settings: CaptureSettings, picker: PickerState): string | boolean | null {
  if (picker.kind === "category") return settings.category;
  if (picker.kind === "chapter") return settings.chapter;
  if (picker.kind === "assignee") return settings.assigneeId;
  if (picker.kind === "field") {
    const held = picker.fieldKey ? settings.fields[picker.fieldKey] : undefined;
    return held === undefined ? null : (held as string | boolean);
  }
  if (picker.kind === "field-cmd") return null;
  return settings.status;
}

/**
 * Whether anything has been chosen that starting fresh would actually undo.
 *
 * Measured against the defaults rather than against nothing, because the defaults are not
 * nothing: an open chapter and a project's only member are both already answered, and
 * offering to reset to the state somebody is in is offering a button that does nothing.
 */
export function hasCustomSettings(settings: CaptureSettings, defaults: CaptureSettings): boolean {
  return (
    settings.category !== defaults.category ||
    settings.chapter !== defaults.chapter ||
    settings.assigneeId !== defaults.assigneeId ||
    settings.status !== defaults.status ||
    Object.keys(settings.fields).length > 0
  );
}

export function pickerHeading(picker: PickerState, fields: ProjectField[]): string {
  if (picker.kind === "category") return "Category";
  if (picker.kind === "chapter") return "Chapter";
  if (picker.kind === "assignee") return "Assign to";
  if (picker.kind === "field") {
    return fields.find((candidate) => candidate.key === picker.fieldKey)?.label ?? "Field";
  }
  if (picker.kind === "field-cmd") return "Project fields";
  return "Column";
}

export function pickerTrigger(kind: PickerKind): string {
  if (kind === "category") return "#";
  if (kind === "chapter") return "~";
  if (kind === "assignee") return "@";
  if (kind === "field" || kind === "field-cmd") return "!";
  return "/";
}
