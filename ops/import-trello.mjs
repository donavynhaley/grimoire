#!/usr/bin/env node
// Imports a Trello board into a Grimoire project, offline.
//
// The input is Trello's own export (board menu -> Print, export, and share -> Export as JSON),
// taken whole - nothing to reshape first, because asking a migrating user to write an import
// map is asking them not to migrate. This is the sanctioned bulk path from
// docs/architecture.md ("Bulk import"): page markdown is written directly into the data
// directory with the server stopped, so the import neither fights the write rate limit nor
// half-lands if something is wrong. The settings screen offers the same import through the
// server (docs/import-from-trello.md); this script remains the operator path, for boards too
// big to upload and for seeding an instance that is not running yet.
//
//   node ops/import-trello.mjs <trello-export.json> <pages-directory> <database> \
//     --project <slug> [--as <email>] [--list "Name=Column"]... [--apply]
//
// <pages-directory> is GRIMOIRE_PAGES_DIRECTORY (in production, the ./data/cards mount) and
// <database> is the grimoire.sqlite beside it. Without --apply it validates every card,
// prints what it would create, and writes nothing. STOP THE SERVER BEFORE --apply: the server
// caches nothing, but two writers assigning positions to the same column is a race.
//
// How a board maps - the decisions and their reasons - is the readers' own record: see
// shared/import-sources.mjs, which this script shares with the server so the two paths can
// never drift. What is this script's own: an unrecognised list is an ERROR naming the one
// --list "Name=Column" flag that fixes it, and re-running is safe because each page body
// carries "Imported from Trello card <id>", which a rerun skips rather than duplicates.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readTrelloBoard } from "../shared/import-sources.mjs";
import {
  applyPages,
  fail,
  loadProject,
  parseMappingFlags,
  planBoardRows,
  readBoardState,
  report,
} from "./import-common.mjs";

const MARKER_PATTERN = /^Imported from Trello card ([0-9a-f]{24})\b/m;

function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  if (positional.length !== 3 || !flags.project) {
    console.error(
      "usage: node ops/import-trello.mjs <trello-export.json> <pages-directory> <database> " +
        '--project <slug> [--as <email>] [--list "Name=Column"]... [--apply]',
    );
    process.exit(2);
  }
  const [exportPath, pagesDirectory, databasePath] = positional;
  for (const path of [exportPath, databasePath]) {
    if (!existsSync(path)) fail(`No such file: ${path}`);
  }
  if (!existsSync(pagesDirectory)) fail(`No such directory: ${pagesDirectory}`);

  const board = JSON.parse(readFileSync(exportPath, "utf8"));
  let reading;
  try {
    reading = readTrelloBoard(board, {
      listMappings: parseMappingFlags(flags.list, "--list"),
      sourceLabel: `${board.name ? `"${board.name}" ` : ""}Trello export ${basename(exportPath)}`,
    });
  } catch (error) {
    fail(`${exportPath}: ${error.message}`);
  }

  const { categories, createdBy } = loadProject(databasePath, flags.project, flags.as);
  const projectDirectory = join(pagesDirectory, flags.project);
  const boardState = readBoardState(projectDirectory, MARKER_PATTERN);

  const { planned, errors, warnings, skipped } = planBoardRows(reading, {
    categories,
    createdBy,
    boardState,
  });
  for (const { name } of reading.unmappedLists) {
    errors.push(
      `list "${name}": no column matches this name - say where its cards land with --list "${name}=Backlog|Up Next|In progress|Review|Done"`,
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

function parseArguments(argv) {
  const positional = [];
  const flags = { apply: false, list: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") flags.apply = true;
    else if (argument === "--as" || argument === "--project" || argument === "--list") {
      const value = argv[index + 1];
      if (!value) fail(`${argument} needs a value`);
      if (argument === "--list") flags.list.push(value);
      else flags[argument.slice(2)] = value;
      index += 1;
    } else if (argument.startsWith("--")) fail(`Unknown flag: ${argument}`);
    else positional.push(argument);
  }
  return { positional, flags };
}

main();
