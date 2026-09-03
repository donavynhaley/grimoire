import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  PAGE_STATUSES,
  type PageCategory,
  type PageFields,
  type PageGithubLink,
  type PageStatus,
} from "../shared/types";
import { withTransaction } from "./database";
import {
  compareRecords,
  type FrontmatterValue,
  isTimestamp,
  markdownFilesIn,
  moveRecord,
  parseMarkdown,
  projectDirectory,
  serializeMarkdown,
  writeAtomic,
} from "./markdown-files";

export type StoredPage = {
  id: string;
  title: string;
  description: string;
  category: PageCategory | null;
  chapter: string | null;
  fields: PageFields;
  blockedBy: string[];
  unblockedPages: string[];
  status: PageStatus;
  position: number;
  assignee: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  github: PageGithubLink | null;
  estimate: number | null;
};

type LegacyPageRow = Record<string, string | number | null>;

const metadataSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(240),
    category: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(40)
      .nullable()
      .optional(),
    chapter: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(60)
      .nullable()
      .optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    blocked_by: z.array(z.string().uuid()).optional(),
    unblocked_cards: z.array(z.string().uuid()).optional(),
    status: z.enum(PAGE_STATUSES),
    position: z.number().int().min(0),
    assignee: z.string().email().nullable(),
    created_by: z.string().email(),
    created_at: z.string().refine(isTimestamp, "created_at must be an ISO timestamp"),
    updated_at: z.string().refine(isTimestamp, "updated_at must be an ISO timestamp"),
    completed_at: z
      .string()
      .refine(isTimestamp, "completed_at must be an ISO timestamp")
      .nullable()
      .optional(),
    archived_at: z.string().refine(isTimestamp, "archived_at must be an ISO timestamp").nullable().optional(),
    estimate: z.number().int().min(0).max(100_000).nullable().optional(),
    github: z
      .union([
        z.object({ kind: z.literal("pr"), number: z.number().int().min(1), repo: z.string().optional() }),
        z.object({
          kind: z.literal("branch"),
          name: z.string().min(1).max(200),
          repo: z.string().optional(),
        }),
      ])
      .nullable()
      .optional(),
  })
  .strict();

export class MarkdownPageStore {
  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  list(projectSlug: string): StoredPage[] {
    const directory = this.activeDirectory(projectSlug);
    mkdirSync(directory, { recursive: true });
    return markdownFilesIn(directory)
      .map((path) => this.readPath(path))
      .filter((page) => page.archivedAt === null)
      .sort(comparePages);
  }

  get(projectSlug: string, pageId: string): StoredPage | null {
    const path = this.activePath(projectSlug, pageId);
    return existsSync(path) ? this.readPath(path) : null;
  }

  getArchived(projectSlug: string, pageId: string): StoredPage | null {
    const path = this.archivePath(projectSlug, pageId);
    return existsSync(path) ? this.readPath(path) : null;
  }

  /** Archived pages are unreachable from the board, so search is the only way back to them. */
  listArchived(projectSlug: string): StoredPage[] {
    const directory = this.archiveDirectory(projectSlug);
    if (!existsSync(directory)) return [];
    return markdownFilesIn(directory)
      .map((path) => this.readPath(path))
      .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
  }

  save(projectSlug: string, page: StoredPage): void {
    if (page.archivedAt !== null) throw new Error("Active pages cannot have an archived_at value");
    if (page.unblockedPages.length > 0) throw new Error("Active pages cannot have unblocked_cards values");
    writeAtomic(this.activePath(projectSlug, page.id), serializePage(page));
  }

  archive(projectSlug: string, page: StoredPage): void {
    const activePath = this.activePath(projectSlug, page.id);
    if (!existsSync(activePath)) throw new Error(`Page file does not exist: ${activePath}`);
    moveRecord(activePath, this.archivePath(projectSlug, page.id), serializePage(page));
  }

  restore(projectSlug: string, page: StoredPage): void {
    const archivePath = this.archivePath(projectSlug, page.id);
    if (!existsSync(archivePath)) throw new Error(`Archived page file does not exist: ${archivePath}`);
    moveRecord(
      archivePath,
      this.activePath(projectSlug, page.id),
      serializePage({ ...page, archivedAt: null }),
    );
  }

  remove(projectSlug: string, pageId: string): void {
    const path = this.activePath(projectSlug, pageId);
    if (!existsSync(path)) throw new Error(`Page file does not exist: ${path}`);
    unlinkSync(path);
  }

  migrateLegacyPages(database: DatabaseSync): number {
    const legacyPages = database
      .prepare(
        `SELECT cards.*, projects.slug AS project_slug,
          assignee.email AS assignee_email, creator.email AS creator_email
         FROM cards
         JOIN projects ON projects.id = cards.project_id
         LEFT JOIN users assignee ON assignee.id = cards.assignee_id
         JOIN users creator ON creator.id = cards.created_by
         ORDER BY cards.created_at`,
      )
      .all() as LegacyPageRow[];
    if (legacyPages.length === 0) return 0;

    for (const row of legacyPages) {
      const page = legacyRowToPage(row);
      const projectSlug = String(row.project_slug);
      const path = page.archivedAt
        ? join(this.archiveDirectory(projectSlug), `${page.id}.md`)
        : this.activePath(projectSlug, page.id);
      if (existsSync(path)) {
        const existing = this.readPath(path);
        if (existing.id !== page.id) throw new Error(`Legacy migration conflicts with ${path}`);
        if (page.archivedAt && !existing.archivedAt) {
          writeAtomic(path, serializePage({ ...existing, archivedAt: page.archivedAt }));
        }
        continue;
      }
      writeAtomic(path, serializePage(page));
    }

    withTransaction(database, () => {
      const remove = database.prepare("DELETE FROM cards WHERE id = ?");
      for (const row of legacyPages) remove.run(String(row.id));
    });
    return legacyPages.length;
  }

  private readPath(path: string): StoredPage {
    try {
      const page = parsePage(readFileSync(path, "utf8"));
      if (basename(path, ".md") !== page.id) throw new Error("Filename must match the page id");
      return page;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid page file ${path}: ${reason}`);
    }
  }

  /**
   * Moves a project's `cards/` directory to `pages/`, once.
   *
   * The rename is one atomic operation inside a single project directory, and it is skipped
   * entirely when `pages/` already exists, so running it on every start is safe. Only the
   * active directory moves: `archive/`, `ideas/`, `chapters/`, and `images/` were never named
   * after the entity. Reversing a deployment means renaming this back, which
   * `ops/rename-pages-to-cards.mjs` does.
   */
  migrateLegacyDirectory(projectSlug: string): boolean {
    const pages = this.activeDirectory(projectSlug);
    if (existsSync(pages)) return false;
    const legacy = join(this.projectDirectory(projectSlug), "cards");
    if (!existsSync(legacy)) return false;
    renameSync(legacy, pages);
    return true;
  }

  private activeDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "pages");
  }

  private archiveDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "archive");
  }

  private archivePath(projectSlug: string, pageId: string): string {
    return join(this.archiveDirectory(projectSlug), `${pageId}.md`);
  }

  private activePath(projectSlug: string, pageId: string): string {
    return join(this.activeDirectory(projectSlug), `${pageId}.md`);
  }

  private projectDirectory(projectSlug: string): string {
    return projectDirectory(this.rootDirectory, projectSlug);
  }
}

function parsePage(markdown: string): StoredPage {
  const parsed = parseMarkdown(markdown);
  const metadata = metadataSchema.parse(parsed.metadata);
  return {
    id: metadata.id,
    title: metadata.title,
    description: parsed.body,
    category: metadata.category ?? null,
    chapter: metadata.chapter ?? null,
    fields: metadata.fields ?? {},
    blockedBy: metadata.blocked_by ?? [],
    unblockedPages: metadata.unblocked_cards ?? [],
    status: metadata.status,
    position: metadata.position,
    assignee: metadata.assignee?.toLowerCase() ?? null,
    createdBy: metadata.created_by.toLowerCase(),
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    completedAt: metadata.completed_at ?? (metadata.status === "done" ? metadata.updated_at : null),
    archivedAt: metadata.archived_at ?? null,
    github: metadata.github ?? null,
    estimate: metadata.estimate ?? null,
  };
}

/**
 * Field order is written out explicitly rather than patched by index.
 *
 * `chapter` is emitted only when the page actually belongs to one. A project that never
 * turns chapters on keeps byte-identical files, and a deployment rolled back to a build
 * that predates chapters only has to answer for the pages someone deliberately placed -
 * every other file still parses under the older strict schema. `docs/architecture.md`
 * records the rest of that compatibility contract.
 *
 * `fields` follows the same rule for the same reason, and an empty record counts as absent:
 * a project that defines no fields, or a page nobody filled one in on, writes nothing.
 */
function serializePage(page: StoredPage): string {
  const metadata: Array<[string, FrontmatterValue]> = [
    ["id", page.id],
    ["title", page.title],
    ["category", page.category],
  ];
  if (page.chapter !== null) metadata.push(["chapter", page.chapter]);
  if (Object.keys(page.fields).length > 0) metadata.push(["fields", page.fields]);
  metadata.push(["blocked_by", page.blockedBy]);
  if (page.unblockedPages.length > 0) metadata.push(["unblocked_cards", page.unblockedPages]);
  metadata.push(
    ["status", page.status],
    ["position", page.position],
    ["assignee", page.assignee],
    ["created_by", page.createdBy],
    ["created_at", page.createdAt],
    ["updated_at", page.updatedAt],
    ["completed_at", page.completedAt],
  );
  if (page.estimate !== null) {
    // The scalar parser reads whole numbers only, so a decimal written here is a page file this
    // store can no longer load, and one such file fails the whole project. Refusing at the write
    // keeps that guarantee even if a route schema upstream lets the value through.
    if (!Number.isInteger(page.estimate)) {
      throw new Error(
        `Page ${page.id} has an estimate of ${page.estimate}; only a whole number can be read back`,
      );
    }
    metadata.push(["estimate", page.estimate]);
  }
  if (page.github !== null) metadata.push(["github", page.github as unknown as FrontmatterValue]);
  if (page.archivedAt !== null) metadata.push(["archived_at", page.archivedAt]);
  return serializeMarkdown(metadata, page.description);
}

function legacyRowToPage(row: LegacyPageRow): StoredPage {
  return {
    github: null,
    estimate: null,
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    category: null,
    chapter: null,
    fields: {},
    blockedBy: [],
    unblockedPages: [],
    status: row.status as PageStatus,
    position: Number(row.position),
    assignee: row.assignee_email ? String(row.assignee_email).toLowerCase() : null,
    createdBy: String(row.creator_email).toLowerCase(),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.status === "done" ? String(row.updated_at) : null,
    archivedAt: row.archived_at ? String(row.archived_at) : null,
  };
}

const comparePages = compareRecords<StoredPage>((page) => PAGE_STATUSES.indexOf(page.status));
