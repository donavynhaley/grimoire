#!/usr/bin/env node
// Imports a Focalboard board into a Grimoire project, offline.
//
// The input is Focalboard's own export (board menu -> Export board archive), taken whole:
// pass the .boardarchive file itself, a directory it was unzipped into, or a single
// board.jsonl out of it. This is the sanctioned bulk path from docs/architecture.md ("Bulk
// import"): page markdown is written directly into the data directory with the server
// stopped. The settings screen offers the same import through the server
// (docs/import-from-focalboard.md); this script remains the operator path.
//
//   node ops/import-focalboard.mjs <.boardarchive | directory | board.jsonl> \
//     <pages-directory> <database> --project <slug> [--as <email>] [--board <id-or-title>] \
//     [--status <property>] [--option "Value=Column"]... [--apply]
//
// <pages-directory> is GRIMOIRE_PAGES_DIRECTORY (in production, the ./data/cards mount) and
// <database> is the grimoire.sqlite beside it. Without --apply it validates every card,
// prints what it would create, and writes nothing. STOP THE SERVER BEFORE --apply.
//
// How a board maps - the status property, the option synonyms, the content walk - is the
// readers' own record: see shared/import-sources.mjs, which this script shares with the
// server so the two paths can never drift. What is this script's own: ambiguity is an ERROR
// naming the flag that settles it (--board for a multi-board archive, --status when no view
// says which select is the columns, --option "Value=Column" for a value no table should
// guess), and re-running is safe because each page body carries "Imported from Focalboard
// card <id>", which a rerun skips rather than duplicates.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  chooseFocalboardBoard,
  parseFocalboardArchive,
  parseFocalboardLines,
  readFocalboardBoard,
  resolveStatusProperty,
} from "../shared/import-sources.mjs";
import {
  applyPages,
  fail,
  loadProject,
  parseMappingFlags,
  planBoardRows,
  readBoardState,
  report,
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

  let boards;
  let chosen;
  let statusProperty;
  try {
    boards = readBoards(archivePath);
    const choice = chooseFocalboardBoard(boards, flags.board);
    if (choice.boards) {
      fail(
        `The archive holds ${choice.boards.length} boards and a Grimoire project is one board's worth of work - pick one with --board:\n${choice.boards
          .map((candidate) => `  ${candidate.id}  ${candidate.title}`)
          .join("\n")}`,
      );
    }
    chosen = choice.chosen;
    const resolved = resolveStatusProperty(chosen.board, chosen.blocks, flags.status);
    if (resolved.selects) {
      fail(
        `Cannot tell which property holds the board's columns - pass --status with one of: ${
          resolved.selects.map((name) => `"${name}"`).join(", ") || "(the board has no select properties)"
        }`,
      );
    }
    statusProperty = resolved.property;
  } catch (error) {
    fail(error.message);
  }

  const reading = readFocalboardBoard(chosen, {
    optionMappings: parseMappingFlags(flags.option, "--option"),
    statusProperty,
  });

  const { createdBy } = loadProject(databasePath, flags.project, flags.as);
  const projectDirectory = join(pagesDirectory, flags.project);
  const boardState = readBoardState(projectDirectory, MARKER_PATTERN);

  // Categories go deliberately unmapped: Focalboard has no card-type notion to translate,
  // and a guessed category is worse than none.
  const { planned, errors, warnings, skipped } = planBoardRows(reading, {
    categories: [],
    createdBy,
    boardState,
  });
  for (const { value } of reading.unmappedOptions) {
    errors.push(
      `option "${value}" of "${statusProperty.name}": no column matches this value - say where its cards land with --option "${value}=Backlog|Up Next|In progress|Review|Done"`,
    );
  }

  report({ total: reading.total, planned, skipped, warnings, errors });
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

/** A directory is walked for every board.jsonl it holds; a file is the archive itself. */
function readBoards(archivePath) {
  if (!statSync(archivePath).isDirectory()) {
    return parseFocalboardArchive(readFileSync(archivePath));
  }
  const boards = [];
  for (const entry of readdirSync(archivePath, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "board.jsonl") {
      const path = join(entry.parentPath, entry.name);
      boards.push(parseFocalboardLines(readFileSync(path, "utf8"), path));
    }
  }
  if (boards.length === 0) fail(`No board.jsonl anywhere under ${archivePath}`);
  return boards;
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
