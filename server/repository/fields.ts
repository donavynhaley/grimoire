import type { DatabaseSync } from "node:sqlite";
import {
  type FieldType,
  type FieldValue,
  fieldHasOptions,
  fieldTypeSwapAllowed,
  type PageFields,
  type ProjectField,
} from "../../shared/types";
import { isCalendarDay } from "../markdown-chapters";
import type { MarkdownPageStore } from "../markdown-pages";
import { slugify } from "../slug";
import { PageDependencyError } from "./errors";
import { projectById } from "./projects";
import { row, rows } from "./rows";

// A project's custom field definitions, and the checked values pages hold under them.

export function fieldsForProject(database: DatabaseSync, projectId: string): ProjectField[] {
  return rows(
    database,
    `SELECT key, label, type, options, position, show_on_tile FROM project_fields
     WHERE project_id = ? ORDER BY position, created_at`,
    projectId,
  ).map((value) => ({
    key: String(value.key),
    label: String(value.label),
    type: value.type as FieldType,
    options: JSON.parse(String(value.options)) as string[],
    position: Number(value.position),
    showOnTile: Number(value.show_on_tile) === 1,
  }));
}

export function fieldKeyFromLabel(label: string): string {
  return slugify(label, 40);
}

/**
 * A `select` with nothing to select from is a field nobody can fill in, so it is refused at
 * the point someone tries to define one rather than discovered when a page rejects a value.
 */
function normalizeOptions(type: FieldType, options: string[] | undefined): string[] | null {
  if (!fieldHasOptions(type)) return [];
  const cleaned = [...new Set((options ?? []).map((option) => option.trim()).filter(Boolean))];
  return cleaned.length > 0 ? cleaned : null;
}

export type FieldInput = {
  label: string;
  type: FieldType;
  options?: string[];
  showOnTile?: boolean;
};

export type CreateFieldResult = { field: ProjectField } | "exists" | "invalid_label" | "needs_options";

export function createField(database: DatabaseSync, projectId: string, input: FieldInput): CreateFieldResult {
  const key = fieldKeyFromLabel(input.label);
  if (!key) return "invalid_label";
  const options = normalizeOptions(input.type, input.options);
  if (options === null) return "needs_options";
  if (row(database, "SELECT 1 AS ok FROM project_fields WHERE project_id = ? AND key = ?", projectId, key)) {
    return "exists";
  }
  const position = fieldsForProject(database, projectId).length;
  const showOnTile = input.showOnTile ?? false;
  database
    .prepare(
      `INSERT INTO project_fields (project_id, key, label, type, options, position, show_on_tile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      key,
      input.label,
      input.type,
      JSON.stringify(options),
      position,
      showOnTile ? 1 : 0,
      new Date().toISOString(),
    );
  return { field: { key, label: input.label, type: input.type, options, position, showOnTile } };
}

export type UpdateFieldResult =
  | { field: ProjectField; cleared: number }
  | "not_found"
  | "needs_options"
  | "type_locked";

/**
 * Edits a definition, including the one type change that costs nothing.
 *
 * Changing a field's type would ordinarily invalidate every value already stored under it, and
 * the honest repair for that is the one a person can already do: delete the field and define
 * the one they meant. Swapping between the two choice types is not that change. They share an
 * option list and a validator, so no stored value moves and none is reinterpreted - only the
 * control the page draws does. A team learns which one it wanted by watching its option list
 * grow, which is after the field exists, so refusing the swap meant deleting a field to get a
 * different button. Every other pairing is still refused, here rather than at the route, so
 * nothing reaches the table on a caller's word about what is safe.
 */
export function updateField(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  key: string,
  input: { label?: string; type?: FieldType; options?: string[]; showOnTile?: boolean; position?: number },
): UpdateFieldResult {
  const project = projectById(database, projectId);
  const current = fieldsForProject(database, projectId).find((field) => field.key === key);
  if (!project || !current) return "not_found";
  const type = input.type ?? current.type;
  if (!fieldTypeSwapAllowed(current.type, type)) return "type_locked";
  const options = input.options === undefined ? current.options : normalizeOptions(type, input.options);
  if (options === null) return "needs_options";

  const label = input.label ?? current.label;
  const showOnTile = input.showOnTile ?? current.showOnTile;
  const position = input.position ?? current.position;

  // A value whose option was just withdrawn cannot stay: the next write touching that page
  // would be refused for holding something the field no longer offers, and the person
  // making that write would have had nothing to do with the withdrawal. The values clear
  // before the definition changes so an interruption leaves a field still holding the old
  // options, not pages holding values the new ones refuse.
  const cleared = fieldHasOptions(type)
    ? clearFieldValues(
        pageStore,
        String(project.slug),
        key,
        (value) => typeof value === "string" && options.includes(value),
      )
    : 0;
  database
    .prepare(
      `UPDATE project_fields SET label = ?, type = ?, options = ?, show_on_tile = ?, position = ?
       WHERE project_id = ? AND key = ?`,
    )
    .run(label, type, JSON.stringify(options), showOnTile ? 1 : 0, position, projectId, key);
  return { field: { key, label, type, options, position, showOnTile }, cleared };
}

/** Returns how many pages lost a value, or null when there was no such field. */
export function deleteField(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  key: string,
): number | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const exists = row(
    database,
    "SELECT 1 AS present FROM project_fields WHERE project_id = ? AND key = ?",
    projectId,
    key,
  );
  if (!exists) return null;
  // Values first, definition last - the same interruption story category deletion tells.
  const cleared = clearFieldValues(pageStore, String(project.slug), key, () => false);
  database.prepare("DELETE FROM project_fields WHERE project_id = ? AND key = ?").run(projectId, key);
  return cleared;
}

function clearFieldValues(
  pageStore: MarkdownPageStore,
  projectSlug: string,
  key: string,
  keep: (value: FieldValue) => boolean,
): number {
  const now = new Date().toISOString();
  let cleared = 0;
  for (const page of pageStore.list(projectSlug)) {
    const value = page.fields[key];
    if (value === undefined || keep(value)) continue;
    const { [key]: _dropped, ...rest } = page.fields;
    pageStore.save(projectSlug, { ...page, fields: rest, updatedAt: now });
    cleared += 1;
  }
  return cleared;
}

/**
 * Applies a patch of field values on top of what a page already holds.
 *
 * It is a patch rather than a replacement because an agent setting one field must not blank
 * the others: a whole-record write would quietly erase every field the caller did not happen
 * to know about, which for an agent is most of them. `null` is how a caller clears one, and
 * clearing drops the key, so a page that was never filled in and one that was emptied are
 * the same page on disk.
 */
export function mergePageFields(
  definitions: ProjectField[],
  current: PageFields,
  patch: Record<string, FieldValue | null> | undefined,
): PageFields {
  if (patch === undefined) return current;
  const merged: PageFields = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const definition = definitions.find((field) => field.key === key);
    if (!definition) throw new PageDependencyError(`This project has no field called "${key}"`, 400);
    if (value === null) delete merged[key];
    else merged[key] = checkedFieldValue(definition, value);
  }
  return merged;
}

function checkedFieldValue(definition: ProjectField, value: FieldValue): FieldValue {
  const expected = (wanted: string) =>
    new PageDependencyError(`"${definition.label}" expects ${wanted}`, 400);
  switch (definition.type) {
    case "text":
      if (typeof value !== "string") throw expected("text");
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw expected("a number");
      return value;
    case "checkbox":
      if (typeof value !== "boolean") throw expected("true or false");
      return value;
    case "date":
      if (typeof value !== "string" || !isCalendarDay(value)) throw expected("a YYYY-MM-DD day");
      return value;
    case "select":
    case "search-select":
      if (typeof value !== "string" || !definition.options.includes(value)) {
        throw new PageDependencyError(`"${definition.label}" accepts ${definition.options.join(", ")}`, 400);
      }
      return value;
  }
}
