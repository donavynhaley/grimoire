import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { CHAPTER_STATES, type ChapterState } from "../shared/types";
import {
  isTimestamp,
  markdownFilesIn,
  parseMarkdown,
  projectDirectory,
  serializeMarkdown,
  writeAtomic,
} from "./markdown-files";

export type StoredChapter = {
  slug: string;
  name: string;
  description: string;
  state: ChapterState;
  position: number;
  startsOn: string | null;
  endsOn: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  carriedPages: number | null;
  carriedEstimate: number | null;
  carriedTo: string | null;
  deliveredPages: number | null;
  deliveredEstimate: number | null;
};

/** A plain calendar day. A chapter boundary is a day the team named, not an instant. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const metadataSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(60),
    name: z.string().trim().min(1).max(80),
    state: z.enum(CHAPTER_STATES),
    position: z.number().int().min(0),
    starts_on: z.string().refine(isCalendarDay, "starts_on must be a YYYY-MM-DD day").nullable().optional(),
    ends_on: z.string().refine(isCalendarDay, "ends_on must be a YYYY-MM-DD day").nullable().optional(),
    created_by: z.string().email(),
    created_at: z.string().refine(isTimestamp, "created_at must be an ISO timestamp"),
    updated_at: z.string().refine(isTimestamp, "updated_at must be an ISO timestamp"),
    closed_at: z.string().refine(isTimestamp, "closed_at must be an ISO timestamp").nullable().optional(),
    carried_pages: z.number().int().min(0).nullable().optional(),
    carried_estimate: z.number().finite().min(0).nullable().optional(),
    carried_to: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(60)
      .nullable()
      .optional(),
    delivered_pages: z.number().int().min(0).nullable().optional(),
    delivered_estimate: z.number().finite().min(0).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => !value.starts_on || !value.ends_on || value.ends_on >= value.starts_on,
    "ends_on cannot fall before starts_on",
  );

/**
 * Chapters live in the project directory rather than in SQLite.
 *
 * A chapter is domain data about the work - it has a name, a time frame, and a body saying
 * what the stretch is for - so it belongs with the pages it describes. Copying a project
 * directory therefore carries the work and the chapters it was done in.
 *
 * Files are named by slug rather than by UUID. A page title changes constantly, which is why
 * pages use UUID filenames, but a chapter's slug is fixed at creation and survives renames,
 * and there are few enough of them that a readable directory listing is worth more.
 */
export class MarkdownChapterStore {
  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  list(projectSlug: string): StoredChapter[] {
    const directory = this.chaptersDirectory(projectSlug);
    if (!existsSync(directory)) return [];
    return markdownFilesIn(directory)
      .map((path) => this.readPath(path))
      .sort(compareChapters);
  }

  get(projectSlug: string, slug: string): StoredChapter | null {
    const path = this.chapterPath(projectSlug, slug);
    return existsSync(path) ? this.readPath(path) : null;
  }

  save(projectSlug: string, chapter: StoredChapter): void {
    writeAtomic(this.chapterPath(projectSlug, chapter.slug), serializeChapter(chapter));
  }

  remove(projectSlug: string, slug: string): void {
    const path = this.chapterPath(projectSlug, slug);
    if (!existsSync(path)) throw new Error(`Chapter file does not exist: ${path}`);
    unlinkSync(path);
  }

  private readPath(path: string): StoredChapter {
    try {
      const parsed = parseMarkdown(readFileSync(path, "utf8"));
      const metadata = metadataSchema.parse(parsed.metadata);
      if (basename(path, ".md") !== metadata.slug) throw new Error("Filename must match the chapter slug");
      return {
        slug: metadata.slug,
        name: metadata.name,
        description: parsed.body,
        state: metadata.state,
        position: metadata.position,
        startsOn: metadata.starts_on ?? null,
        endsOn: metadata.ends_on ?? null,
        createdBy: metadata.created_by.toLowerCase(),
        createdAt: metadata.created_at,
        updatedAt: metadata.updated_at,
        closedAt: metadata.closed_at ?? null,
        carriedPages: metadata.carried_pages ?? null,
        carriedEstimate: metadata.carried_estimate ?? null,
        carriedTo: metadata.carried_to ?? null,
        deliveredPages: metadata.delivered_pages ?? null,
        deliveredEstimate: metadata.delivered_estimate ?? null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid chapter file ${path}: ${reason}`);
    }
  }

  private chaptersDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "chapters");
  }

  private chapterPath(projectSlug: string, slug: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`Invalid chapter slug: ${slug}`);
    return join(this.chaptersDirectory(projectSlug), `${slug}.md`);
  }

  private projectDirectory(projectSlug: string): string {
    return projectDirectory(this.rootDirectory, projectSlug);
  }
}

function serializeChapter(chapter: StoredChapter): string {
  const metadata: Array<[string, string | number | null]> = [
    ["slug", chapter.slug],
    ["name", chapter.name],
    ["state", chapter.state],
    ["position", chapter.position],
    ["starts_on", chapter.startsOn],
    ["ends_on", chapter.endsOn],
    ["created_by", chapter.createdBy],
    ["created_at", chapter.createdAt],
    ["updated_at", chapter.updatedAt],
    ["closed_at", chapter.closedAt],
  ];
  // Written only by a chapter that actually closed over unfinished work, so every other
  // chapter file stays byte-identical to the ones already on disk.
  if (chapter.carriedPages !== null) metadata.push(["carried_pages", chapter.carriedPages]);
  if (chapter.carriedEstimate !== null) metadata.push(["carried_estimate", chapter.carriedEstimate]);
  if (chapter.carriedTo !== null) metadata.push(["carried_to", chapter.carriedTo]);
  if (chapter.deliveredPages !== null) metadata.push(["delivered_pages", chapter.deliveredPages]);
  if (chapter.deliveredEstimate !== null) metadata.push(["delivered_estimate", chapter.deliveredEstimate]);
  return serializeMarkdown(metadata, chapter.description);
}

/**
 * Newest first, which is the order the board's chapter picker reads in.
 *
 * The open chapter leads because it is what the team is in; planned chapters follow because
 * they are what comes next; closed ones trail in reverse order of ending. Manual `position`
 * breaks ties inside a state, and creation time and slug settle the rest so that an
 * interrupted external edit can never produce an unstable order.
 */
const READING_ORDER: Record<ChapterState, number> = { open: 0, planned: 1, closed: 2 };

function compareChapters(left: StoredChapter, right: StoredChapter): number {
  const state = READING_ORDER[left.state] - READING_ORDER[right.state];
  if (state !== 0) return state;
  if (left.state === "closed") {
    const closed = (right.closedAt ?? "").localeCompare(left.closedAt ?? "");
    if (closed !== 0) return closed;
  }
  if (left.position !== right.position) return left.position - right.position;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created !== 0 ? created : left.slug.localeCompare(right.slug);
}
