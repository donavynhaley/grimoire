import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CARD_STATUSES, type CardStatus } from "../shared/types";

export type StoredCard = {
  id: string;
  title: string;
  description: string;
  status: CardStatus;
  position: number;
  assignee: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type LegacyCardRow = Record<string, string | number | null>;

const metadataSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(240),
    status: z.enum(CARD_STATUSES),
    position: z.number().int().min(0),
    assignee: z.string().email().nullable(),
    created_by: z.string().email(),
    created_at: z.string().refine(isTimestamp, "created_at must be an ISO timestamp"),
    updated_at: z.string().refine(isTimestamp, "updated_at must be an ISO timestamp"),
    archived_at: z.string().refine(isTimestamp, "archived_at must be an ISO timestamp").nullable().optional(),
  })
  .strict();

export class MarkdownCardStore {
  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  list(projectSlug: string): StoredCard[] {
    const directory = this.activeDirectory(projectSlug);
    mkdirSync(directory, { recursive: true });
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
      .map((entry) => this.readPath(join(directory, entry.name)))
      .filter((card) => card.archivedAt === null)
      .sort(compareCards);
  }

  get(projectSlug: string, cardId: string): StoredCard | null {
    const path = this.activePath(projectSlug, cardId);
    return existsSync(path) ? this.readPath(path) : null;
  }

  save(projectSlug: string, card: StoredCard): void {
    if (card.archivedAt !== null) throw new Error("Active cards cannot have an archived_at value");
    this.writeAtomic(this.activePath(projectSlug, card.id), serializeCard(card));
  }

  archive(projectSlug: string, card: StoredCard): void {
    const activePath = this.activePath(projectSlug, card.id);
    if (!existsSync(activePath)) throw new Error(`Card file does not exist: ${activePath}`);
    const archiveDirectory = this.archiveDirectory(projectSlug);
    mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = join(archiveDirectory, `${card.id}.md`);
    if (existsSync(archivePath)) throw new Error(`Archived card file already exists: ${archivePath}`);
    renameSync(activePath, archivePath);
    this.writeAtomic(archivePath, serializeCard(card));
  }

  migrateLegacyCards(database: DatabaseSync): number {
    const legacyCards = database
      .prepare(
        `SELECT cards.*, projects.slug AS project_slug,
          assignee.email AS assignee_email, creator.email AS creator_email
         FROM cards
         JOIN projects ON projects.id = cards.project_id
         LEFT JOIN users assignee ON assignee.id = cards.assignee_id
         JOIN users creator ON creator.id = cards.created_by
         ORDER BY cards.created_at`,
      )
      .all() as LegacyCardRow[];
    if (legacyCards.length === 0) return 0;

    for (const row of legacyCards) {
      const card = legacyRowToCard(row);
      const projectSlug = String(row.project_slug);
      const path = card.archivedAt
        ? join(this.archiveDirectory(projectSlug), `${card.id}.md`)
        : this.activePath(projectSlug, card.id);
      if (existsSync(path)) {
        const existing = this.readPath(path);
        if (existing.id !== card.id) throw new Error(`Legacy migration conflicts with ${path}`);
        if (card.archivedAt && !existing.archivedAt) {
          this.writeAtomic(path, serializeCard({ ...existing, archivedAt: card.archivedAt }));
        }
        continue;
      }
      this.writeAtomic(path, serializeCard(card));
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const remove = database.prepare("DELETE FROM cards WHERE id = ?");
      for (const row of legacyCards) remove.run(String(row.id));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return legacyCards.length;
  }

  private readPath(path: string): StoredCard {
    try {
      const card = parseCard(readFileSync(path, "utf8"));
      if (basename(path, ".md") !== card.id) throw new Error("Filename must match the card id");
      return card;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid card file ${path}: ${reason}`);
    }
  }

  private activeDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "cards");
  }

  private archiveDirectory(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), "archive");
  }

  private activePath(projectSlug: string, cardId: string): string {
    return join(this.activeDirectory(projectSlug), `${cardId}.md`);
  }

  private projectDirectory(projectSlug: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectSlug)) throw new Error(`Invalid project slug: ${projectSlug}`);
    return join(this.rootDirectory, projectSlug);
  }

  private writeAtomic(path: string, content: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, path);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }
}

function parseCard(markdown: string): StoredCard {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Expected YAML frontmatter enclosed by --- lines");
  const rawMetadata: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (key in rawMetadata) throw new Error(`Duplicate frontmatter field: ${key}`);
    rawMetadata[key] = parseScalar(line.slice(separator + 1).trim());
  }
  const metadata = metadataSchema.parse(rawMetadata);
  let description = match[2].startsWith("\n") ? match[2].slice(1) : match[2];
  if (description.endsWith("\n")) description = description.slice(0, -1);
  return {
    id: metadata.id,
    title: metadata.title,
    description,
    status: metadata.status,
    position: metadata.position,
    assignee: metadata.assignee?.toLowerCase() ?? null,
    createdBy: metadata.created_by.toLowerCase(),
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    archivedAt: metadata.archived_at ?? null,
  };
}

function serializeCard(card: StoredCard): string {
  const metadata: Array<[string, string | number | null]> = [
    ["id", card.id],
    ["title", card.title],
    ["status", card.status],
    ["position", card.position],
    ["assignee", card.assignee],
    ["created_by", card.createdBy],
    ["created_at", card.createdAt],
    ["updated_at", card.updatedAt],
  ];
  if (card.archivedAt !== null) metadata.push(["archived_at", card.archivedAt]);
  const frontmatter = metadata.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join("\n");
  const trailingNewline = card.description && !card.description.endsWith("\n") ? "\n" : "";
  return `---\n${frontmatter}\n---\n\n${card.description}${trailingNewline}`;
}

function parseScalar(value: string): string | number | null {
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("Quoted frontmatter values must be strings");
    return parsed;
  }
  if (!value) return "";
  return value;
}

function serializeScalar(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  const unsafe =
    value.trim() !== value ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/.test(value) ||
    /^(?:null|true|false|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

function legacyRowToCard(row: LegacyCardRow): StoredCard {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    status: row.status as CardStatus,
    position: Number(row.position),
    assignee: row.assignee_email ? String(row.assignee_email).toLowerCase() : null,
    createdBy: String(row.creator_email).toLowerCase(),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at ? String(row.archived_at) : null,
  };
}

function compareCards(left: StoredCard, right: StoredCard): number {
  const status = CARD_STATUSES.indexOf(left.status) - CARD_STATUSES.indexOf(right.status);
  if (status !== 0) return status;
  if (left.position !== right.position) return left.position - right.position;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}

function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
