import { randomUUID } from "node:crypto";
import {
  COLUMN_TO_STATUS,
  chooseFocalboardBoard,
  type ImportRow,
  normalizeColumnName,
  parseFocalboardArchive,
  readFocalboardBoard,
  readTrelloBoard,
  resolveStatusProperty,
} from "../shared/import-sources.mjs";
import type { ImportPlan, ImportSource, PageStatus } from "../shared/types";
import { PAGE_STATUSES } from "../shared/types";
import { HttpError } from "./http";
import type { MarkdownPageStore, StoredPage } from "./markdown-pages";

/*
 * The in-app half of a board import: the same readers the offline scripts run
 * (shared/import-sources.mjs), landed through the real MarkdownPageStore instead of a
 * mirrored serializer. The contract carries over whole - plan first and write nothing,
 * refuse to apply while anything is unmapped, skip what an earlier run already imported -
 * and where the CLI turns an unmapped name into an error naming a flag, this returns it as
 * data for the settings screen to turn into a dropdown.
 */

export type ImportMappings = {
  /** "List name" -> column label, the same right-hand side the CLI flags take. */
  lists: Record<string, string>;
  /** "Option value" -> column label, for a Focalboard status property. */
  options: Record<string, string>;
  /** The property holding the columns, when no board view says so. */
  status: string | null;
  /** The board to import from a multi-board archive. */
  board: string | null;
};

const MARKERS: Record<ImportSource, RegExp> = {
  trello: /^Imported from Trello card ([0-9a-f]{24})\b/m,
  focalboard: /^Imported from Focalboard card ([A-Za-z0-9_-]+)\b/m,
};

type PlanInput = {
  source: ImportSource;
  data: Buffer;
  mappings: ImportMappings;
  pageStore: MarkdownPageStore;
  projectSlug: string;
  categories: Array<{ slug: string; name: string }>;
  createdBy: string;
};

export function planBoardImport(input: PlanInput): { plan: ImportPlan; pages: StoredPage[] } {
  const plan: ImportPlan = {
    total: 0,
    toCreate: [],
    skipped: [],
    warnings: [],
    errors: [],
    unmappedLists: [],
    unmappedOptions: [],
    boards: null,
    statusChoices: null,
  };

  let reading: ReturnType<typeof readTrelloBoard> | ReturnType<typeof readFocalboardBoard>;
  if (input.source === "trello") {
    let board: unknown;
    try {
      board = JSON.parse(input.data.toString("utf8"));
    } catch {
      throw new HttpError(400, "That file is not JSON - export the board with Export as JSON in Trello");
    }
    try {
      const trello = readTrelloBoard(board, { listMappings: toStatusMap(input.mappings.lists) });
      plan.unmappedLists = trello.unmappedLists;
      reading = trello;
    } catch (error) {
      throw new HttpError(400, reason(error));
    }
  } else {
    try {
      const boards = parseFocalboardArchive(input.data);
      const choice = chooseFocalboardBoard(boards, input.mappings.board);
      if (choice.boards) {
        plan.boards = choice.boards;
        return { plan, pages: [] };
      }
      const resolved = resolveStatusProperty(
        choice.chosen.board,
        choice.chosen.blocks,
        input.mappings.status,
      );
      if (resolved.selects) {
        plan.statusChoices = resolved.selects;
        return { plan, pages: [] };
      }
      const focalboard = readFocalboardBoard(choice.chosen, {
        optionMappings: toStatusMap(input.mappings.options),
        statusProperty: resolved.property,
      });
      plan.unmappedOptions = focalboard.unmappedOptions;
      reading = focalboard;
    } catch (error) {
      throw new HttpError(400, reason(error));
    }
  }

  plan.total = reading.total;
  plan.errors.push(...reading.errors);
  plan.warnings.push(...reading.warnings);
  plan.skipped.push(...reading.skipped);

  // What the board already holds, read through the real store: markers make a rerun skip
  // rather than duplicate, and positions append after the pages each column already has.
  const marker = MARKERS[input.source];
  const active = input.pageStore.list(input.projectSlug);
  const archived = input.pageStore.listArchived(input.projectSlug);
  const alreadyImported = new Set<string>();
  const existingTitles = new Set<string>();
  for (const page of [...active, ...archived]) {
    existingTitles.add(page.title.toLowerCase());
    const imported = page.description.match(marker);
    if (imported?.[1]) alreadyImported.add(imported[1]);
  }
  const positionCursor = new Map<PageStatus, number>(PAGE_STATUSES.map((status) => [status, 0]));
  for (const page of active) {
    positionCursor.set(page.status, (positionCursor.get(page.status) ?? 0) + 1);
  }

  const pages: StoredPage[] = [];
  for (const row of reading.rows as ImportRow[]) {
    if (alreadyImported.has(row.sourceId)) {
      plan.skipped.push(`${row.label}: already on the board`);
      continue;
    }
    if (existingTitles.has(row.title.toLowerCase())) {
      plan.warnings.push(`${row.label}: a page with this title already exists (imported anyway)`);
    }
    const category =
      input.categories.find((candidate) =>
        row.labels.some((name) => name.toLowerCase() === candidate.name.toLowerCase()),
      )?.slug ?? null;
    const position = positionCursor.get(row.status) ?? 0;
    positionCursor.set(row.status, position + 1);
    existingTitles.add(row.title.toLowerCase());
    pages.push({
      id: randomUUID(),
      title: row.title,
      description: row.description,
      category,
      chapter: null,
      fields: {},
      blockedBy: [],
      unblockedPages: [],
      status: row.status,
      position,
      assignee: null,
      createdBy: input.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      archivedAt: null,
      github: null,
      estimate: null,
    });
  }

  plan.toCreate = pages.map((page) => ({ title: page.title, status: page.status }));
  return { plan, pages };
}

/** Whether a plan may apply: everything mapped, every board question answered, no errors. */
export function importBlockers(plan: ImportPlan): boolean {
  return (
    plan.errors.length > 0 ||
    plan.unmappedLists.length > 0 ||
    plan.unmappedOptions.length > 0 ||
    plan.boards !== null ||
    plan.statusChoices !== null
  );
}

export function applyBoardImport(
  pageStore: MarkdownPageStore,
  projectSlug: string,
  pages: StoredPage[],
): number {
  for (const page of pages) pageStore.save(projectSlug, page);
  return pages.length;
}

/** "List name=Column" records become the readers' normalized-name -> status maps. */
function toStatusMap(record: Record<string, string>): Map<string, PageStatus> {
  const map = new Map<string, PageStatus>();
  for (const [name, column] of Object.entries(record)) {
    const status = COLUMN_TO_STATUS[column.toLowerCase()];
    if (!status) {
      throw new HttpError(
        400,
        `"${column}" is not a column - use Backlog, Up Next, In progress, Review or Done`,
      );
    }
    map.set(normalizeColumnName(name), status);
  }
  return map;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
