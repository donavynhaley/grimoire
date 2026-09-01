// Hand-written declarations for import-sources.mjs, which stays plain .mjs so the offline
// ops scripts can run it on bare node. The server type-checks against this surface.
import type { PageStatus } from "./types";

export declare const COLUMN_TO_STATUS: Record<string, PageStatus>;
export declare function normalizeColumnName(name: unknown): string;
export declare function statusForColumnName(name: unknown): PageStatus | undefined;
export declare function toIsoSeconds(milliseconds: number): string;

export type ImportRow = {
  sourceId: string;
  /** The "card <id> "<name>"" prefix warnings and errors carry, so refusals read the same everywhere. */
  label: string;
  title: string;
  /** Trello label names, for the board side to match against project categories. */
  labels: string[];
  status: PageStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  description: string;
};

export type ReaderResult = {
  total: number;
  rows: ImportRow[];
  errors: string[];
  warnings: string[];
  skipped: string[];
};

export type UnmappedName = { name: string; cards: number };
export type UnmappedOption = { value: string; cards: number };

export declare function readTrelloBoard(
  board: unknown,
  options?: { listMappings?: Map<string, PageStatus>; sourceLabel?: string },
): ReaderResult & { unmappedLists: UnmappedName[] };

export type FocalboardProperty = {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; value: string }>;
};
export type FocalboardBoard = {
  board: { id: string; title?: string; cardProperties?: FocalboardProperty[] };
  blocks: Array<Record<string, unknown>>;
};

export declare function parseFocalboardArchive(input: Buffer | string): FocalboardBoard[];
export declare function parseFocalboardLines(text: string, sourceName: string): FocalboardBoard;
export declare function chooseFocalboardBoard(
  boards: FocalboardBoard[],
  choice?: string | null,
):
  | { chosen: FocalboardBoard; boards?: undefined }
  | { chosen?: undefined; boards: Array<{ id: string; title: string }> };
export declare function resolveStatusProperty(
  board: FocalboardBoard["board"],
  blocks: FocalboardBoard["blocks"],
  statusName?: string | null,
): { property: FocalboardProperty; selects?: undefined } | { property?: undefined; selects: string[] };
export declare function readFocalboardBoard(
  source: FocalboardBoard,
  options: { optionMappings?: Map<string, PageStatus>; statusProperty: FocalboardProperty },
): ReaderResult & { unmappedOptions: UnmappedOption[] };
