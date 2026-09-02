#!/usr/bin/env node
// Imports a Notion board into a Grimoire project from a reconciled import map, offline.
//
// Notion's export is a zip of CSVs and Markdown whose columns mean whatever a workspace
// decided they mean, so unlike the Trello and Focalboard importers this one does not read
// the export directly. It takes an **import map** instead: one JSON file in which somebody
// has already decided where every task lands - its column, its category, its chapter, its
// field values. Writing the map is the migration's real work, the deciding, and the map is
// that work's committed record. See docs/import-from-notion.md for the map format.
//
// This is the sanctioned bulk path from docs/architecture.md ("Bulk import"): page markdown
// is written directly into the data directory with the server stopped, so a one-time import
// neither fights the write rate limit nor half-lands if something is wrong.
//
//   node ops/import-notion.mjs <import-map.json> <pages-directory> <database> \
//     --project <slug> [--as <email>] [--chapter <slug>] [--apply]
//
// <pages-directory> is GRIMOIRE_PAGES_DIRECTORY (in production, the ./data/cards mount) and
// <database> is the grimoire.sqlite beside it. Without --apply it validates every row, prints
// what it would create, and writes nothing. STOP THE SERVER BEFORE --apply: the server caches
// nothing, but two writers assigning positions to the same column is a race.
//
// The import is all-or-nothing: every row is resolved, validated against the project's own
// definitions, serialized, and re-parsed under the same strict rules the board loads with -
// and only when zero rows are rejected does --apply write a single file. One bad frontmatter
// file fails the whole board, so a partial import is the one outcome this script must never
// produce.
//
// The map has three sections, and they differ only in where their pages land:
//   - backlog_pages  -> Backlog, no chapter. Backlog means accepted but unscheduled, and a
//                       chapter is a sprint, so scheduling them would say something untrue.
//   - as_is_pages    -> the sprint in motion, in whatever column Notion had them in. These
//                       take the --chapter flag.
//   - done_pages     -> completed work, filed under the sprint that delivered it. Each row
//                       names its own chapter, because history spans many of them.
//
// Decisions the map already made, honoured here:
//   - column names map Not started->Backlog->backlog, Up Next->ready, In progress->in_progress,
//     Waiting for Review->Review->review, Done->done
//   - `estimate` is Grimoire's own numeric field, a whole number written at the top of the
//     frontmatter rather than into `fields`. It is the one a chapter sums when it closes, so a
//     custom field of the same name would look identical on a page and count for nothing
//   - every other key on a row is one of the project's own fields (a severity, an epic - the
//     map decides). A value the project has no option for is an ERROR, not a drop: it was
//     assigned during reconciliation rather than inherited, so a miss is a mistake
//   - field keys resolve exactly; a missing definition is an error, never a guess
//   - a per-row "chapter" key beats --chapter, and --chapter reaches only the as-is slice
//   - Notion records no completion time, so a done row may carry "completed_at" as an
//     explicitly-stated proxy; without one the import time is used, which orders every page
//     identically and is worse.
//
// Re-running is safe: each page body carries "Imported from Notion task <id>", and a task id
// already present on the board (active or archived) is skipped, not duplicated.

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

const PAGE_STATUSES = ["backlog", "ready", "in_progress", "review", "done"];
const COLUMN_TO_STATUS = {
  backlog: "backlog",
  "up next": "ready",
  "in progress": "in_progress",
  review: "review",
  "waiting for review": "review",
  done: "done",
};
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The keys a map row spends on the page itself; everything else on a row names one of the
// project's own fields and must resolve against a provisioned definition, exactly.
const RESERVED_ROW_KEYS = new Set([
  "notion_task_id",
  "title",
  "category",
  "column",
  "estimate",
  "chapter",
  "completed_at",
  "body",
  "note",
  "absorbs",
  "source",
  "section",
]);

function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  if (positional.length !== 3 || !flags.project) {
    console.error(
      "usage: node ops/import-notion.mjs <import-map.json> <pages-directory> <database> " +
        "--project <slug> [--as <email>] [--chapter <slug>] [--apply]",
    );
    process.exit(2);
  }
  const [mapPath, pagesDirectory, databasePath] = positional;
  const projectSlug = flags.project;
  if (!SLUG_PATTERN.test(projectSlug)) fail(`Invalid project slug: ${projectSlug}`);
  for (const path of [mapPath, databasePath]) {
    if (!existsSync(path)) fail(`No such file: ${path}`);
  }
  if (!existsSync(pagesDirectory)) fail(`No such directory: ${pagesDirectory}`);

  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const rows = [
    ...(map.backlog_pages ?? []).map((row) => ({ ...row, section: "backlog" })),
    ...(map.as_is_pages ?? []).map((row) => ({ ...row, section: "as-is" })),
    ...(map.done_pages ?? []).map((row) => ({ ...row, section: "done" })),
  ];
  if (rows.length === 0) fail("The map has no backlog_pages, as_is_pages or done_pages rows");

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const project = database
    .prepare("SELECT id, slug FROM projects WHERE slug = ? AND archived_at IS NULL")
    .get(projectSlug);
  if (!project) fail(`No active project with slug "${projectSlug}" in ${databasePath}`);

  const categories = database
    .prepare("SELECT slug, name FROM categories WHERE project_id = ?")
    .all(project.id);
  const definitions = new Map(
    database
      .prepare("SELECT key, label, type, options FROM project_fields WHERE project_id = ?")
      .all(project.id)
      .map((field) => [field.key, { ...field, options: JSON.parse(field.options) }]),
  );
  const createdBy = resolveCreator(database, flags.as);
  database.close();

  const projectDirectory = join(pagesDirectory, projectSlug);
  if (flags.chapter && !existsSync(join(projectDirectory, "chapters", `${flags.chapter}.md`))) {
    fail(`No chapter "${flags.chapter}" under ${join(projectDirectory, "chapters")}`);
  }

  const existing = readExistingPages(projectDirectory);
  const alreadyImported = new Set();
  const existingTitles = new Set();
  const positionCursor = new Map(PAGE_STATUSES.map((status) => [status, 0]));
  for (const page of existing) {
    existingTitles.add(page.title.toLowerCase());
    const imported = page.description.match(/^Imported from Notion task (\d+)\b/m);
    if (imported) alreadyImported.add(Number(imported[1]));
    if (page.archivedAt === null) {
      positionCursor.set(page.status, (positionCursor.get(page.status) ?? 0) + 1);
    }
  }

  const now = new Date().toISOString();
  const errors = [];
  const warnings = [];
  const skipped = [];
  const planned = [];

  for (const row of rows) {
    const label = `task ${row.notion_task_id} "${String(row.title).slice(0, 50)}"`;
    if (!Number.isInteger(row.notion_task_id)) {
      errors.push(`${label}: notion_task_id must be an integer`);
      continue;
    }
    if (alreadyImported.has(row.notion_task_id)) {
      skipped.push(`${label}: already on the board`);
      continue;
    }

    const title = String(row.title ?? "").trim();
    if (title.length < 1 || title.length > 240) {
      errors.push(`${label}: title must be 1-240 characters after trimming`);
      continue;
    }
    if (existingTitles.has(title.toLowerCase())) {
      warnings.push(`${label}: a page with this title already exists (imported anyway)`);
    }

    const status =
      COLUMN_TO_STATUS[
        String(row.column ?? "")
          .trim()
          .toLowerCase()
      ];
    if (!status) {
      errors.push(`${label}: unknown column "${row.column}"`);
      continue;
    }

    const category = categories.find(
      (candidate) =>
        candidate.name.toLowerCase() ===
        String(row.category ?? "")
          .trim()
          .toLowerCase(),
    );
    if (!category) {
      errors.push(`${label}: the project has no category named "${row.category}"`);
      continue;
    }

    // `estimate` is Grimoire's own field, not one of the project's - it lives at the top of the
    // frontmatter rather than inside `fields`, and it is the one a chapter sums when it closes.
    // A custom field of the same name would look identical on a page and count for nothing.
    // A blank string is a cell nobody filled in, not a zero the board would show as a real
    // estimate; and only a whole number survives the strict frontmatter parser the server
    // loads with, so anything else is refused here rather than written as a page it cannot read.
    let estimate = null;
    const flagsForRow = [];
    let rowFailed = false;
    const rawEstimate = typeof row.estimate === "string" ? row.estimate.trim() : row.estimate;
    if (rawEstimate !== null && rawEstimate !== undefined && rawEstimate !== "") {
      const value =
        typeof rawEstimate === "string"
          ? /^\d+$/.test(rawEstimate)
            ? Number(rawEstimate)
            : NaN
          : rawEstimate;
      if (!Number.isInteger(value) || value < 0 || value > 100_000) {
        errors.push(
          `${label}: estimate ${JSON.stringify(row.estimate)} is not a whole number between 0 and 100000`,
        );
        rowFailed = true;
      } else {
        estimate = value;
      }
    }

    const fields = {};
    const fieldKeys = Object.keys(row).filter((key) => !RESERVED_ROW_KEYS.has(key));
    for (const key of rowFailed ? [] : fieldKeys) {
      const raw = row[key];
      if (raw === null || raw === undefined) continue;
      const definition = definitions.get(key);
      if (!definition) {
        errors.push(
          `${label}: the project has no field with key "${key}" (never guessed - provision it first)`,
        );
        rowFailed = true;
        break;
      }
      const value = checkFieldValue(definition, raw);
      if (value !== null) {
        fields[key] = value;
      } else {
        errors.push(`${label}: ${key} ${JSON.stringify(raw)} is not one of ${definition.options.join(", ")}`);
        rowFailed = true;
        break;
      }
    }
    if (rowFailed) continue;

    let chapter = null;
    if (typeof row.chapter === "string" && row.chapter) {
      if (!existsSync(join(projectDirectory, "chapters", `${row.chapter}.md`))) {
        errors.push(`${label}: no chapter "${row.chapter}" exists`);
        continue;
      }
      chapter = row.chapter;
    } else if (flags.chapter && row.section === "as-is") {
      chapter = flags.chapter;
    }

    const completedAt =
      status === "done" ? (typeof row.completed_at === "string" ? row.completed_at : now) : null;

    const position = positionCursor.get(status);
    positionCursor.set(status, position + 1);

    const page = {
      id: randomUUID(),
      estimate,
      title,
      category: category.slug,
      chapter,
      fields,
      status,
      position,
      createdBy,
      createdAt: now,
      updatedAt: now,
      completedAt,
      description: composeBody(row, basename(mapPath)),
    };

    const serialized = serializePage(page);
    try {
      // The same strict round trip the board performs at load: if this parse refuses the
      // file, the board would too, and nothing may be written.
      parsePage(serialized, page.id);
    } catch (error) {
      errors.push(`${label}: serialized page fails the strict parse: ${error.message}`);
      continue;
    }

    existingTitles.add(title.toLowerCase());
    planned.push({ row, page, serialized, flags: flagsForRow });
  }

  report({ rows, planned, skipped, warnings, errors, chapterFlag: flags.chapter });
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s) - nothing written. Fix the map or the project, then rerun.`);
    process.exit(1);
  }
  if (!flags.apply) {
    console.log("\nDry run - nothing written. Rerun with --apply (server stopped) to import.");
    return;
  }

  const activeDirectory = join(projectDirectory, "pages");
  mkdirSync(activeDirectory, { recursive: true });
  for (const { page, serialized } of planned) {
    writeAtomic(join(activeDirectory, `${page.id}.md`), serialized);
  }
  console.log(
    `\nWrote ${planned.length} page file(s) to ${activeDirectory}. Start the server and load the board.`,
  );
}

function parseArguments(argv) {
  const positional = [];
  const flags = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") flags.apply = true;
    else if (argument === "--as" || argument === "--project" || argument === "--chapter") {
      const value = argv[index + 1];
      if (!value) fail(`${argument} needs a value`);
      flags[argument.slice(2)] = value;
      index += 1;
    } else if (argument.startsWith("--")) fail(`Unknown flag: ${argument}`);
    else positional.push(argument);
  }
  return { positional, flags };
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
 * Field validation mirrors the server's checkedFieldValue, with one deliberate difference:
 * select values arrive from the map as JSON numbers ("estimate": 8) as often as strings, so
 * they are stringified before the options check - the file stores the option string either way.
 * Returns the value to store, or null when a select value has no matching option.
 */
function checkFieldValue(definition, raw) {
  switch (definition.type) {
    case "text":
      return typeof raw === "string" ? raw : failType(definition, raw, "text");
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : failType(definition, raw, "a number");
    case "checkbox":
      return typeof raw === "boolean" ? raw : failType(definition, raw, "true or false");
    case "date":
      return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? raw
        : failType(definition, raw, "a YYYY-MM-DD day");
    case "select":
    case "search-select": {
      const value = typeof raw === "number" ? String(raw) : raw;
      if (typeof value !== "string") failType(definition, raw, "one of its options");
      return definition.options.includes(value) ? value : null;
    }
    default:
      return fail(`Field "${definition.key}" has unsupported type "${definition.type}"`);
  }
}

function failType(definition, raw, wanted) {
  fail(`Field "${definition.key}" expects ${wanted}, got ${JSON.stringify(raw)}`);
}

/**
 * The page body carries provenance, not a story: where the page came from, what it absorbed,
 * and the one-line reconciliation note. "Imported from Notion task N" doubles as the marker
 * re-runs use to skip it, so its shape is load-bearing.
 */
function composeBody(row, mapFileName) {
  // The story leads, when the map carries one. An earlier run of this script imported 497
  // pages with provenance and nothing else, because the plan had decided that fetching bodies
  // was too expensive - a decision that was defensible when made and invisible by the time it
  // mattered. A map row that has a `body` now keeps it, and the provenance becomes a footer.
  const story = typeof row.body === "string" ? row.body.trim() : "";

  const provenance = [`Imported from Notion task ${row.notion_task_id} (${row.source ?? mapFileName}).`];
  if (Array.isArray(row.absorbs) && row.absorbs.length > 0) {
    provenance.push(`Absorbs Notion task${row.absorbs.length > 1 ? "s" : ""} ${row.absorbs.join(", ")}.`);
  }
  if (typeof row.note === "string" && row.note) provenance.push("", row.note);

  // The marker stays on a line of its own wherever it lands: the re-run guard reads it with a
  // multiline match, and a page that loses it gets created a second time by the next import.
  return story ? `${story}\n\n---\n\n${provenance.join("\n")}` : provenance.join("\n");
}

function report({ rows, planned, skipped, warnings, errors, chapterFlag }) {
  console.log(`${rows.length} row(s) in the map.`);
  for (const { row, page, flags: rowFlags } of planned) {
    const fields = Object.entries(page.fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const parts = [
      `create [${page.status} #${page.position}]`,
      `${page.category}:`,
      `task ${row.notion_task_id}`,
      JSON.stringify(page.title.length > 60 ? `${page.title.slice(0, 57)}...` : page.title),
    ];
    if (fields) parts.push(`{${fields}}`);
    if (page.chapter) parts.push(`chapter=${page.chapter}`);
    if (rowFlags.length > 0) parts.push(`! ${rowFlags.join("; ")}`);
    console.log(`  ${parts.join(" ")}`);
  }
  for (const line of skipped) console.log(`  skip ${line}`);
  for (const line of warnings) console.log(`  warn ${line}`);
  for (const line of errors) console.log(`  ERROR ${line}`);
  const dropped = planned.filter(({ flags: rowFlags }) => rowFlags.length > 0).length;
  console.log(
    `\n${planned.length} to create, ${skipped.length} skipped, ${dropped} with dropped values, ` +
      `${warnings.length} warning(s), ${errors.length} error(s).` +
      (chapterFlag ? ` As-is pages join chapter "${chapterFlag}".` : ""),
  );
}

// --- The board's file format, replicated byte-for-byte -------------------------------------
//
// Ops scripts stay dependency-free (see rename-pages-to-cards.mjs), so the serializer and the
// strict parser below mirror server/markdown-files.ts and server/markdown-pages.ts rather than
// import them. tests/server/import-notion.test.ts holds the two in lockstep: it loads what
// this script writes through the real MarkdownPageStore, so a format drift fails CI before it
// can fail a board.

function serializePage(page) {
  const metadata = [
    ["id", page.id],
    ["title", page.title],
    ["category", page.category],
  ];
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
  // the keys this script never writes (github, archived_at).
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

function parsePage(markdown, expectedId) {
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

function fail(message) {
  console.error(message);
  process.exit(2);
}

main();
