// The board-side half of a bulk importer, shared by import-trello.mjs and
// import-focalboard.mjs.
//
// Every importer has two halves: reading a foreign export, which is different every time, and
// writing Grimoire's own page files, which must be identical every time. This module is the
// second half, held once: the page serializer and the strict parser that mirror
// server/markdown-files.ts and server/markdown-pages.ts byte-for-byte, the atomic write, and
// the reads of the project's real definitions that validation resolves against. Ops scripts
// stay dependency-free (DEP-1), so this mirrors the server rather than importing its
// TypeScript; the importer test suites hold the mirror in lockstep by loading what the
// scripts write through the real MarkdownPageStore.
//
// The contract every importer honours (docs/architecture.md, "Bulk import"): run offline with
// the server stopped, validate every row against the project's own definitions, dry-run by
// default, and write nothing unless zero rows fail - the strict schema means one rejected
// file fails the whole board, so a partial import is the one outcome that must never happen.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COLUMN_TO_STATUS, normalizeColumnName } from "../shared/import-sources.mjs";

// The source-side half - the readers, the synonym table, the zip - lives in
// shared/import-sources.mjs so the server's in-app import consumes the same copy.
export {
  COLUMN_TO_STATUS,
  normalizeColumnName,
  statusForColumnName,
  toIsoSeconds,
} from "../shared/import-sources.mjs";

export const PAGE_STATUSES = ["backlog", "ready", "in_progress", "review", "done"];

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function fail(message) {
  console.error(message);
  process.exit(2);
}

/**
 * Opens the instance database read-only and resolves the project an import lands in: its
 * categories, and the member the created pages are attributed to. Imported pages must belong
 * to a real member, so --as is required whenever the instance has more than one owner.
 */
export function loadProject(databasePath, projectSlug, asEmail) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const project = database
    .prepare("SELECT id, slug FROM projects WHERE slug = ? AND archived_at IS NULL")
    .get(projectSlug);
  if (!project) fail(`No active project with slug "${projectSlug}" in ${databasePath}`);
  const categories = database
    .prepare("SELECT slug, name FROM categories WHERE project_id = ?")
    .all(project.id);
  const createdBy = resolveCreator(database, asEmail);
  database.close();
  return { categories, createdBy };
}

function resolveCreator(database, asEmail) {
  if (asEmail) {
    const user = database.prepare("SELECT email FROM users WHERE email = ? COLLATE NOCASE").get(asEmail);
    if (!user) fail(`No account with email ${asEmail} - imported pages must be attributed to a real member`);
    return String(user.email).toLowerCase();
  }
  const owners = database.prepare("SELECT email FROM users WHERE role = 'owner'").all();
  if (owners.length !== 1) {
    fail(`The instance has ${owners.length} owners - pass --as <email> to say who this import acts as`);
  }
  return String(owners[0].email).toLowerCase();
}

/**
 * Reads what is already on the board, so an import appends rather than collides: the position
 * cursor per column, the titles already taken, and the source ids of pages an earlier run
 * created. `markerPattern` is the importer's own provenance line, matched multiline against
 * each body; whatever its first capture group yields lands in `alreadyImported`, which is what
 * makes re-running safe.
 */
export function readBoardState(projectDirectory, markerPattern) {
  const alreadyImported = new Set();
  const existingTitles = new Set();
  const positionCursor = new Map(PAGE_STATUSES.map((status) => [status, 0]));
  for (const page of readExistingPages(projectDirectory)) {
    existingTitles.add(page.title.toLowerCase());
    const imported = page.description.match(markerPattern);
    if (imported) alreadyImported.add(imported[1]);
    if (page.archivedAt === null) {
      positionCursor.set(page.status, (positionCursor.get(page.status) ?? 0) + 1);
    }
  }
  return { alreadyImported, existingTitles, positionCursor };
}

function readExistingPages(projectDirectory) {
  const pages = [];
  for (const [subdirectory, archived] of [
    ["pages", false],
    ["archive", true],
  ]) {
    const directory = join(projectDirectory, subdirectory);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      let parsed;
      try {
        parsed = parsePage(readFileSync(path, "utf8"));
      } catch (error) {
        fail(
          `Existing page file is invalid, refusing to import into a broken board: ${path}: ${error.message}`,
        );
      }
      if (basename(entry.name, ".md") !== parsed.metadata.id) {
        fail(
          `Existing page file is invalid, refusing to import into a broken board: ${path}: filename must match the page id`,
        );
      }
      pages.push({
        title: parsed.metadata.title,
        status: parsed.metadata.status,
        description: parsed.body,
        archivedAt: archived ? (parsed.metadata.archived_at ?? "unknown") : null,
      });
    }
  }
  return pages;
}

/**
 * Assembles one importable page and proves it: takes the next position in its column, gives
 * it an id, serializes it, and re-parses the result under the same strict rules the board
 * loads with. Returns { page, serialized }, or throws with the parse's complaint - the caller
 * records that as a row error and the import refuses to apply.
 */
export function composePage(row, { createdBy, positionCursor }) {
  const position = positionCursor.get(row.status);
  positionCursor.set(row.status, position + 1);
  const page = {
    id: randomUUID(),
    title: row.title,
    category: row.category ?? null,
    chapter: null,
    fields: {},
    status: row.status,
    position,
    createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
    estimate: null,
    description: row.description,
  };
  const serialized = serializePage(page);
  parsePage(serialized, page.id);
  return { page, serialized };
}

export function applyPages(projectDirectory, planned) {
  const activeDirectory = join(projectDirectory, "pages");
  mkdirSync(activeDirectory, { recursive: true });
  for (const { page, serialized } of planned) {
    writeAtomic(join(activeDirectory, `${page.id}.md`), serialized);
  }
  return activeDirectory;
}

export function report({ total, planned, skipped, warnings, errors }) {
  console.log(`${total} card(s) in the export.`);
  for (const { page } of planned) {
    const parts = [
      `create [${page.status} #${page.position}]`,
      page.category ? `${page.category}:` : null,
      JSON.stringify(page.title.length > 60 ? `${page.title.slice(0, 57)}...` : page.title),
    ].filter(Boolean);
    console.log(`  ${parts.join(" ")}`);
  }
  for (const line of skipped) console.log(`  skip ${line}`);
  for (const line of warnings) console.log(`  warn ${line}`);
  for (const line of errors) console.log(`  ERROR ${line}`);
  console.log(
    `\n${planned.length} to create, ${skipped.length} skipped, ` +
      `${warnings.length} warning(s), ${errors.length} error(s).`,
  );
}

// --- The board's file format, replicated byte-for-byte -------------------------------------

function serializePage(page) {
  const metadata = [
    ["id", page.id],
    ["title", page.title],
  ];
  if (page.category !== null) metadata.push(["category", page.category]);
  if (page.chapter !== null) metadata.push(["chapter", page.chapter]);
  if (Object.keys(page.fields).length > 0) metadata.push(["fields", page.fields]);
  metadata.push(
    ["blocked_by", []],
    ["status", page.status],
    ["position", page.position],
    ["assignee", null],
    ["created_by", page.createdBy],
    ["created_at", page.createdAt],
    ["updated_at", page.updatedAt],
    ["completed_at", page.completedAt],
  );
  // Key order matches server/markdown-pages.ts exactly: estimate after completed_at, before
  // the keys importers never write (github, archived_at).
  if (page.estimate !== null && page.estimate !== undefined) metadata.push(["estimate", page.estimate]);
  const frontmatter = metadata.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join("\n");
  const body = page.description;
  const trailingNewline = body && !body.endsWith("\n") ? "\n" : "";
  return `---\n${frontmatter}\n---\n\n${body}${trailingNewline}`;
}

function serializeScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  const unsafe =
    value.trim() !== value ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/.test(value) ||
    /^(?:null|true|false|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePage(markdown, expectedId) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Expected YAML frontmatter enclosed by --- lines");
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (key in metadata) throw new Error(`Duplicate frontmatter field: ${key}`);
    metadata[key] = parseScalar(line.slice(separator + 1).trim());
  }
  requireString(metadata, "id", (value) => UUID_PATTERN.test(value), "a UUID");
  if (expectedId !== undefined && metadata.id !== expectedId) throw new Error("id does not round-trip");
  requireString(
    metadata,
    "title",
    (value) => value.trim() === value && value.length >= 1 && value.length <= 240,
    "1-240 trimmed characters",
  );
  if (metadata.category !== null && metadata.category !== undefined) {
    requireString(metadata, "category", (value) => SLUG_PATTERN.test(value) && value.length <= 40, "a slug");
  }
  if (metadata.chapter !== undefined) {
    requireString(metadata, "chapter", (value) => SLUG_PATTERN.test(value) && value.length <= 60, "a slug");
  }
  if (metadata.fields !== undefined) {
    if (typeof metadata.fields !== "object" || Array.isArray(metadata.fields) || metadata.fields === null) {
      throw new Error("fields must be a flat record");
    }
  }
  if (!Array.isArray(metadata.blocked_by)) throw new Error("blocked_by must be an array");
  if (!PAGE_STATUSES.includes(metadata.status)) throw new Error(`Invalid status: ${metadata.status}`);
  if (!Number.isInteger(metadata.position) || metadata.position < 0)
    throw new Error("position must be a non-negative integer");
  if (metadata.assignee !== null)
    requireString(metadata, "assignee", (value) => value.includes("@"), "an email or null");
  requireString(metadata, "created_by", (value) => value.includes("@"), "an email");
  for (const key of ["created_at", "updated_at"]) {
    requireString(
      metadata,
      key,
      (value) => TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
      "an ISO timestamp",
    );
  }
  if (metadata.completed_at !== null && metadata.completed_at !== undefined) {
    requireString(
      metadata,
      "completed_at",
      (value) => TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
      "an ISO timestamp",
    );
  }
  if (metadata.estimate !== null && metadata.estimate !== undefined) {
    const value = metadata.estimate;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) {
      throw new Error(`estimate must be a number between 0 and 100000, got ${JSON.stringify(value)}`);
    }
  }
  let body = match[2].replace(/^\r?\n/, "");
  body = body.replace(/\r?\n$/, "");
  return { metadata, body };
}

function requireString(metadata, key, check, wanted) {
  const value = metadata[key];
  if (typeof value !== "string" || !check(value)) {
    throw new Error(`${key} must be ${wanted}, got ${JSON.stringify(value)}`);
  }
}

function parseScalar(value) {
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Frontmatter arrays must contain only strings");
    }
    return parsed;
  }
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Frontmatter records must be JSON objects");
    }
    for (const entry of Object.values(parsed)) {
      const type = typeof entry;
      if (type !== "string" && type !== "number" && type !== "boolean") {
        throw new Error("Frontmatter records may only hold strings, numbers, and booleans");
      }
    }
    return parsed;
  }
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("Quoted frontmatter values must be strings");
    return parsed;
  }
  if (!value) return "";
  return value;
}

function writeAtomic(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  let descriptor = null;
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

/**
 * The board-side planning loop both CLI importers share: skip what an earlier run already
 * imported, warn on a title the board already carries, resolve a Trello label to a project
 * category when exactly its name exists, and prove each page by serializing and re-parsing
 * it. Positions are consumed only by pages that will actually be created.
 */
export function planBoardRows(reading, { categories, createdBy, boardState }) {
  const { alreadyImported, existingTitles, positionCursor } = boardState;
  const planned = [];
  const errors = [...reading.errors];
  const warnings = [...reading.warnings];
  const skipped = [...reading.skipped];
  for (const row of reading.rows) {
    if (alreadyImported.has(row.sourceId)) {
      skipped.push(`${row.label}: already on the board`);
      continue;
    }
    if (existingTitles.has(row.title.toLowerCase())) {
      warnings.push(`${row.label}: a page with this title already exists (imported anyway)`);
    }
    const category =
      categories.find((candidate) =>
        row.labels.some((name) => name.toLowerCase() === candidate.name.toLowerCase()),
      )?.slug ?? null;
    try {
      const composed = composePage({ ...row, category }, { createdBy, positionCursor });
      existingTitles.add(row.title.toLowerCase());
      planned.push(composed);
    } catch (error) {
      errors.push(`${row.label}: serialized page fails the strict parse: ${error.message}`);
    }
  }
  return { planned, errors, warnings, skipped };
}

export function parseMappingFlags(pairs, flag) {
  const mappings = new Map();
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) fail(`${flag} takes "Name=Column", got "${pair}"`);
    const name = pair.slice(0, separator).trim();
    const column = pair.slice(separator + 1).trim();
    const status = COLUMN_TO_STATUS[column.toLowerCase()];
    if (!status) {
      fail(
        `${flag} "${pair}": "${column}" is not a column - use Backlog, Up Next, In progress, Review or Done`,
      );
    }
    mappings.set(normalizeColumnName(name), status);
  }
  return mappings;
}
