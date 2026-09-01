#!/usr/bin/env node
// Imports a Trello board into a Grimoire project, offline.
//
// The input is Trello's own export (board menu -> Print, export, and share -> Export as JSON),
// taken whole - nothing to reshape first, because asking a migrating user to write an import
// map is asking them not to migrate. This is the sanctioned bulk path from
// docs/architecture.md ("Bulk import"): page markdown is written directly into the data
// directory with the server stopped, so the import neither fights the write rate limit nor
// half-lands if something is wrong.
//
//   node ops/import-trello.mjs <trello-export.json> <pages-directory> <database> \
//     --project <slug> [--as <email>] [--list "Name=Column"]... [--apply]
//
// <pages-directory> is GRIMOIRE_PAGES_DIRECTORY (in production, the ./data/cards mount) and
// <database> is the grimoire.sqlite beside it. Without --apply it validates every card,
// prints what it would create, and writes nothing. STOP THE SERVER BEFORE --apply: the server
// caches nothing, but two writers assigning positions to the same column is a race.
//
// Decisions, and their reasons:
//   - Trello lists are free-form and Grimoire's five columns are not, so list names resolve
//     through the shared synonym table (Doing -> In progress, Icebox -> Backlog, ...). A list
//     the table does not recognise is an ERROR naming the list, never a guess: the fix is one
//     --list "Name=Column" flag per unrecognised list, and an explicit flag always beats the
//     table. Only lists that still hold cards need mapping - an empty leftover list should
//     not block a migration.
//   - archived cards and archived lists are skipped, not imported: Trello archived them out
//     of sight and an import that resurrects them onto a live board is worse than one that
//     leaves them behind. The skip is reported, so nothing vanishes silently.
//   - the first label whose name matches one of the project's categories becomes the page's
//     category, because a label named Bug on a board that has a Bug category is not a
//     coincidence. Every label, matched or not, is kept in the provenance footer - labels are
//     many and categories are one, so the footer is where the rest survive.
//   - card descriptions are already Markdown and are kept verbatim as the story; checklists
//     become task lists under their own headings, states preserved.
//   - created_at is decoded from the card id (Trello ids open with the creation time in hex),
//     and updated_at is the card's last activity. Trello records no completion time, so a
//     card landing in Done carries its last activity as the stated proxy - the alternative,
//     the import time, would order every page identically and mean nothing.
//   - member names go to the footer, never to assignee: the export carries usernames, not
//     the email addresses Grimoire members are known by, and a guessed assignment is a lie
//     with a name on it.
//
// Re-running is safe: each page body carries "Imported from Trello card <id>", and a card id
// already on the board (active or archived) is skipped, not duplicated.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

const MARKER_PATTERN = /^Imported from Trello card ([0-9a-f]{24})\b/m;
const TRELLO_ID_PATTERN = /^[0-9a-f]{24}$/;

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
  if (!Array.isArray(board.lists) || !Array.isArray(board.cards)) {
    fail(`${exportPath} is not a Trello board export: expected "lists" and "cards" arrays`);
  }
  const listOverrides = parseMappingFlags(flags.list, "--list");

  const { categories, createdBy } = loadProject(databasePath, flags.project, flags.as);
  const projectDirectory = join(pagesDirectory, flags.project);
  const { alreadyImported, existingTitles, positionCursor } = readBoardState(
    projectDirectory,
    MARKER_PATTERN,
  );

  const checklistsByCard = new Map();
  for (const checklist of board.checklists ?? []) {
    const forCard = checklistsByCard.get(checklist.idCard) ?? [];
    forCard.push(checklist);
    checklistsByCard.set(checklist.idCard, forCard);
  }
  const membersById = new Map((board.members ?? []).map((member) => [member.id, member]));

  const lists = [...board.lists].sort((a, b) => a.pos - b.pos);
  const listsById = new Map(lists.map((list) => [list.id, list]));
  const openCards = board.cards.filter(
    (card) =>
      !card.closed && !card.isTemplate && listsById.get(card.idList) && !listsById.get(card.idList).closed,
  );

  // Lists resolve before cards so an unrecognised name is reported once, as the list it is,
  // not once per card it holds.
  const statusByList = new Map();
  const errors = [];
  for (const list of lists) {
    if (list.closed) continue;
    const status = listOverrides.get(normalizeColumnName(list.name)) ?? statusForColumnName(list.name);
    if (status) {
      statusByList.set(list.id, status);
    } else if (openCards.some((card) => card.idList === list.id)) {
      errors.push(
        `list "${list.name}": no column matches this name - say where its cards land with --list "${list.name}=Backlog|Up Next|In progress|Review|Done"`,
      );
    }
  }

  const warnings = [];
  const skipped = [];
  const planned = [];
  const source = `${board.name ? `"${board.name}" ` : ""}Trello export ${basename(exportPath)}`;

  const cardsInOrder = [...board.cards].sort((a, b) => {
    const listOrder = (listsById.get(a.idList)?.pos ?? 0) - (listsById.get(b.idList)?.pos ?? 0);
    return listOrder !== 0 ? listOrder : a.pos - b.pos;
  });

  for (const card of cardsInOrder) {
    const list = listsById.get(card.idList);
    const label = `card ${card.id} "${String(card.name ?? "").slice(0, 50)}"`;
    if (!TRELLO_ID_PATTERN.test(String(card.id ?? ""))) {
      errors.push(`${label}: the card id is not a Trello id`);
      continue;
    }
    if (!list) {
      errors.push(`${label}: its list ${card.idList} is not in the export`);
      continue;
    }
    if (card.closed || list.closed) {
      skipped.push(
        `${label}: archived${list.closed ? ` with list "${list.name}"` : ""} in Trello, left behind`,
      );
      continue;
    }
    if (card.isTemplate) {
      skipped.push(`${label}: a card template, not work`);
      continue;
    }
    if (alreadyImported.has(card.id)) {
      skipped.push(`${label}: already on the board`);
      continue;
    }
    const status = statusByList.get(list.id);
    if (!status) continue; // the list itself is already an error above

    // Real exports carry card names with embedded newlines (found in the wild on a public
    // board); one line is the only honest board title, so whitespace collapses to spaces.
    let title = String(card.name ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 1) {
      errors.push(`${label}: the card has no name`);
      continue;
    }
    // A title past the board's 240-character limit is inherited, not assigned, so it is
    // shortened with a warning rather than refused - and survives whole as the story's
    // first line, so nothing is actually lost.
    let fullTitleLine = null;
    if (title.length > 240) {
      fullTitleLine = title;
      title = `${title.slice(0, 237)}...`;
      warnings.push(
        `${label}: the name is longer than 240 characters and was shortened (kept whole in the body)`,
      );
    }
    if (existingTitles.has(title.toLowerCase())) {
      warnings.push(`${label}: a page with this title already exists (imported anyway)`);
    }

    const cardLabels = (card.labels ?? [])
      .map((cardLabel) => String(cardLabel.name ?? "").trim())
      .filter(Boolean);
    const category =
      categories.find((candidate) =>
        cardLabels.some((name) => name.toLowerCase() === candidate.name.toLowerCase()),
      )?.slug ?? null;

    const createdAt = toIsoSeconds(Number.parseInt(card.id.slice(0, 8), 16) * 1000);
    const updatedAt =
      typeof card.dateLastActivity === "string" && !Number.isNaN(Date.parse(card.dateLastActivity))
        ? toIsoSeconds(Date.parse(card.dateLastActivity))
        : createdAt;

    const row = {
      title,
      category,
      status,
      createdAt,
      updatedAt,
      completedAt: status === "done" ? updatedAt : null,
      description: composeBody(card, {
        fullTitleLine,
        source,
        cardLabels,
        checklists: checklistsByCard.get(card.id) ?? [],
        membersById,
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

  report({ total: board.cards.length, planned, skipped, warnings, errors });
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
 * The story leads and the provenance is a footer, exactly the shape the Notion import
 * settled on: the description a person wrote stays theirs, checklists keep their headings
 * and their ticks, and everything Grimoire has no column for - labels, members, the due
 * date - is written down rather than dropped. "Imported from Trello card <id>" stays on a
 * line of its own: the re-run guard reads it with a multiline match, and a page that loses
 * it gets created a second time by the next import.
 */
function composeBody(card, { fullTitleLine, source, cardLabels, checklists, membersById }) {
  const story = [];
  if (fullTitleLine) story.push(fullTitleLine);
  const description = typeof card.desc === "string" ? card.desc.trim() : "";
  if (description) story.push(description);
  for (const checklist of [...checklists].sort((a, b) => a.pos - b.pos)) {
    const items = [...(checklist.checkItems ?? [])]
      .sort((a, b) => a.pos - b.pos)
      .map((item) => `- [${item.state === "complete" ? "x" : " "}] ${item.name}`);
    if (items.length > 0) story.push(`### ${checklist.name}\n\n${items.join("\n")}`);
  }

  const provenance = [`Imported from Trello card ${card.id} (${source}).`];
  if (cardLabels.length > 0) provenance.push(`Labels: ${cardLabels.join(", ")}.`);
  const members = (card.idMembers ?? [])
    .map((id) => membersById.get(id))
    .filter(Boolean)
    .map((member) => (member.fullName ? `${member.fullName} (@${member.username})` : `@${member.username}`));
  if (members.length > 0) provenance.push(`Members on the card: ${members.join(", ")}.`);
  if (typeof card.due === "string" && card.due) {
    provenance.push(`Due ${card.due.slice(0, 10)}${card.dueComplete ? ", marked complete" : ""}.`);
  }

  const storyText = story.join("\n\n");
  return storyText ? `${storyText}\n\n---\n\n${provenance.join("\n")}` : provenance.join("\n");
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
