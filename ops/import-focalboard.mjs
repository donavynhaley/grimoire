#!/usr/bin/env node
// Imports a Focalboard board into a Grimoire project, offline.
//
// The input is Focalboard's own export (board menu -> Export board archive), taken whole:
// pass the .boardarchive file itself, a directory it was unzipped into, or a single
// board.jsonl out of it. The archive is a zip and zips are readable on Node's own zlib, so
// nothing has to be unpacked first and the dependency list stays where DEP-1 wants it. This
// is the sanctioned bulk path from docs/architecture.md ("Bulk import"): page markdown is
// written directly into the data directory with the server stopped.
//
//   node ops/import-focalboard.mjs <.boardarchive | directory | board.jsonl> \
//     <pages-directory> <database> --project <slug> [--as <email>] [--board <id-or-title>] \
//     [--status <property>] [--option "Value=Column"]... [--apply]
//
// <pages-directory> is GRIMOIRE_PAGES_DIRECTORY (in production, the ./data/cards mount) and
// <database> is the grimoire.sqlite beside it. Without --apply it validates every card,
// prints what it would create, and writes nothing. STOP THE SERVER BEFORE --apply.
//
// Decisions, and their reasons:
//   - Focalboard has no columns of its own: a kanban view groups cards by whichever select
//     property it is told to. So the importer finds the status property the way the board
//     did - the one its board view groups by, or failing that a select named "Status", or
//     the only select there is - and --status names one when the board is too ambiguous to
//     guess. Guessing wrong here would deal every card to the wrong pile, so ambiguity is
//     an error, never a coin toss.
//   - the property's option values resolve through the shared synonym table (Not Started ->
//     Backlog, Completed -> Done, ...). An option the table does not recognise is an ERROR
//     naming the option - the fix is one --option "Value=Column" flag - but only when a card
//     actually holds it. A card with no status at all lands in Backlog, because absence is
//     not a miss: Focalboard shows those cards in a "No status" group and Backlog is that
//     group's honest translation.
//   - an archive can hold several boards, and a Grimoire project is one board's worth of
//     work, so multi-board archives import one board per run, chosen with --board.
//   - card content blocks are walked in the card's own contentOrder: text stays Markdown,
//     checkboxes keep their ticks, dividers stay rules. Comments, images and attachments
//     are counted in the provenance footer rather than imported - a lossy copy that says
//     what it lost beats one that pretends it lost nothing.
//   - every other property the card carries is written into the footer by name (selects
//     resolved to their values, dates to days). Person properties are skipped: the export
//     names people by opaque ids, and an id in a footer helps nobody.
//   - template cards are skipped; they are stationery, not work.
//   - created_at and updated_at come from the card's own clocks. Focalboard records no
//     completion time, so a card landing in Done carries its last update as the stated
//     proxy - the import time would order every page identically and mean nothing.
//
// Re-running is safe: each page body carries "Imported from Focalboard card <id>", and a
// card id already on the board (active or archived) is skipped, not duplicated.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  applyPages,
  composePage,
  fail,
  loadProject,
  normalizeColumnName,
  parseMappingFlags,
  readBoardState,
  report,
  statusForColumnName,
  toIsoSeconds,
} from "./import-common.mjs";

const MARKER_PATTERN = /^Imported from Focalboard card ([A-Za-z0-9_-]+)\b/m;

function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  if (positional.length !== 3 || !flags.project) {
    console.error(
      "usage: node ops/import-focalboard.mjs <.boardarchive | directory | board.jsonl> " +
        "<pages-directory> <database> --project <slug> [--as <email>] [--board <id-or-title>] " +
        '[--status <property>] [--option "Value=Column"]... [--apply]',
    );
    process.exit(2);
  }
  const [archivePath, pagesDirectory, databasePath] = positional;
  if (!existsSync(archivePath)) fail(`No such file or directory: ${archivePath}`);
  if (!existsSync(databasePath)) fail(`No such file: ${databasePath}`);
  if (!existsSync(pagesDirectory)) fail(`No such directory: ${pagesDirectory}`);

  const optionOverrides = parseMappingFlags(flags.option, "--option");
  const { board, blocks } = readArchive(archivePath, flags.board);
  const statusProperty = resolveStatusProperty(board, blocks, flags.status);

  // Categories go deliberately unmapped: Focalboard has no card-type notion to translate,
  // and a guessed category is worse than none.
  const { createdBy } = loadProject(databasePath, flags.project, flags.as);
  const projectDirectory = join(pagesDirectory, flags.project);
  const { alreadyImported, existingTitles, positionCursor } = readBoardState(
    projectDirectory,
    MARKER_PATTERN,
  );

  const cards = blocks
    .filter((block) => block.type === "card" && !(block.deleteAt > 0))
    .sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const childrenByParent = new Map();
  for (const block of blocks) {
    if (!block.parentId) continue;
    const children = childrenByParent.get(block.parentId) ?? [];
    children.push(block);
    childrenByParent.set(block.parentId, children);
  }

  // Options resolve before cards so an unrecognised value is reported once, as the option
  // it is, not once per card that holds it - and only when a live card actually holds it.
  const statusByOption = new Map();
  const errors = [];
  const optionsInUse = new Set(
    cards
      .filter((card) => !card.fields?.isTemplate)
      .map((card) => card.fields?.properties?.[statusProperty.id])
      .filter((value) => typeof value === "string" && value),
  );
  for (const option of statusProperty.options ?? []) {
    const status =
      optionOverrides.get(normalizeColumnName(option.value)) ?? statusForColumnName(option.value);
    if (status) {
      statusByOption.set(option.id, status);
    } else if (optionsInUse.has(option.id)) {
      errors.push(
        `option "${option.value}" of "${statusProperty.name}": no column matches this value - say where its cards land with --option "${option.value}=Backlog|Up Next|In progress|Review|Done"`,
      );
    }
  }

  const warnings = [];
  const skipped = [];
  const planned = [];
  const source = `${board.title ? `"${board.title}" ` : ""}Focalboard export`;

  for (const card of cards) {
    const rawTitle = String(card.title ?? "").trim();
    const label = `card ${card.id} "${rawTitle.slice(0, 50)}"`;
    if (card.fields?.isTemplate) {
      skipped.push(`${label}: a card template, not work`);
      continue;
    }
    if (alreadyImported.has(card.id)) {
      skipped.push(`${label}: already on the board`);
      continue;
    }

    // Focalboard renders a blank title as "Untitled" rather than refusing it, so the import
    // does the same - inherited data gets carried, with a warning, not refused.
    // Whitespace collapses to spaces for the same reason as the Trello importer: an archive
    // can carry a title with a newline in it, and one line is the only honest board title.
    let title = rawTitle.replace(/\s+/g, " ");
    if (title.length < 1) {
      title = "Untitled";
      warnings.push(`${label}: the card has no title, imported as "Untitled"`);
    }
    let fullTitleLine = null;
    if (title.length > 240) {
      fullTitleLine = title;
      title = `${title.slice(0, 237)}...`;
      warnings.push(
        `${label}: the title is longer than 240 characters and was shortened (kept whole in the body)`,
      );
    }
    if (existingTitles.has(title.toLowerCase())) {
      warnings.push(`${label}: a page with this title already exists (imported anyway)`);
    }

    const statusValue = card.fields?.properties?.[statusProperty.id];
    let status = "backlog";
    if (typeof statusValue === "string" && statusValue) {
      const mapped = statusByOption.get(statusValue);
      if (mapped) {
        status = mapped;
      } else if (statusProperty.options?.some((option) => option.id === statusValue)) {
        continue; // the option itself is already an error above
      } else {
        // A value pointing at an option that no longer exists is Focalboard's own loose end
        // (deleting an option leaves its id on cards); the board shows such cards under "No
        // status", so Backlog keeps faith with what the user last saw.
        warnings.push(`${label}: its status points at a deleted option, landed in Backlog`);
      }
    }

    const createdAt = toIsoSeconds(card.createAt ?? Date.now());
    const updatedAt = toIsoSeconds(card.updateAt ?? card.createAt ?? Date.now());
    const row = {
      title,
      category: null,
      status,
      createdAt,
      updatedAt,
      completedAt: status === "done" ? updatedAt : null,
      description: composeBody(card, {
        fullTitleLine,
        source,
        board,
        statusProperty,
        blocksById,
        children: childrenByParent.get(card.id) ?? [],
      }),
    };
    try {
      const composed = composePage(row, { createdBy, positionCursor });
      existingTitles.add(title.toLowerCase());
      planned.push(composed);
    } catch (error) {
      errors.push(`${label}: serialized page fails the strict parse: ${error.message}`);
    }
  }
  report({ total: cards.length, planned, skipped, warnings, errors });
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s) - nothing written. Fix the flags or the export, then rerun.`);
    process.exit(1);
  }
  if (!flags.apply) {
    console.log("\nDry run - nothing written. Rerun with --apply (server stopped) to import.");
    return;
  }
  const activeDirectory = applyPages(projectDirectory, planned);
  console.log(
    `\nWrote ${planned.length} page file(s) to ${activeDirectory}. Start the server and load the board.`,
  );
}

/**
 * The card's own content leads, walked in its contentOrder, and the provenance is a footer.
 * "Imported from Focalboard card <id>" stays on a line of its own: the re-run guard reads it
 * with a multiline match, and a page that loses it gets created a second time by the next
 * import.
 */
function composeBody(card, { fullTitleLine, source, board, statusProperty, blocksById, children }) {
  const story = [];
  if (fullTitleLine) story.push(fullTitleLine);

  const contentIds = (card.fields?.contentOrder ?? []).flat(Number.POSITIVE_INFINITY);
  const contentBlocks =
    contentIds.length > 0
      ? contentIds.map((id) => blocksById.get(id)).filter(Boolean)
      : children
          .filter((block) => ["text", "checkbox", "divider"].includes(block.type))
          .sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0));

  let notImported = 0;
  const pieces = [];
  for (const block of contentBlocks) {
    if (block.deleteAt > 0) continue;
    if (block.type === "text" && String(block.title ?? "").trim()) {
      pieces.push({ kind: "text", text: String(block.title).trim() });
    } else if (block.type === "checkbox") {
      const checked = block.fields?.value === true || block.fields?.value === "true";
      pieces.push({
        kind: "checkbox",
        text: `- [${checked ? "x" : " "}] ${String(block.title ?? "").trim()}`,
      });
    } else if (block.type === "divider") {
      pieces.push({ kind: "text", text: "---" });
    } else if (block.type !== "text") {
      notImported += 1;
    }
  }
  // Adjacent checkboxes stay one list; everything else stands as its own paragraph.
  let paragraph = [];
  for (const piece of pieces) {
    if (piece.kind === "checkbox") {
      paragraph.push(piece.text);
    } else {
      if (paragraph.length > 0) story.push(paragraph.join("\n"));
      paragraph = [];
      story.push(piece.text);
    }
  }
  if (paragraph.length > 0) story.push(paragraph.join("\n"));

  const provenance = [`Imported from Focalboard card ${card.id} (${source}).`];
  for (const property of board.cardProperties ?? []) {
    if (property.id === statusProperty.id) continue;
    const rendered = renderProperty(property, card.fields?.properties?.[property.id]);
    if (rendered !== null) provenance.push(`${property.name}: ${rendered}.`);
  }
  const comments = children.filter((block) => block.type === "comment" && !(block.deleteAt > 0)).length;
  if (comments > 0) provenance.push(`${comments} comment${comments === 1 ? "" : "s"} not imported.`);
  if (notImported > 0)
    provenance.push(`${notImported} attachment/other block${notImported === 1 ? "" : "s"} not imported.`);

  const storyText = story.join("\n\n");
  return storyText ? `${storyText}\n\n---\n\n${provenance.join("\n")}` : provenance.join("\n");
}

function renderProperty(property, raw) {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0))
    return null;
  const optionValue = (id) =>
    property.options?.find((option) => option.id === id)?.value ?? `${id} (deleted option)`;
  switch (property.type) {
    case "select":
      return optionValue(raw);
    case "multiSelect":
      return (Array.isArray(raw) ? raw : [raw]).map(optionValue).join(", ");
    case "text":
    case "number":
    case "email":
    case "phone":
    case "url":
      return String(raw);
    case "checkbox":
      return raw === "true" || raw === true ? "yes" : "no";
    case "date": {
      // Focalboard stores dates as a JSON string inside the property value.
      try {
        const range = JSON.parse(raw);
        const day = (ms) => new Date(ms).toISOString().slice(0, 10);
        if (typeof range.from !== "number") return null;
        return typeof range.to === "number" ? `${day(range.from)} to ${day(range.to)}` : day(range.from);
      } catch {
        return null;
      }
    }
    default:
      // person, createdBy, createdTime and the like: opaque ids or derived clocks.
      return null;
  }
}

/**
 * A board's status property, found the way the board itself presents columns: the property
 * its board view groups by, else a select named "Status", else the only select there is.
 * Anything less determined is an error asking for --status, because every card's column
 * hangs on this one choice.
 */
function resolveStatusProperty(board, blocks, statusFlag) {
  const selects = (board.cardProperties ?? []).filter((property) => property.type === "select");
  if (statusFlag) {
    const named = (board.cardProperties ?? []).find(
      (property) => property.name.toLowerCase() === statusFlag.toLowerCase(),
    );
    if (!named) fail(`The board has no property named "${statusFlag}"`);
    if (named.type !== "select")
      fail(`Property "${named.name}" is a ${named.type}, not a select - columns need a select`);
    return named;
  }
  const groupIds = new Set(
    blocks
      .filter(
        (block) => block.type === "view" && block.fields?.viewType === "board" && block.fields?.groupById,
      )
      .map((block) => block.fields.groupById),
  );
  if (groupIds.size === 1) {
    const grouped = selects.find((property) => groupIds.has(property.id));
    if (grouped) return grouped;
  }
  const named = selects.find((property) => normalizeColumnName(property.name) === "status");
  if (named) return named;
  if (selects.length === 1) return selects[0];
  return fail(
    `Cannot tell which property holds the board's columns - pass --status with one of: ${
      selects.map((property) => `"${property.name}"`).join(", ") || "(the board has no select properties)"
    }`,
  );
}

// --- Reading the archive -------------------------------------------------------------------

function readArchive(archivePath, boardFlag) {
  const boards = [];
  if (statSync(archivePath).isDirectory()) {
    for (const entry of readdirSync(archivePath, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name === "board.jsonl") {
        boards.push(parseBoardLines(readFileSync(join(entry.parentPath, entry.name), "utf8"), archivePath));
      }
    }
    if (boards.length === 0) fail(`No board.jsonl anywhere under ${archivePath}`);
  } else if (archivePath.endsWith(".jsonl")) {
    boards.push(parseBoardLines(readFileSync(archivePath, "utf8"), archivePath));
  } else {
    const entries = readZip(readFileSync(archivePath));
    for (const [name, read] of entries) {
      if (name.endsWith("board.jsonl")) boards.push(parseBoardLines(read().toString("utf8"), archivePath));
    }
    if (boards.length === 0) fail(`${archivePath} holds no board.jsonl - is it a Focalboard board archive?`);
  }

  if (boardFlag) {
    const chosen = boards.find(
      (candidate) =>
        candidate.board.id === boardFlag || candidate.board.title?.toLowerCase() === boardFlag.toLowerCase(),
    );
    if (!chosen) {
      fail(
        `No board "${boardFlag}" in the archive. It holds:\n${boards
          .map(({ board }) => `  ${board.id}  ${board.title || "(untitled)"}`)
          .join("\n")}`,
      );
    }
    return chosen;
  }
  if (boards.length > 1) {
    fail(
      `The archive holds ${boards.length} boards and a Grimoire project is one board's worth of work - pick one with --board:\n${boards
        .map(({ board }) => `  ${board.id}  ${board.title || "(untitled)"}`)
        .join("\n")}`,
    );
  }
  return boards[0];
}

function parseBoardLines(text, sourcePath) {
  let board = null;
  const blocks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`${sourcePath}: a line is not JSON - is this a Focalboard board.jsonl?`);
    }
    if (parsed.type === "board" && parsed.data) {
      if (board) fail(`${sourcePath}: holds more than one board line`);
      board = parsed.data;
    } else if (parsed.type === "block" && parsed.data) {
      blocks.push(parsed.data);
    }
  }
  if (!board) fail(`${sourcePath}: no board line - is this a Focalboard board.jsonl?`);
  return { board, blocks };
}

/**
 * The smallest honest zip reader: entries come from the central directory, which always
 * carries names, sizes and offsets even when the writer streamed (local headers then lack
 * sizes and are followed by data descriptors - reading them would need guesswork, reading
 * the directory needs none). Only stored and deflated entries exist in practice, and
 * deflate is Node's own zlib. Decompression is behind a thunk so a board archive's images,
 * which this importer never reads, are never inflated.
 */
function readZip(buffer) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 65557; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail("Not a zip file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) fail("Corrupt zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return fail(`Unsupported zip compression method ${method} for ${name}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseArguments(argv) {
  const positional = [];
  const flags = { apply: false, option: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") flags.apply = true;
    else if (["--as", "--project", "--board", "--status", "--option"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) fail(`${argument} needs a value`);
      if (argument === "--option") flags.option.push(value);
      else flags[argument.slice(2)] = value;
      index += 1;
    } else if (argument.startsWith("--")) fail(`Unknown flag: ${argument}`);
    else positional.push(argument);
  }
  return { positional, flags };
}

main();
