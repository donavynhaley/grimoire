// Reading another tool's board export: the source-side half of every importer, held once.
//
// Two consumers share this file and neither may own it. The offline ops scripts
// (ops/import-trello.mjs, ops/import-focalboard.mjs) run on plain node with no build step,
// so this is dependency-free .mjs rather than TypeScript; the server's in-app import
// (server/import-board.ts) type-checks against the hand-written declarations beside it.
// The readers return structure, not prose: an unmapped list or status option comes back as
// data naming the thing and the cards it holds, and each consumer turns that into its own
// refusal - the CLI into an error naming the flag, the settings screen into a dropdown.
//
// What a reader owns: parsing the export, the synonym table, and every inherited-data
// accommodation (shortening a 300-character title, carrying a blank one as "Untitled",
// collapsing a newline). What it deliberately does not know: the project it lands in.
// Markers, duplicate skips, positions and category resolution are the board side's, because
// they need the board.

import { inflateRawSync } from "node:zlib";

/**
 * The names a person may write on the right side of a mapping ("Name=Column"), exactly the
 * board's own column labels plus the older "Waiting for Review" the Notion import map honours.
 */
export const COLUMN_TO_STATUS = {
  backlog: "backlog",
  "up next": "ready",
  "in progress": "in_progress",
  review: "review",
  "waiting for review": "review",
  done: "done",
};

/**
 * The column-name synonyms every importer shares, so "Doing" on a Trello board and "In
 * Progress" on a Focalboard one land the same way. Names are normalized (lowercased, emoji
 * and punctuation stripped) before lookup, matched whole - "Done ✅" maps, "Done and archived"
 * does not, because guessing from a fragment is how someone's "Review later" list lands in
 * Review. An unmapped name is the caller's refusal to raise, never a silent drop.
 */
const STATUS_SYNONYMS = new Map([
  ...[
    "backlog",
    "icebox",
    "ideas",
    "inbox",
    "someday",
    "later",
    "wishlist",
    "not started",
    "parking lot",
  ].map((name) => [name, "backlog"]),
  ...["to do", "todo", "up next", "next", "next up", "ready", "this week", "planned", "sprint"].map(
    (name) => [name, "ready"],
  ),
  ...["in progress", "doing", "wip", "in work", "in development", "in dev", "current", "started"].map(
    (name) => [name, "in_progress"],
  ),
  ...["review", "in review", "code review", "waiting for review", "testing", "qa", "verify"].map((name) => [
    name,
    "review",
  ]),
  ...["done", "complete", "completed", "finished", "shipped", "released", "live"].map((name) => [
    name,
    "done",
  ]),
]);

export function normalizeColumnName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function statusForColumnName(name) {
  return STATUS_SYNONYMS.get(normalizeColumnName(name));
}

export function toIsoSeconds(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One line is the only honest board title, whatever whitespace the export carried. */
function normalizeTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Applies the shared title accommodations and returns { title, fullTitleLine } - the second
 * set when the title had to be shortened, so the caller can keep the whole thing as the
 * story's first line and nothing is actually lost.
 */
function boundedTitle(raw, label, warnings, kind) {
  let title = normalizeTitle(raw);
  let fullTitleLine = null;
  if (title.length > 240) {
    fullTitleLine = title;
    title = `${title.slice(0, 237)}...`;
    warnings.push(
      `${label}: the ${kind} is longer than 240 characters and was shortened (kept whole in the body)`,
    );
  }
  return { title, fullTitleLine };
}

// --- Trello -------------------------------------------------------------------------------

const TRELLO_ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Reads Trello's own board export (the JSON the board menu hands out), whole.
 *
 * `listMappings` maps normalized list names to statuses and beats the synonym table.
 * A list the table has no name for comes back in `unmappedLists`, with its live card count,
 * but only when it still holds cards - an empty leftover list should not block a migration.
 * Archived cards, archived lists and card templates are skipped, reported, never imported.
 */
export function readTrelloBoard(board, { listMappings = new Map(), sourceLabel } = {}) {
  if (!Array.isArray(board.lists) || !Array.isArray(board.cards)) {
    throw new Error('Not a Trello board export: expected "lists" and "cards" arrays');
  }
  const source = sourceLabel ?? `${board.name ? `"${board.name}" ` : ""}Trello export`;

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

  // Lists resolve before cards so an unrecognised name surfaces once, as the list it is,
  // not once per card it holds.
  const statusByList = new Map();
  const unmappedLists = [];
  for (const list of lists) {
    if (list.closed) continue;
    const status = listMappings.get(normalizeColumnName(list.name)) ?? statusForColumnName(list.name);
    if (status) {
      statusByList.set(list.id, status);
    } else {
      const cards = openCards.filter((card) => card.idList === list.id).length;
      if (cards > 0) unmappedLists.push({ name: list.name, cards });
    }
  }

  const rows = [];
  const errors = [];
  const warnings = [];
  const skipped = [];
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
    const status = statusByList.get(list.id);
    if (!status) continue; // the list itself is already in unmappedLists

    const { title, fullTitleLine } = boundedTitle(card.name, label, warnings, "name");
    if (title.length < 1) {
      errors.push(`${label}: the card has no name`);
      continue;
    }

    const cardLabels = (card.labels ?? [])
      .map((cardLabel) => String(cardLabel.name ?? "").trim())
      .filter(Boolean);

    // Trello ids open with the creation time in hex, so created_at is decoded rather than
    // invented; Trello records no completion time, so a Done card carries its last activity
    // as the stated proxy - the import time would order every page identically.
    const createdAt = toIsoSeconds(Number.parseInt(card.id.slice(0, 8), 16) * 1000);
    const updatedAt =
      typeof card.dateLastActivity === "string" && !Number.isNaN(Date.parse(card.dateLastActivity))
        ? toIsoSeconds(Date.parse(card.dateLastActivity))
        : createdAt;

    rows.push({
      sourceId: card.id,
      label,
      title,
      labels: cardLabels,
      status,
      createdAt,
      updatedAt,
      completedAt: status === "done" ? updatedAt : null,
      description: composeTrelloBody(card, {
        fullTitleLine,
        source,
        cardLabels,
        checklists: checklistsByCard.get(card.id) ?? [],
        membersById,
      }),
    });
  }

  return { total: board.cards.length, rows, unmappedLists, errors, warnings, skipped };
}

/**
 * The story leads and the provenance is a footer: the description a person wrote stays
 * theirs, checklists keep their headings and their ticks, and everything Grimoire has no
 * column for - labels, members, the due date - is written down rather than dropped.
 * "Imported from Trello card <id>" stays on a line of its own: the re-run guard reads it
 * with a multiline match, and a page that loses it gets created a second time.
 */
function composeTrelloBody(card, { fullTitleLine, source, cardLabels, checklists, membersById }) {
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

// --- Focalboard ---------------------------------------------------------------------------

/**
 * Parses a .boardarchive (a zip, sniffed by its PK header) or a bare board.jsonl text into
 * the boards it holds. Throws with a readable reason on anything that is not one of those.
 */
export function parseFocalboardArchive(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const boards = [];
    for (const [name, read] of readZip(buffer)) {
      if (name.endsWith("board.jsonl")) boards.push(parseFocalboardLines(read().toString("utf8"), name));
    }
    if (boards.length === 0)
      throw new Error("The archive holds no board.jsonl - is it a Focalboard board archive?");
    return boards;
  }
  return [parseFocalboardLines(buffer.toString("utf8"), "board.jsonl")];
}

export function parseFocalboardLines(text, sourceName) {
  let board = null;
  const blocks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${sourceName}: a line is not JSON - is this a Focalboard board.jsonl?`);
    }
    if (parsed.type === "board" && parsed.data) {
      if (board) throw new Error(`${sourceName}: holds more than one board line`);
      board = parsed.data;
    } else if (parsed.type === "block" && parsed.data) {
      blocks.push(parsed.data);
    }
  }
  if (!board) throw new Error(`${sourceName}: no board line - is this a Focalboard board.jsonl?`);
  return { board, blocks };
}

/**
 * One board per run: a Grimoire project is one board's worth of work. Returns the chosen
 * board, or `{ boards }` naming what the archive holds when the choice is still a person's
 * to make. A named choice that matches nothing throws, because the name was a claim.
 */
export function chooseFocalboardBoard(boards, choice) {
  if (choice) {
    const chosen = boards.find(
      (candidate) =>
        candidate.board.id === choice || candidate.board.title?.toLowerCase() === choice.toLowerCase(),
    );
    if (!chosen) {
      throw new Error(
        `No board "${choice}" in the archive. It holds:\n${boards
          .map(({ board }) => `  ${board.id}  ${board.title || "(untitled)"}`)
          .join("\n")}`,
      );
    }
    return { chosen };
  }
  if (boards.length > 1) {
    return { boards: boards.map(({ board }) => ({ id: board.id, title: board.title || "(untitled)" })) };
  }
  return { chosen: boards[0] };
}

/**
 * A board's status property, found the way the board itself presents columns: the property
 * its board view groups by, else a select named "Status", else the only select there is.
 * Anything less determined returns `{ selects }` for the caller to put to a person, because
 * every card's column hangs on this one choice. A named property that is missing or not a
 * select throws, because the name was a claim.
 */
export function resolveStatusProperty(board, blocks, statusName) {
  const selects = (board.cardProperties ?? []).filter((property) => property.type === "select");
  if (statusName) {
    const named = (board.cardProperties ?? []).find(
      (property) => property.name.toLowerCase() === statusName.toLowerCase(),
    );
    if (!named) throw new Error(`The board has no property named "${statusName}"`);
    if (named.type !== "select") {
      throw new Error(`Property "${named.name}" is a ${named.type}, not a select - columns need a select`);
    }
    return { property: named };
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
    if (grouped) return { property: grouped };
  }
  const named = selects.find((property) => normalizeColumnName(property.name) === "status");
  if (named) return { property: named };
  if (selects.length === 1) return { property: selects[0] };
  return { selects: selects.map((property) => property.name) };
}

/**
 * Reads one Focalboard board's cards against a chosen status property. `optionMappings`
 * maps normalized option values to statuses and beats the synonym table; an option the
 * table has no name for comes back in `unmappedOptions` with its live card count, but only
 * when a card actually holds it. A card with no status lands in Backlog - Focalboard shows
 * those under "No status", and Backlog is that group's honest translation.
 */
export function readFocalboardBoard({ board, blocks }, { optionMappings = new Map(), statusProperty } = {}) {
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

  const statusByOption = new Map();
  const unmappedOptions = [];
  const optionsInUse = new Map();
  for (const card of cards) {
    if (card.fields?.isTemplate) continue;
    const value = card.fields?.properties?.[statusProperty.id];
    if (typeof value === "string" && value) optionsInUse.set(value, (optionsInUse.get(value) ?? 0) + 1);
  }
  for (const option of statusProperty.options ?? []) {
    const status = optionMappings.get(normalizeColumnName(option.value)) ?? statusForColumnName(option.value);
    if (status) {
      statusByOption.set(option.id, status);
    } else if (optionsInUse.has(option.id)) {
      unmappedOptions.push({ value: option.value, cards: optionsInUse.get(option.id) });
    }
  }

  const rows = [];
  const errors = [];
  const warnings = [];
  const skipped = [];
  const source = `${board.title ? `"${board.title}" ` : ""}Focalboard export`;

  for (const card of cards) {
    const rawTitle = normalizeTitle(card.title);
    const label = `card ${card.id} "${rawTitle.slice(0, 50)}"`;
    if (card.fields?.isTemplate) {
      skipped.push(`${label}: a card template, not work`);
      continue;
    }

    // Focalboard renders a blank title as "Untitled" rather than refusing it, so the import
    // does the same - inherited data gets carried, with a warning, not refused.
    const { title: bounded, fullTitleLine } = boundedTitle(card.title, label, warnings, "title");
    let title = bounded;
    if (title.length < 1) {
      title = "Untitled";
      warnings.push(`${label}: the card has no title, imported as "Untitled"`);
    }

    const statusValue = card.fields?.properties?.[statusProperty.id];
    let status = "backlog";
    if (typeof statusValue === "string" && statusValue) {
      const mapped = statusByOption.get(statusValue);
      if (mapped) {
        status = mapped;
      } else if (statusProperty.options?.some((option) => option.id === statusValue)) {
        continue; // the option itself is already in unmappedOptions
      } else {
        // A value pointing at an option that no longer exists is Focalboard's own loose end
        // (deleting an option leaves its id on cards); the board shows such cards under "No
        // status", so Backlog keeps faith with what the user last saw.
        warnings.push(`${label}: its status points at a deleted option, landed in Backlog`);
      }
    }

    const createdAt = toIsoSeconds(card.createAt ?? Date.now());
    const updatedAt = toIsoSeconds(card.updateAt ?? card.createAt ?? Date.now());
    rows.push({
      sourceId: card.id,
      label,
      title,
      labels: [],
      status,
      createdAt,
      updatedAt,
      completedAt: status === "done" ? updatedAt : null,
      description: composeFocalboardBody(card, {
        fullTitleLine,
        source,
        board,
        statusProperty,
        blocksById,
        children: childrenByParent.get(card.id) ?? [],
      }),
    });
  }

  return { total: cards.length, rows, unmappedOptions, errors, warnings, skipped };
}

/**
 * The card's own content leads, walked in its contentOrder, and the provenance is a footer.
 * "Imported from Focalboard card <id>" stays on a line of its own for the re-run guard.
 */
function composeFocalboardBody(card, { fullTitleLine, source, board, statusProperty, blocksById, children }) {
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
    const rendered = renderFocalboardProperty(property, card.fields?.properties?.[property.id]);
    if (rendered !== null) provenance.push(`${property.name}: ${rendered}.`);
  }
  const comments = children.filter((block) => block.type === "comment" && !(block.deleteAt > 0)).length;
  if (comments > 0) provenance.push(`${comments} comment${comments === 1 ? "" : "s"} not imported.`);
  if (notImported > 0) {
    provenance.push(`${notImported} attachment/other block${notImported === 1 ? "" : "s"} not imported.`);
  }

  const storyText = story.join("\n\n");
  return storyText ? `${storyText}\n\n---\n\n${provenance.join("\n")}` : provenance.join("\n");
}

function renderFocalboardProperty(property, raw) {
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
 * The smallest honest zip reader: entries come from the central directory, which always
 * carries names, sizes and offsets even when the writer streamed (local headers then lack
 * sizes and are followed by data descriptors - reading them would need guesswork, reading
 * the directory needs none). Only stored and deflated entries exist in practice, and
 * deflate is Node's own zlib. Decompression is behind a thunk so a board archive's images,
 * which the importer never reads, are never inflated.
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
  if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error("Corrupt zip central directory");
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
      throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
