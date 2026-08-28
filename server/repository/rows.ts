import type { DatabaseSync } from "node:sqlite";

// The untyped SQLite read helpers the repository modules share; internal to
// server/repository/, not part of the repository's public surface.

export type Row = Record<string, string | number | null>;

export function rows(database: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return database.prepare(sql).all(...params) as Row[];
}

export function row(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): Row | undefined {
  return database.prepare(sql).get(...params) as Row | undefined;
}
