import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { IDEA_STATES, type IdeaState } from "../shared/types";
import { isTimestamp, parseMarkdown, serializeMarkdown, writeAtomic } from "./markdown-files";

export type StoredIdea = {
  id: string;
  title: string;
  description: string;
  state: IdeaState;
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  promotedTo: string | null;
  promotedAt: string | null;
};

const metadataSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(240),
    state: z.enum(IDEA_STATES),
    position: z.number().int().min(0),
    created_by: z.string().email(),
    created_at: z.string().refine(isTimestamp, "created_at must be an ISO timestamp"),
    updated_at: z.string().refine(isTimestamp, "updated_at must be an ISO timestamp"),
    promoted_to: z.string().uuid().nullable().optional(),
    promoted_at: z.string().refine(isTimestamp, "promoted_at must be an ISO timestamp").nullable().optional(),
  })
  .strict();

export class MarkdownIdeaStore {
  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  list(projectSlug: string): StoredIdea[] {
    const directory = this.activeDirectory(projectSlug);
    mkdirSync(directory, { recursive: true });
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
      .map((entry) => this.readPath(join(directory, entry.name)))
      .sort(compareIdeas);
  }

  get(projectSlug: string, ideaId: string): StoredIdea | null {
    const path = this.activePath(projectSlug, ideaId);
    return existsSync(path) ? this.readPath(path) : null;
  }

  getArchived(projectSlug: string, ideaId: string): StoredIdea | null {
    const path = this.archivePath(projectSlug, ideaId);
    return existsSync(path) ? this.readPath(path) : null;
  }

  save(projectSlug: string, idea: StoredIdea): void {
    writeAtomic(this.activePath(projectSlug, idea.id), serializeIdea(idea));
  }

  /*
   * Destination first, source removed second - the same interruption story the page
   * store tells: a crash leaves the record twice, never half-written.
   */
  archive(projectSlug: string, idea: StoredIdea): void {
    const activePath = this.activePath(projectSlug, idea.id);
    if (!existsSync(activePath)) throw new Error(`Idea file does not exist: ${activePath}`);
    mkdirSync(this.archiveDirectory(projectSlug), { recursive: true });
    writeAtomic(this.archivePath(projectSlug, idea.id), serializeIdea(idea));
    unlinkSync(activePath);
  }

  restore(projectSlug: string, idea: StoredIdea): void {
    const archivePath = this.archivePath(projectSlug, idea.id);
    if (!existsSync(archivePath)) throw new Error(`Archived idea file does not exist: ${archivePath}`);
    mkdirSync(this.activeDirectory(projectSlug), { recursive: true });
    writeAtomic(this.activePath(projectSlug, idea.id), serializeIdea(idea));
    unlinkSync(archivePath);
  }

  private readPath(path: string): StoredIdea {
    try {
      const parsed = parseMarkdown(readFileSync(path, "utf8"));
      const metadata = metadataSchema.parse(parsed.metadata);
      if (basename(path, ".md") !== metadata.id) throw new Error("Filename must match the idea id");
      return {
        id: metadata.id,
        title: metadata.title,
        description: parsed.body,
        state: metadata.state,
        position: metadata.position,
        createdBy: metadata.created_by.toLowerCase(),
        createdAt: metadata.created_at,
        updatedAt: metadata.updated_at,
        promotedTo: metadata.promoted_to ?? null,
        promotedAt: metadata.promoted_at ?? null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid idea file ${path}: ${reason}`);
    }
  }

  private activeDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "ideas");
  }

  private archiveDirectory(projectSlug: string): string {
    return join(this.activeDirectory(projectSlug), "archive");
  }

  private archivePath(projectSlug: string, ideaId: string): string {
    return join(this.archiveDirectory(projectSlug), `${ideaId}.md`);
  }

  private activePath(projectSlug: string, ideaId: string): string {
    return join(this.activeDirectory(projectSlug), `${ideaId}.md`);
  }

  private projectDirectory(projectSlug: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectSlug))
      throw new Error(`Invalid project slug: ${projectSlug}`);
    return join(this.rootDirectory, projectSlug);
  }
}

function serializeIdea(idea: StoredIdea): string {
  const metadata: Array<[string, string | number | null]> = [
    ["id", idea.id],
    ["title", idea.title],
    ["state", idea.state],
    ["position", idea.position],
    ["created_by", idea.createdBy],
    ["created_at", idea.createdAt],
    ["updated_at", idea.updatedAt],
  ];
  if (idea.promotedTo !== null) metadata.push(["promoted_to", idea.promotedTo]);
  if (idea.promotedAt !== null) metadata.push(["promoted_at", idea.promotedAt]);
  return serializeMarkdown(metadata, idea.description);
}

function compareIdeas(left: StoredIdea, right: StoredIdea): number {
  const state = IDEA_STATES.indexOf(left.state) - IDEA_STATES.indexOf(right.state);
  if (state !== 0) return state;
  if (left.position !== right.position) return left.position - right.position;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}
