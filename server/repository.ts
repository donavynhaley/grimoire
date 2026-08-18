import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fieldHasOptions,
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
  type UserRole,
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
    role: value.role as User["role"],
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

export function defaultProjectIdForUser(database: DatabaseSync, user: User): string | null {
  const value =
    user.role === "owner"
      ? row(database, "SELECT id AS project_id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1")
      : row(
        database,
        `SELECT project_members.project_id FROM project_members
         JOIN projects ON projects.id = project_members.project_id
         WHERE project_members.user_id = ? AND projects.archived_at IS NULL
         ORDER BY project_members.created_at LIMIT 1`,
        user.id,
      );
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
export function initializeSeenCursor(database: DatabaseSync, projectId: string, userId: string, sequence: number): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}

/** Advances with MAX semantics, so stale tabs and repeats can never rewind the boundary. */
export function advanceSeenCursor(database: DatabaseSync, projectId: string, userId: string, sequence: number): void {
  database
    .prepare(
      `INSERT INTO seen_cursors (project_id, user_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         last_seen_sequence = MAX(last_seen_sequence, excluded.last_seen_sequence),
         updated_at = excluded.updated_at`,
    )
    .run(projectId, userId, sequence, new Date().toISOString());
}

export function userCanAccessProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "owner") {
    return Boolean(row(database, "SELECT 1 AS ok FROM projects WHERE id = ? AND archived_at IS NULL", projectId));
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

export function listProjectsForUser(database: DatabaseSync, user: User): ProjectSummary[] {
  const values =
    user.role === "owner"
      ? rows(database, "SELECT id, name, description FROM projects WHERE archived_at IS NULL ORDER BY created_at")
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

export function setProjectDescription(database: DatabaseSync, projectId: string, description: string): boolean {
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
export function listArchivedProjects(database: DatabaseSync): ArchivedProject[] {
  return rows(
    database,
    "SELECT id, name, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
  ).map((value) => ({
    id: String(value.id),
    name: String(value.name),
    archivedAt: String(value.archived_at),
  }));
}

/** Clears `archived_at`, which is all archiving ever set - the files never left the disk. */
export function restoreProject(database: DatabaseSync, projectId: string): boolean {
  const result = database
    .prepare("UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL")
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
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
    .prepare("INSERT INTO categories (project_id, slug, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
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
  const removed = database
    .prepare("DELETE FROM categories WHERE project_id = ? AND slug = ?")
    .run(projectId, slug);
  if (Number(removed.changes) !== 1) return false;
  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.category !== slug) return;
    pageStore.save(String(project.slug), { ...page, category: null, updatedAt: now });
  });
  return true;
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
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
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
    .run(projectId, key, input.label, input.type, JSON.stringify(options), position, showOnTile ? 1 : 0, new Date().toISOString());
  return { field: { key, label: input.label, type: input.type, options, position, showOnTile } };
}

export type UpdateFieldResult = { field: ProjectField; cleared: number } | "not_found" | "needs_options";

/**
 * Edits a definition, but never its type.
 *
 * A type change would invalidate every value already stored under it, and the honest repair
 * for that is the one a person can already do: delete the field and define the one they meant.
 */
export function updateField(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  key: string,
  input: { label?: string; options?: string[]; showOnTile?: boolean; position?: number },
): UpdateFieldResult {
  const project = projectById(database, projectId);
  const current = fieldsForProject(database, projectId).find((field) => field.key === key);
  if (!project || !current) return "not_found";
  const options = input.options === undefined ? current.options : normalizeOptions(current.type, input.options);
  if (options === null) return "needs_options";

  const label = input.label ?? current.label;
  const showOnTile = input.showOnTile ?? current.showOnTile;
  const position = input.position ?? current.position;
  database
    .prepare("UPDATE project_fields SET label = ?, options = ?, show_on_tile = ?, position = ? WHERE project_id = ? AND key = ?")
    .run(label, JSON.stringify(options), showOnTile ? 1 : 0, position, projectId, key);

  // A value whose option was just withdrawn cannot stay: the next write touching that page
  // would be refused for holding something the field no longer offers, and the person
  // making that write would have had nothing to do with the withdrawal.
  const cleared = fieldHasOptions(current.type)
    ? clearFieldValues(pageStore, String(project.slug), key, (value) => typeof value === "string" && options.includes(value))
    : 0;
  return { field: { key, label, type: current.type, options, position, showOnTile }, cleared };
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
  const removed = database.prepare("DELETE FROM project_fields WHERE project_id = ? AND key = ?").run(projectId, key);
  if (Number(removed.changes) !== 1) return null;
  return clearFieldValues(pageStore, String(project.slug), key, () => false);
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
  return chapterStore
    .list(String(project.slug))
    .map((chapter) => publicChapter(database, chapter, members));
}

export function chapterSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
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
    closedAt: nextState === "closed" ? current.closedAt ?? now : null,
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
  chapterStore.remove(projectSlug, slug);
  const now = new Date().toISOString();
  pageStore.list(projectSlug).forEach((page) => {
    if (page.chapter !== slug) return;
    pageStore.save(projectSlug, { ...page, chapter: null, updatedAt: now });
  });
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
    "SELECT id, name, slug, description, chapters_enabled FROM projects WHERE id = ?",
    projectId,
  );
  if (!project) return null;

  const members = membersForProject(database, projectId);
  const pages = pageStore.list(String(project.slug));
  validateDependencyGraph(pages);
  const enabled = Number(project.chapters_enabled ?? 0) === 1;

  return {
    project: {
      id: String(project.id),
      name: String(project.name),
      description: String(project.description ?? ""),
      chaptersEnabled: enabled,
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
    members,
    pages: pages.map((page) => publicPage(database, page, members)),
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
  return stored ? publicPage(database, stored, membersForProject(database, projectId)) : null;
}

export function listPages(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
): Page[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  return pageStore.list(String(project.slug)).map((page) => publicPage(database, page, members));
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
  };
  validateDependencyGraph([...pages, page]);
  pageStore.save(String(project.slug), page);
  return publicPage(database, page, members);
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
  requireUnchangedContent(current, input, publicPage(database, current, members), "page");
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (input.assigneeId && !assignee) return null;
  if (input.category) requireProjectCategory(database, projectId, input.category);
  if (input.chapter) requireProjectChapter(database, chapterStore, projectId, input.chapter);

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();
  const completedAt = nextStatus === "done"
    ? current.status === "done" ? current.completedAt ?? current.updatedAt : now
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
    assignee: input.assigneeId === undefined ? current.assignee : assignee?.email.toLowerCase() ?? null,
    updatedAt: now,
    completedAt,
  };
  validateDependencyGraph(pages.map((page) => page.id === pageId ? updated : page));

  if (!shouldMove) {
    pageStore.save(projectSlug, updated);
    return publicPage(database, updated, members);
  }

  for (const status of PAGE_STATUSES) {
    const ordered = pages.filter((page) => page.id !== pageId && page.status === status);
    if (status === nextStatus) {
      const requestedPosition = input.position ?? ordered.length;
      ordered.splice(Math.max(0, Math.min(requestedPosition, ordered.length)), 0, updated);
    }
    ordered.forEach((page, position) => {
      const positioned = { ...page, position };
      if (page.id === pageId || page.position !== position) pageStore.save(projectSlug, positioned);
      if (page.id === pageId) updated.position = position;
    });
  }
  return publicPage(database, updated, members);
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
  pageStore
    .list(projectSlug)
    .filter((page) => page.status === current.status)
    .forEach((page, position) => {
      if (page.position !== position) pageStore.save(projectSlug, { ...page, position });
    });
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
  const restoredPages = pages.map((page) => previouslyBlocked.has(page.id)
    ? { ...page, blockedBy: [...page.blockedBy, restored.id], updatedAt: restored.updatedAt }
    : page);
  validateDependencyGraph([...restoredPages, restored]);
  pageStore.restore(projectSlug, restored);

  restoredPages.forEach((page) => {
    const previous = pages.find((candidate) => candidate.id === page.id);
    if (previous && previous.blockedBy.length !== page.blockedBy.length) pageStore.save(projectSlug, page);
  });

  const ordered = restoredPages.filter((page) => page.status === restored.status);
  ordered.splice(Math.max(0, Math.min(restored.position, ordered.length)), 0, restored);
  ordered.forEach((page, position) => {
    if (page.position !== position) pageStore.save(projectSlug, { ...page, position });
    if (page.id === restored.id) restored.position = position;
  });
  return publicPage(database, restored, membersForProject(database, projectId));
}

export function projectById(database: DatabaseSync, projectId: string): Row | undefined {
  return row(database, "SELECT id, name, slug, description FROM projects WHERE id = ?", projectId);
}

export function membersForProject(database: DatabaseSync, projectId: string): Member[] {
  return rows(
    database,
    `SELECT users.id, users.name, users.email, users.role, project_members.role AS project_role
     FROM project_members JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? ORDER BY project_members.created_at`,
    projectId,
  ).map(
    (value): Member => ({
      ...publicUser(value),
      projectRole: value.project_role as Member["projectRole"],
    }),
  );
}

export type SetMemberRoleResult = "updated" | "not_found" | "unchanged";

/**
 * Promotes or demotes a member, after the invitation that first let them in.
 *
 * A role was fixed at registration until now, which meant a second owner could only exist by
 * editing the database by hand. Every owner gate in the product reads the account-wide role,
 * so that is what changes here, and the project membership is brought along with it: leaving
 * the two disagreeing would show someone as a member on a board they can in fact restructure.
 *
 * Every project they belong to is updated, because the power being granted is not per-project
 * either. Saying otherwise on one board and not another would be the same lie in a smaller place.
 */
export function setMemberRole(
  database: DatabaseSync,
  projectId: string,
  memberId: string,
  role: UserRole,
): SetMemberRoleResult {
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!member) return "not_found";
  if (member.role === role && member.projectRole === role) return "unchanged";

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, memberId);
    database.prepare("UPDATE project_members SET role = ? WHERE user_id = ?").run(role, memberId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return "updated";
}

export type RemoveMemberResult = "removed" | "not_found" | "owner";

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

  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.assignee?.toLowerCase() !== member.email.toLowerCase()) return;
    pageStore.save(String(project.slug), { ...page, assignee: null, updatedAt: now });
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    const removed = database
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'")
      .run(projectId, memberId);
    if (Number(removed.changes) !== 1) throw new Error("Project membership changed while it was being removed");
    database.prepare("DELETE FROM seen_cursors WHERE project_id = ? AND user_id = ?").run(projectId, memberId);
    const remaining = row(database, "SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?", memberId);
    if (Number(remaining?.count ?? 0) === 0) {
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(memberId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return "removed";
}

function publicPage(database: DatabaseSync, value: StoredPage, members: Member[]): Page {
  const assignee = value.assignee
    ? members.find((member) => member.email.toLowerCase() === value.assignee?.toLowerCase())
    : null;
  const currentCreator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  if (value.assignee && !assignee) throw new Error(`Page ${value.id} references a non-member assignee`);
  if (!historicalCreator) throw new Error(`Page ${value.id} references an unknown creator`);
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
    createdById: String(historicalCreator.id),
    createdByName: String(historicalCreator.name),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  };
}

export class PageDependencyError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
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
  if (input.expectedDescription !== undefined && stored.description.trim() !== input.expectedDescription.trim()) {
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

function publicChapter(database: DatabaseSync, value: StoredChapter, members: Member[]): Chapter {
  const currentCreator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
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
