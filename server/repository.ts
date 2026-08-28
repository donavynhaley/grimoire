import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { slugify } from "./slug";
import { withTransaction } from "./database";
import { placeInOrder, renumber } from "./ordering";
import {
  openThreadCount,
  openThreadCounts,
  unseenCount,
  unseenCounts,
  unseenMentionCount,
  unseenMentionCounts,
} from "./discussion";
import {
  fieldHasOptions,
  fieldTypeSwapAllowed,
  type ChapterVelocity,
  type PageGithubLink,
  type PageGithubStatus,
  PAGE_STATUSES,
  type ArchivedProject,
  type BoardWorkspace,
  type Page,
  type PageCategory,
  type PageStatus,
  type Chapter,
  type ChapterState,
  type FieldType,
  type FieldValue,
  type Member,
  type PageFields,
  type ProjectCategory,
  type ProjectField,
  type ProjectSummary,
  type User,
  type AccountRole,
  type ProjectRole,
} from "../shared/types";
import { MarkdownPageStore, type StoredPage } from "./markdown-pages";
import { isCalendarDay, MarkdownChapterStore, type StoredChapter } from "./markdown-chapters";

type Row = Record<string, string | number | null>;

function rows(database: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return database.prepare(sql).all(...params) as Row[];
}

function row(database: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row | undefined {
  return database.prepare(sql).get(...params) as Row | undefined;
}

export function publicUser(value: Row): User {
  return {
    id: String(value.id),
    name: String(value.name),
    email: String(value.email),
    // Checked rather than cast, because this value is what requireAdmin gates on;
    // a row that stopped saying 'admin' - however it got that way - must read as
    // the lesser role, never as whatever the column happens to hold.
    role: value.role === "admin" ? "admin" : "member",
  };
}

export function findUserByEmail(database: DatabaseSync, email: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE email = ? COLLATE NOCASE", email);
}

export function findUserById(database: DatabaseSync, id: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE id = ?", id);
}

export function userCount(database: DatabaseSync): number {
  return Number(row(database, "SELECT COUNT(*) AS count FROM users")?.count ?? 0);
}

/**
 * Where somebody lands with no project named: the first one they were put on.
 *
 * The admin falls back to the oldest project on the installation, so an admin who happens
 * to be on none of them still has somewhere to land - the login gate refuses an account
 * with no project at all, and the one account that can never be locked out must not be
 * the one that trips it.
 */
export function defaultProjectIdForUser(database: DatabaseSync, user: User): string | null {
  const value =
    row(
      database,
      `SELECT project_members.project_id FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.user_id = ? AND projects.archived_at IS NULL
       ORDER BY project_members.created_at LIMIT 1`,
      user.id,
    ) ??
    (user.role === "admin"
      ? row(
          database,
          "SELECT id AS project_id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1",
        )
      : undefined);
  return value ? String(value.project_id) : null;
}

export function projectSlug(database: DatabaseSync, projectId: string): string | null {
  const project = row(database, "SELECT slug FROM projects WHERE id = ?", projectId);
  return project ? String(project.slug) : null;
}

/** The reader's private boundary into the activity log, or null before their first look. */
export function seenCursor(database: DatabaseSync, projectId: string, userId: string): number | null {
  const value = row(
    database,
    "SELECT last_seen_sequence FROM seen_cursors WHERE project_id = ? AND user_id = ?",
    projectId,
    userId,
  );
  return value ? Number(value.last_seen_sequence) : null;
}

/**
 * First look at a project starts at the present, so joining never dumps the
 * whole history as unread. Racing tabs both succeed; the first row wins.
 */
export function initializeSeenCursor(
  database: DatabaseSync,
  projectId: string,
  userId: string,
  sequence: number,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}

/** Advances with MAX semantics, so stale tabs and repeats can never rewind the boundary. */
export function advanceSeenCursor(
  database: DatabaseSync,
  projectId: string,
  userId: string,
  sequence: number,
): void {
  database
    .prepare(
      `INSERT INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         last_seen_sequence = MAX(last_seen_sequence, excluded.last_seen_sequence),
         updated_at = excluded.updated_at`,
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}

/**
 * Whether this person is on that project at all.
 *
 * Membership is the reach. Owning a project says what somebody may do once they are on it,
 * never which projects they are on: being an owner somewhere is not a standing invitation
 * to every project on the installation, and somebody has to have put them on it. Nothing is
 * lost by insisting on that, because the account that creates a project is written in as its
 * owning member and that is the one membership row no removal may delete.
 *
 * The admin is the deliberate exception, and the only one - an installation needs an account
 * that cannot be shut out of it.
 */
export function userCanAccessProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "admin") {
    return Boolean(
      row(database, "SELECT 1 AS ok FROM projects WHERE id = ? AND archived_at IS NULL", projectId),
    );
  }
  return Boolean(
    row(
      database,
      `SELECT 1 AS ok FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.project_id = ? AND project_members.user_id = ? AND projects.archived_at IS NULL`,
      projectId,
      user.id,
    ),
  );
}

/**
 * Whether this person may reshape that project - its name, categories, chapters, fields,
 * agent access and membership.
 *
 * Two ways to be true, and they answer different questions. The project's own `owner` row
 * is the ordinary one: whoever created it holds it, and an owner may grant it to somebody
 * else on that project and nowhere else. The admin passes everywhere, which is the whole
 * point of there being one - an installation always has somebody who can reach into a
 * project whose owner has gone quiet.
 */
export function userOwnsProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "admin") return true;
  return Boolean(
    row(
      database,
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'owner'",
      projectId,
      user.id,
    ),
  );
}

/** The projects this person is on - every one of them, for the admin. The picker offers these. */
export function listProjectsForUser(database: DatabaseSync, user: User): ProjectSummary[] {
  const values =
    user.role === "admin"
      ? rows(
          database,
          "SELECT id, name, description FROM projects WHERE archived_at IS NULL ORDER BY created_at",
        )
      : rows(
          database,
          `SELECT projects.id, projects.name, projects.description FROM project_members
         JOIN projects ON projects.id = project_members.project_id
         WHERE project_members.user_id = ? AND projects.archived_at IS NULL
         ORDER BY project_members.created_at`,
          user.id,
        );
  return values.map((value) => ({
    id: String(value.id),
    name: String(value.name),
    description: String(value.description ?? ""),
  }));
}

export function renameProject(database: DatabaseSync, projectId: string, name: string): boolean {
  const result = database
    .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(name, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function setProjectDescription(
  database: DatabaseSync,
  projectId: string,
  description: string,
): boolean {
  const result = database
    .prepare("UPDATE projects SET description = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(description, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export type ArchiveProjectResult = "archived" | "not_found" | "last_project";

export function archiveProject(database: DatabaseSync, projectId: string): ArchiveProjectResult {
  const active = rows(database, "SELECT id FROM projects WHERE archived_at IS NULL");
  if (!active.some((value) => String(value.id) === projectId)) return "not_found";
  if (active.length === 1) return "last_project";
  database
    .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), projectId);
  return "archived";
}

/** Archiving was a one-way door until this list existed; it feeds the owner's restore surface. */
/**
 * The archived projects this person is on, newest first.
 *
 * Archiving only sets `archived_at`, so the membership rows outlive it and still say whose
 * project this was. A restore list drawn without them would name every project the
 * installation has ever archived to anyone holding the owner role.
 */
export function listArchivedProjects(database: DatabaseSync, user: User): ArchivedProject[] {
  return (
    user.role === "admin"
      ? rows(
          database,
          "SELECT id, name, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
        )
      : rows(
          database,
          `SELECT projects.id, projects.name, projects.archived_at FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.user_id = ? AND project_members.role = 'owner'
         AND projects.archived_at IS NOT NULL
       ORDER BY projects.archived_at DESC`,
          user.id,
        )
  ).map((value) => ({
    id: String(value.id),
    name: String(value.name),
    archivedAt: String(value.archived_at),
  }));
}

/** Clears `archived_at`, which is all archiving ever set - the files never left the disk. */
export function restoreProject(database: DatabaseSync, projectId: string): boolean {
  const result = database
    .prepare(
      "UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
    )
    .run(new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function categoriesForProject(database: DatabaseSync, projectId: string): ProjectCategory[] {
  return rows(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? ORDER BY position, created_at",
    projectId,
  ).map((value) => ({
    slug: String(value.slug),
    name: String(value.name),
    color: String(value.color),
    position: Number(value.position),
  }));
}

export function categorySlugFromName(name: string): string {
  return slugify(name, 40);
}

export type CreateCategoryResult = { category: ProjectCategory } | "exists" | "invalid_name";

export function createCategory(
  database: DatabaseSync,
  projectId: string,
  input: { name: string; color: string },
): CreateCategoryResult {
  const slug = categorySlugFromName(input.name);
  if (!slug) return "invalid_name";
  if (row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    return "exists";
  }
  const position = categoriesForProject(database, projectId).length;
  database
    .prepare(
      "INSERT INTO categories (project_id, slug, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(projectId, slug, input.name, input.color, position, new Date().toISOString());
  return { category: { slug, name: input.name, color: input.color, position } };
}

export function updateCategory(
  database: DatabaseSync,
  projectId: string,
  slug: string,
  input: { name?: string; color?: string; position?: number },
): ProjectCategory | null {
  const current = row(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? AND slug = ?",
    projectId,
    slug,
  );
  if (!current) return null;
  const name = input.name ?? String(current.name);
  const color = input.color ?? String(current.color);
  const position = input.position ?? Number(current.position);
  database
    .prepare("UPDATE categories SET name = ?, color = ?, position = ? WHERE project_id = ? AND slug = ?")
    .run(name, color, position, projectId, slug);
  return { slug, name, color, position };
}

export function deleteCategory(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  slug: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const exists = row(
    database,
    "SELECT 1 AS present FROM categories WHERE project_id = ? AND slug = ?",
    projectId,
    slug,
  );
  if (!exists) return false;
  // Pages release the value before the definition goes, because the two writes cannot
  // share a transaction: interrupted this way around, the category still exists and
  // deleting it again finishes the job - the other way, pages hold a value the strict
  // schema no longer accepts.
  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.category !== slug) return;
    pageStore.save(String(project.slug), { ...page, category: null, updatedAt: now });
  });
  const removed = database
    .prepare("DELETE FROM categories WHERE project_id = ? AND slug = ?")
    .run(projectId, slug);
  return Number(removed.changes) === 1;
}

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
  { field: ProjectField; cleared: number } | "not_found" | "needs_options" | "type_locked";

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

export function chaptersEnabled(database: DatabaseSync, projectId: string): boolean {
  const project = row(database, "SELECT chapters_enabled FROM projects WHERE id = ?", projectId);
  return Number(project?.chapters_enabled ?? 0) === 1;
}

/**
 * Flips the per-project gate.
 *
 * Turning chapters off is deliberately not destructive: the chapter files stay on disk and
 * pages keep their `chapter` field, so the only thing that changes is whether the interface
 * draws any of it. Turning it back on restores exactly the prior state.
 */
export function setChaptersEnabled(database: DatabaseSync, projectId: string, enabled: boolean): boolean {
  const result = database
    .prepare("UPDATE projects SET chapters_enabled = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(enabled ? 1 : 0, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function chaptersForProject(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
): Chapter[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  return chapterStore.list(String(project.slug)).map((chapter) => publicChapter(database, chapter, members));
}

export function chapterSlugFromName(name: string): string {
  return slugify(name, 60);
}

export type ChapterInput = {
  name: string;
  description?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  state?: ChapterState;
};

export type CreateChapterResult = { chapter: Chapter } | "exists" | "invalid_name" | "already_open";

export function createChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  creatorId: string,
  input: ChapterInput,
): CreateChapterResult | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  if (!project || !creator) return null;
  const slug = chapterSlugFromName(input.name);
  if (!slug) return "invalid_name";
  const projectSlug = String(project.slug);
  const existing = chapterStore.list(projectSlug);
  if (existing.some((chapter) => chapter.slug === slug)) return "exists";
  const state = input.state ?? "planned";
  if (state === "open" && existing.some((chapter) => chapter.state === "open")) return "already_open";
  requireCoherentDates(input.startsOn ?? null, input.endsOn ?? null);

  const now = new Date().toISOString();
  const chapter: StoredChapter = {
    slug,
    name: input.name.trim(),
    description: input.description ?? "",
    state,
    position: existing.length,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    closedAt: state === "closed" ? now : null,
    carriedPages: null,
    carriedEstimate: null,
    carriedTo: null,
    deliveredPages: null,
    deliveredEstimate: null,
  };
  chapterStore.save(projectSlug, chapter);
  return { chapter: publicChapter(database, chapter, members) };
}

export type UpdateChapterResult = { chapter: Chapter } | "not_found" | "already_open";

/**
 * Edits one chapter, including its state.
 *
 * Two rules live here rather than in the interface. At most one chapter is open at a time,
 * which is what keeps the feature meaning "what are we working on now" instead of becoming a
 * grid of parallel workstreams; the caller is expected to close the current one first, as an
 * explicit act. And closing stamps `closedAt` while reopening clears it, mirroring how a
 * page's `completedAt` behaves - crucially, without touching a single page either way.
 */
export function updateChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
  input: Partial<ChapterInput> & { position?: number; expectedDescription?: string },
): UpdateChapterResult | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const current = chapterStore.get(projectSlug, slug);
  if (!current) return "not_found";
  requireUnchangedContent(
    { title: current.name, description: current.description },
    { expectedDescription: input.expectedDescription },
    publicChapter(database, current, membersForProject(database, projectId)),
    "chapter",
  );

  const nextState = input.state ?? current.state;
  if (nextState === "open" && current.state !== "open") {
    const conflict = chapterStore
      .list(projectSlug)
      .some((chapter) => chapter.slug !== slug && chapter.state === "open");
    if (conflict) return "already_open";
  }
  const startsOn = input.startsOn === undefined ? current.startsOn : input.startsOn;
  const endsOn = input.endsOn === undefined ? current.endsOn : input.endsOn;
  requireCoherentDates(startsOn, endsOn);

  const now = new Date().toISOString();
  const updated: StoredChapter = {
    ...current,
    name: input.name === undefined ? current.name : input.name.trim(),
    description: input.description ?? current.description,
    state: nextState,
    startsOn,
    endsOn,
    position: input.position ?? current.position,
    updatedAt: now,
    closedAt: nextState === "closed" ? (current.closedAt ?? now) : null,
  };
  chapterStore.save(projectSlug, updated);
  return { chapter: publicChapter(database, updated, membersForProject(database, projectId)) };
}

/**
 * Removes a chapter and clears it from every page that referenced it.
 *
 * This mirrors category deletion. It is the one genuinely lossy chapter operation, which is
 * why the interface names the affected count before asking.
 */
export function deleteChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const projectSlug = String(project.slug);
  if (!chapterStore.get(projectSlug, slug)) return false;
  // Pages are released before the chapter file goes: interrupted here, the chapter
  // still exists and a second delete finishes the job, rather than pages pointing at
  // a chapter that no longer does.
  const now = new Date().toISOString();
  pageStore.list(projectSlug).forEach((page) => {
    if (page.chapter !== slug) return;
    pageStore.save(projectSlug, { ...page, chapter: null, updatedAt: now });
  });
  chapterStore.remove(projectSlug, slug);
  return true;
}

/** How many pages a chapter would release if it were deleted. */
export function pagesInChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  slug: string,
): number {
  const project = projectById(database, projectId);
  if (!project) return 0;
  return pageStore.list(String(project.slug)).filter((page) => page.chapter === slug).length;
}

export function getBoard(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  user: User,
  projectId: string,
): BoardWorkspace | null {
  const project = row(
    database,
    "SELECT id, name, slug, description, chapters_enabled, estimates_enabled, github_repo, github_token, discord_webhook, recap_on_close FROM projects WHERE id = ?",
    projectId,
  );
  if (!project) return null;

  const members = membersForProject(database, projectId);
  const pages = pageStore.list(String(project.slug));
  validateDependencyGraph(pages);
  const enabled = Number(project.chapters_enabled ?? 0) === 1;
  const estimatesOn = Number(project.estimates_enabled ?? 0) === 1;
  const githubStatuses = githubStatusesForProject(database, projectId);
  const openThreads = openThreadCounts(database, projectId);
  const unseen = unseenCounts(database, projectId, user.id);
  const mentioned = unseenMentionCounts(database, projectId, user.id);

  return {
    project: {
      id: String(project.id),
      name: String(project.name),
      description: String(project.description ?? ""),
      chaptersEnabled: enabled,
      githubRepo: String(project.github_repo ?? ""),
      // The token itself never rides the board payload; the interface only needs to know
      // whether one is held so settings can say "set" without saying what.
      githubTokenSet: String(project.github_token ?? "") !== "",
      estimatesEnabled: Number(project.estimates_enabled ?? 0) === 1,
      // The webhook itself stays on the server; the interface only needs to know one is held.
      discordWebhookSet: String(project.discord_webhook ?? "") !== "",
      recapOnClose: Number(project.recap_on_close ?? 1) === 1,
    },
    projects: listProjectsForUser(database, user),
    categories: categoriesForProject(database, projectId),
    fields: fieldsForProject(database, projectId),
    // A disabled project serves no chapters at all, so the interface has nothing to draw
    // even if files exist on disk from before the gate was turned off.
    chapters: enabled
      ? chapterStore.list(String(project.slug)).map((chapter) => publicChapter(database, chapter, members))
      : [],
    currentUser: user,
    viewerIsOwner: userOwnsProject(database, user, projectId),
    members,
    pages: pages.map((page) =>
      publicPage(database, projectId, page, members, githubStatuses, openThreads, {
        id: user.id,
        unseen,
        mentions: mentioned,
      }),
    ),
    // Chapters and estimates are separate gates, and velocity is the place they meet: it is
    // an estimate summed per chapter, so it needs both to mean anything.
    velocity:
      enabled && estimatesOn
        ? chapterStore.list(String(project.slug)).map((chapter) => velocityFor(chapter, pages))
        : [],
  };
}

/**
 * What one chapter delivered and what it still holds.
 *
 * Delivered counts pages finished while they belonged to this chapter, which is the only
 * honest reading once rollover exists: unfinished work moves onward, so a page that carried
 * over is counted by whichever chapter it was actually finished in. Pages nobody estimated
 * are counted separately rather than as zero, so an empty total can be told from an
 * unestimated one.
 */
function velocityFor(chapter: StoredChapter, pages: StoredPage[]): ChapterVelocity {
  const mine = pages.filter((page) => page.chapter === chapter.slug);
  const done = mine.filter((page) => page.status === "done");
  const open = mine.filter((page) => page.status !== "done");
  const total = (group: StoredPage[]) => group.reduce((sum, page) => sum + (page.estimate ?? 0), 0);
  // A closed chapter answers with the numbers it recorded as it closed. Anything else would
  // let later edits rewrite history: archive a delivered page and the stretch it was
  // delivered in would quietly claim less than it did.
  const recorded = chapter.deliveredPages !== null;
  return {
    slug: chapter.slug,
    donePages: recorded ? chapter.deliveredPages! : done.length,
    doneEstimate: recorded ? (chapter.deliveredEstimate ?? 0) : total(done),
    openPages: open.length,
    openEstimate: total(open),
    unestimatedPages: mine.filter((page) => page.estimate === null).length,
    recorded,
  };
}

/** Reads one page in the same shape the board serves, for before-and-after comparisons. */
export function findPage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const stored = pageStore.get(String(project.slug), pageId);
  if (!stored) return null;
  return publicPage(
    database,
    projectId,
    stored,
    membersForProject(database, projectId),
    githubStatusesForProject(database, projectId),
  );
}

export function listPages(database: DatabaseSync, pageStore: MarkdownPageStore, projectId: string): Page[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  const openThreads = openThreadCounts(database, projectId);
  return pageStore
    .list(String(project.slug))
    .map((page) => publicPage(database, projectId, page, members, undefined, openThreads));
}

type PageInput = {
  title: string;
  description?: string;
  category?: PageCategory | null;
  chapter?: string | null;
  /** A patch, not a replacement: `null` clears one field and absent keys are left alone. */
  fields?: Record<string, FieldValue | null>;
  blockedBy?: string[];
  status?: PageStatus;
  assigneeId?: string | null;
  /** The page's tie to GitHub: a parsed link to hold, or null to let go of one. */
  github?: PageGithubLink | null;
  /** How much work this is; null clears it. */
  estimate?: number | null;
};

export function createPage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  creatorId: string,
  input: PageInput,
): Page | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (!project || !creator || (input.assigneeId && !assignee)) return null;
  if (input.category) requireProjectCategory(database, projectId, input.category);
  if (input.chapter) requireProjectChapter(database, chapterStore, projectId, input.chapter);
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "backlog";
  const pages = pageStore.list(String(project.slug));
  const position = pages.filter((page) => page.status === status).length;
  const page: StoredPage = {
    id,
    title: input.title,
    description: input.description ?? "",
    category: input.category ?? null,
    chapter: input.chapter ?? null,
    fields: mergePageFields(fieldsForProject(database, projectId), {}, input.fields),
    blockedBy: input.blockedBy ?? [],
    unblockedPages: [],
    status,
    position,
    assignee: assignee?.email.toLowerCase() ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
    archivedAt: null,
    github: null,
    estimate: input.estimate ?? null,
  };
  validateDependencyGraph([...pages, page]);
  pageStore.save(String(project.slug), page);
  return publicPage(database, projectId, page, members);
}

export function updatePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  pageId: string,
  input: Partial<PageInput> & { position?: number; expectedTitle?: string; expectedDescription?: string },
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const members = membersForProject(database, projectId);
  const pages = pageStore.list(projectSlug);
  const current = pages.find((page) => page.id === pageId);
  if (!current) return null;
  requireUnchangedContent(current, input, publicPage(database, projectId, current, members), "page");
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (input.assigneeId && !assignee) return null;
  if (input.category) requireProjectCategory(database, projectId, input.category);
  if (input.chapter) requireProjectChapter(database, chapterStore, projectId, input.chapter);

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();
  const completedAt =
    nextStatus === "done"
      ? current.status === "done"
        ? (current.completedAt ?? current.updatedAt)
        : now
      : null;
  const updated: StoredPage = {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    category: input.category === undefined ? current.category : input.category,
    chapter: input.chapter === undefined ? current.chapter : input.chapter,
    fields: mergePageFields(fieldsForProject(database, projectId), current.fields, input.fields),
    blockedBy: input.blockedBy ?? current.blockedBy,
    status: nextStatus,
    assignee: input.assigneeId === undefined ? current.assignee : (assignee?.email.toLowerCase() ?? null),
    github: input.github === undefined ? current.github : input.github,
    estimate: input.estimate === undefined ? current.estimate : input.estimate,
    updatedAt: now,
    completedAt,
  };
  validateDependencyGraph(pages.map((page) => (page.id === pageId ? updated : page)));

  if (!shouldMove) {
    pageStore.save(projectSlug, updated);
    return publicPage(database, projectId, updated, members);
  }

  for (const status of PAGE_STATUSES) {
    const others = pages.filter((page) => page.id !== pageId && page.status === status);
    const ordered =
      status === nextStatus ? placeInOrder(others, updated, input.position ?? others.length) : others;
    const settled = renumber(ordered, (page) => pageStore.save(projectSlug, page), pageId);
    if (settled >= 0) updated.position = settled;
  }
  return publicPage(database, projectId, updated, members);
}

export function archivePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const projectSlug = String(project.slug);
  const current = pageStore.get(projectSlug, pageId);
  if (!current) return false;
  const pages = pageStore.list(projectSlug);
  const dependents = pages.filter((page) => page.id !== pageId && page.blockedBy.includes(pageId));
  if (current.status !== "done" && dependents.some((page) => page.status !== "done")) {
    throw new PageDependencyError("This page blocks active work and cannot be archived", 409);
  }
  const now = new Date().toISOString();
  dependents.forEach((page) => {
    pageStore.save(projectSlug, {
      ...page,
      blockedBy: page.blockedBy.filter((dependencyId) => dependencyId !== pageId),
      updatedAt: now,
    });
  });
  pageStore.archive(projectSlug, {
    ...current,
    unblockedPages: dependents.map((page) => page.id),
    archivedAt: now,
    updatedAt: now,
  });
  renumber(
    pageStore.list(projectSlug).filter((page) => page.status === current.status),
    (page) => pageStore.save(projectSlug, page),
  );
  return true;
}

export function restorePage(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  pageId: string,
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const archived = pageStore.getArchived(projectSlug, pageId);
  if (!archived) return null;
  const pages = pageStore.list(projectSlug);
  const restored: StoredPage = {
    ...archived,
    unblockedPages: [],
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  const previouslyBlocked = new Set(archived.unblockedPages);
  const restoredPages = pages.map((page) =>
    previouslyBlocked.has(page.id)
      ? { ...page, blockedBy: [...page.blockedBy, restored.id], updatedAt: restored.updatedAt }
      : page,
  );
  validateDependencyGraph([...restoredPages, restored]);
  pageStore.restore(projectSlug, restored);

  restoredPages.forEach((page) => {
    const previous = pages.find((candidate) => candidate.id === page.id);
    if (previous && previous.blockedBy.length !== page.blockedBy.length) pageStore.save(projectSlug, page);
  });

  const ordered = placeInOrder(
    restoredPages.filter((page) => page.status === restored.status),
    restored,
    restored.position,
  );
  renumber(ordered, (page) => pageStore.save(projectSlug, page));
  restored.position = ordered.findIndex((page) => page.id === restored.id);
  return publicPage(database, projectId, restored, membersForProject(database, projectId));
}

export function projectById(database: DatabaseSync, projectId: string): Row | undefined {
  return row(database, "SELECT id, name, slug, description FROM projects WHERE id = ?", projectId);
}

export type AddProjectMemberResult = { added: User } | "no_account" | "already_there";

/**
 * Puts somebody who already has an account onto another project.
 *
 * An invitation only ever made an account, and refused an email that already had one, so
 * there was no way to work with a colleague on a second project: they could be on the one
 * they registered through and on nothing else. That went unnoticed while owning anything
 * meant reaching everything, and became the obvious hole the moment membership was the reach.
 *
 * They join as a member. An owner promotes from the same place afterwards if that is what
 * was meant - which keeps this one action about access and nothing else.
 */
export function addProjectMember(
  database: DatabaseSync,
  projectId: string,
  email: string,
): AddProjectMemberResult {
  const found = findUserByEmail(database, email);
  if (!found) return "no_account";
  const invited = publicUser(found);
  if (
    row(
      database,
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId,
      invited.id,
    )
  ) {
    return "already_there";
  }
  database
    .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(projectId, invited.id, new Date().toISOString());
  return { added: invited };
}

export function membersForProject(database: DatabaseSync, projectId: string): Member[] {
  return rows(
    database,
    `SELECT users.id, users.name, users.email, users.role, project_members.role AS project_role
     FROM project_members JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? ORDER BY project_members.created_at`,
    projectId,
  ).map((value): Member => ({
    ...publicUser(value),
    projectRole: value.project_role as Member["projectRole"],
  }));
}

export type SetMemberRoleResult = "updated" | "not_found" | "unchanged" | "admin";

/**
 * Promotes or demotes somebody on one project.
 *
 * This grants the project, and only the project. It used to write the account-wide role and
 * then copy it across every membership row the person held, so promoting a second owner
 * handed them the whole installation and demoting them in one project took away a project
 * they had created themselves.
 *
 * The admin is refused rather than guarded: it is an installation role, so there is no
 * project promotion that could grant it and none that should be able to take it back.
 */
export function setMemberRole(
  database: DatabaseSync,
  projectId: string,
  memberId: string,
  role: ProjectRole,
): SetMemberRoleResult {
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!member) return "not_found";
  // The admin is not a project role and cannot be handed out or taken back by one.
  if (member.role === "admin") return "admin";
  if (member.projectRole === role) return "unchanged";

  // Scoped to this project, and to `project_members` alone. Writing the account role too -
  // and worse, writing it across every membership row the person had - is what made one
  // promotion reach every project they were on, and what let a demotion in somebody else's
  // project strip them of the project they created themselves.
  database
    .prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?")
    .run(role, projectId, memberId);
  return "updated";
}

export type RemoveMemberResult = "removed" | "not_found" | "owner" | "admin";

export function removeProjectMember(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  memberId: string,
): RemoveMemberResult {
  const project = projectById(database, projectId);
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!project || !member) return "not_found";
  if (member.projectRole === "owner") return "owner";
  // The installation's admin is not a member a project owner gets to remove.
  if (member.role === "admin") return "admin";

  withTransaction(database, () => {
    const removed = database
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'")
      .run(projectId, memberId);
    if (Number(removed.changes) !== 1)
      throw new Error("Project membership changed while it was being removed");
    database
      .prepare("DELETE FROM seen_cursors WHERE project_id = ? AND user_id = ?")
      .run(projectId, memberId);
    const remaining = row(
      database,
      "SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?",
      memberId,
    );
    if (Number(remaining?.count ?? 0) === 0) {
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(memberId);
    }
  });

  // Assignments clear only once the removal has committed. Cleared first, a rolled-back
  // removal would leave a still-present member silently unassigned from everything; this
  // way an interruption leaves page files naming a non-member, which the board already
  // reads as unassigned.
  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.assignee?.toLowerCase() !== member.email.toLowerCase()) return;
    pageStore.save(String(project.slug), { ...page, assignee: null, updatedAt: now });
  });
  return "removed";
}

function publicPage(
  database: DatabaseSync,
  projectId: string,
  value: StoredPage,
  members: Member[],
  githubStatuses?: Map<string, PageGithubStatus>,
  /*
   * Counted once for the whole board and handed down, because this is read on every board
   * load and a project of a few hundred pages should not pay a query per tile. A single page
   * read on its own counts for itself instead, so it is never quietly wrong.
   */
  openThreads?: Map<string, number>,
  /** Whose unread count this is. Absent where a read is not on anyone's behalf. */
  reader?: { id: string; unseen?: Map<string, number>; mentions?: Map<string, number> },
): Page {
  // Page files are edited outside Grimoire, so a name the project does not know is
  // ordinary weather, not corruption. An unknown assignee reads as unassigned and an
  // unknown creator keeps the written email as their name - throwing here would let
  // one odd file take the entire board down, since getBoard serializes every page.
  const assignee = value.assignee
    ? (members.find((member) => member.email.toLowerCase() === value.assignee?.toLowerCase()) ?? null)
    : null;
  const currentCreator = members.find(
    (member) => member.email.toLowerCase() === value.createdBy.toLowerCase(),
  );
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    category: value.category,
    chapter: value.chapter,
    fields: value.fields,
    blockedBy: value.blockedBy,
    status: value.status,
    position: value.position,
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    createdById: historicalCreator ? String(historicalCreator.id) : "",
    createdByName: historicalCreator ? String(historicalCreator.name) : value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
    estimate: value.estimate,
    github: value.github,
    githubStatus: value.github
      ? (githubStatuses?.get(value.id) ?? {
          state: "unchecked",
          prNumber: null,
          prTitle: null,
          prUrl: null,
          checkedAt: null,
        })
      : null,
    openThreads: openThreads
      ? (openThreads.get(value.id) ?? 0)
      : openThreadCount(database, projectId, value.id),
    unseenMessages: reader
      ? reader.unseen
        ? (reader.unseen.get(value.id) ?? 0)
        : unseenCount(database, projectId, value.id, reader.id)
      : 0,
    unseenMentions: reader
      ? reader.mentions
        ? (reader.mentions.get(value.id) ?? 0)
        : unseenMentionCount(database, projectId, value.id, reader.id)
      : 0,
  };
}

export class PageDependencyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * A write refused because the stored value is not the one the editor was working from.
 *
 * The check is per field rather than per record so that editing a title never collides
 * with a teammate rewriting the notes. `current` is returned to the caller so the editor
 * can show what it collided with instead of asking for the record again.
 */
export class EditConflictError extends Error {
  constructor(
    message: string,
    readonly field: "title" | "description",
    readonly current: unknown,
  ) {
    super(message);
  }
}

/**
 * Rejects a write whose expected values no longer match what is stored.
 *
 * Callers send an expected value only for the fields they are actually changing, so an
 * untouched field can never manufacture a conflict.
 */
export function requireUnchangedContent(
  stored: { title: string; description: string },
  input: { expectedTitle?: string; expectedDescription?: string },
  current: unknown,
  noun: "page" | "idea" | "chapter",
): void {
  // Expectations arrive trimmed by the request schema, while a body hand-edited on disk may
  // carry margins the schema never saw. Comparing trimmed to trimmed keeps the check about
  // what the words are rather than their whitespace - otherwise a page with a padded body
  // would refuse every rewrite forever, because no trimmed expectation could ever match it.
  if (input.expectedTitle !== undefined && stored.title.trim() !== input.expectedTitle.trim()) {
    throw new EditConflictError(`This ${noun}'s title changed while you were editing it`, "title", current);
  }
  if (
    input.expectedDescription !== undefined &&
    stored.description.trim() !== input.expectedDescription.trim()
  ) {
    throw new EditConflictError("These notes changed while you were writing", "description", current);
  }
}

function requireProjectCategory(database: DatabaseSync, projectId: string, slug: string): void {
  if (!row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    throw new PageDependencyError("This category is not part of the project", 400);
  }
}

function requireProjectChapter(
  database: DatabaseSync,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
): void {
  const project = projectById(database, projectId);
  if (!project || !chapterStore.get(String(project.slug), slug)) {
    throw new PageDependencyError("This chapter is not part of the project", 400);
  }
}

/** A chapter may have neither date, either one, or both - but never an end before its start. */
function requireCoherentDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new PageDependencyError("A chapter cannot end before it starts", 400);
  }
}

export function publicChapter(database: DatabaseSync, value: StoredChapter, members: Member[]): Chapter {
  const currentCreator = members.find(
    (member) => member.email.toLowerCase() === value.createdBy.toLowerCase(),
  );
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  return {
    slug: value.slug,
    name: value.name,
    description: value.description,
    state: value.state,
    position: value.position,
    startsOn: value.startsOn,
    endsOn: value.endsOn,
    createdById: historicalCreator ? String(historicalCreator.id) : "",
    createdByName: historicalCreator ? String(historicalCreator.name) : value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt,
    carriedPages: value.carriedPages,
    carriedEstimate: value.carriedEstimate,
    carriedTo: value.carriedTo,
    deliveredPages: value.deliveredPages,
    deliveredEstimate: value.deliveredEstimate,
  };
}

function validateDependencyGraph(pages: StoredPage[]): void {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  for (const page of pages) {
    if (new Set(page.blockedBy).size !== page.blockedBy.length) {
      throw new PageDependencyError("A blocking page can only be linked once");
    }
    for (const dependencyId of page.blockedBy) {
      if (dependencyId === page.id) throw new PageDependencyError("A page cannot block itself");
      if (!pagesById.has(dependencyId)) throw new PageDependencyError("A blocking page could not be found");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pageId: string) => {
    if (visiting.has(pageId)) throw new PageDependencyError("Page dependencies cannot form a cycle");
    if (visited.has(pageId)) return;
    visiting.add(pageId);
    for (const dependencyId of pagesById.get(pageId)?.blockedBy ?? []) visit(dependencyId);
    visiting.delete(pageId);
    visited.add(pageId);
  };
  for (const page of pages) visit(page.id);
}

/* ---------- GitHub links ---------- */

export type ProjectGithubConfig = { repo: string; token: string };

export function projectGithubConfig(database: DatabaseSync, projectId: string): ProjectGithubConfig {
  const project = row(database, "SELECT github_repo, github_token FROM projects WHERE id = ?", projectId);
  return { repo: String(project?.github_repo ?? ""), token: String(project?.github_token ?? "") };
}

/**
 * Points a project at its repository. The token is written only when the caller sends one,
 * so saving the repo never wipes a credential the form deliberately left blank; an empty
 * string sent explicitly clears it.
 */
export function setProjectGithub(
  database: DatabaseSync,
  projectId: string,
  input: { repo?: string; token?: string },
): void {
  const now = new Date().toISOString();
  // Archived projects refuse every browser, and their settings hold still with them.
  if (input.repo !== undefined) {
    database
      .prepare("UPDATE projects SET github_repo = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.repo, now, projectId);
  }
  if (input.token !== undefined) {
    database
      .prepare("UPDATE projects SET github_token = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.token, now, projectId);
  }
}

export function githubStatusesForProject(
  database: DatabaseSync,
  projectId: string,
): Map<string, PageGithubStatus> {
  const statuses = rows(
    database,
    "SELECT page_id, state, pr_number, pr_title, pr_url, checked_at FROM github_link_status WHERE project_id = ?",
    projectId,
  );
  return new Map(
    statuses.map((value) => [
      String(value.page_id),
      {
        state: String(value.state) as PageGithubStatus["state"],
        prNumber: value.pr_number === null ? null : Number(value.pr_number),
        prTitle: value.pr_title === null ? null : String(value.pr_title),
        prUrl: value.pr_url === null ? null : String(value.pr_url),
        checkedAt: value.checked_at === null ? null : String(value.checked_at),
      },
    ]),
  );
}

export function saveGithubStatus(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  status: PageGithubStatus,
): void {
  database
    .prepare(
      `INSERT INTO github_link_status (project_id, page_id, state, pr_number, pr_title, pr_url, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE
       SET state = excluded.state, pr_number = excluded.pr_number, pr_title = excluded.pr_title,
           pr_url = excluded.pr_url, checked_at = excluded.checked_at`,
    )
    .run(projectId, pageId, status.state, status.prNumber, status.prTitle, status.prUrl, status.checkedAt);
}

/** A link that is gone needs no cached answer about it. */
export function clearGithubStatus(database: DatabaseSync, projectId: string, pageId: string): void {
  database
    .prepare("DELETE FROM github_link_status WHERE project_id = ? AND page_id = ?")
    .run(projectId, pageId);
}

/* ---------- closing a chapter, and what it leaves behind ---------- */

export type ChapterCloseResult =
  | { chapter: Chapter; carried: { pages: number; estimate: number; to: string | null } }
  | "not_found"
  | "already_closed"
  | "no_target";

/**
 * Closes a chapter and decides what happens to the work it did not finish.
 *
 * What is recorded is counted here rather than derived later: once the pages belong to the
 * next chapter, nothing about them still says they were carried out of this one.
 *
 * The chapter record is written before any page moves, and the writes share no
 * transaction - the filesystem has none to offer. An interruption therefore leaves a
 * correctly closed chapter whose carried pages have not all traveled yet; they sit in the
 * closed chapter, which is a state the board already supports, and `carriedTo` says where
 * each was headed. The other order could under-count what a finished stretch carried,
 * and a recorded total that lies is the worse leftover.
 *
 * `carryTo` names where unfinished work goes - another chapter, or null to set it loose.
 * Only unfinished pages move; a page finished inside this chapter stays in it, which is what
 * makes the delivered total mean what it says.
 */
export function closeChapter(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  projectId: string,
  slug: string,
  carryTo: string | null | undefined,
): ChapterCloseResult {
  const project = projectById(database, projectId);
  if (!project) return "not_found";
  const projectSlug = String(project.slug);
  const chapters = chapterStore.list(projectSlug);
  const chapter = chapters.find((candidate) => candidate.slug === slug);
  if (!chapter) return "not_found";
  if (chapter.state === "closed") return "already_closed";
  if (carryTo && !chapters.some((candidate) => candidate.slug === carryTo && candidate.slug !== slug)) {
    return "no_target";
  }

  const pages = pageStore.list(projectSlug);
  const mine = pages.filter((page) => page.chapter === slug);
  const unfinished = mine.filter((page) => page.status !== "done");
  const delivered = mine.filter((page) => page.status === "done");
  const total = (group: StoredPage[]) => group.reduce((sum, page) => sum + (page.estimate ?? 0), 0);
  const carriedEstimate = total(unfinished);
  const now = new Date().toISOString();

  const closed: StoredChapter = {
    ...chapter,
    state: "closed",
    updatedAt: now,
    closedAt: now,
    carriedPages: unfinished.length,
    carriedEstimate,
    carriedTo: carryTo ?? null,
    // Both readings of what it delivered, counted now rather than recomputed later: pages
    // archived or re-placed after the fact must not rewrite a finished stretch's record.
    deliveredPages: delivered.length,
    deliveredEstimate: total(delivered),
  };
  chapterStore.save(projectSlug, closed);

  // Rollover is only a move when somewhere was named; "leave them here" closes over work
  // that keeps belonging to the chapter it was not finished in, which is also a fact worth
  // recording rather than a nothing.
  if (carryTo !== undefined) {
    for (const page of unfinished) {
      pageStore.save(projectSlug, { ...page, chapter: carryTo, updatedAt: now });
    }
  }
  return {
    chapter: publicChapter(database, closed, membersForProject(database, projectId)),
    carried: { pages: unfinished.length, estimate: carriedEstimate, to: carryTo ?? null },
  };
}

/** The chapter a rollover would reach for: the next planned one in reading order. */
export function nextChapterAfter(
  chapterStore: MarkdownChapterStore,
  projectSlug: string,
  slug: string,
): string | null {
  const planned = chapterStore
    .list(projectSlug)
    .filter((chapter) => chapter.state === "planned" && chapter.slug !== slug);
  return planned[0]?.slug ?? null;
}

export function setEstimatesEnabled(database: DatabaseSync, projectId: string, enabled: boolean): boolean {
  const result = database
    .prepare("UPDATE projects SET estimates_enabled = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(enabled ? 1 : 0, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export function estimatesEnabled(database: DatabaseSync, projectId: string): boolean {
  // Asked for directly rather than through projectById, which selects only the project's
  // identity: a gate read through it was always answered "off" whatever the column said.
  const project = row(database, "SELECT estimates_enabled FROM projects WHERE id = ?", projectId);
  return Number(project?.estimates_enabled ?? 0) === 1;
}

/* ---------- where a recap goes ---------- */

export type RecapConfig = { webhook: string; onClose: boolean };

export function projectRecapConfig(database: DatabaseSync, projectId: string): RecapConfig {
  const project = row(
    database,
    "SELECT discord_webhook, recap_on_close FROM projects WHERE id = ?",
    projectId,
  );
  return {
    webhook: String(project?.discord_webhook ?? ""),
    onClose: Number(project?.recap_on_close ?? 1) === 1,
  };
}

/** Written only for what the caller actually sent, so saving one never clears the other. */
export function setProjectRecap(
  database: DatabaseSync,
  projectId: string,
  input: { webhook?: string; onClose?: boolean },
): void {
  const now = new Date().toISOString();
  // The same stillness the other settings keep: an archived project cannot be reconfigured.
  if (input.webhook !== undefined) {
    database
      .prepare("UPDATE projects SET discord_webhook = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.webhook, now, projectId);
  }
  if (input.onClose !== undefined) {
    database
      .prepare("UPDATE projects SET recap_on_close = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(input.onClose ? 1 : 0, now, projectId);
  }
}
