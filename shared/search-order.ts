import { SEARCH_GROUPS, type SearchHit, type SearchResults, type SearchScope } from "./types";

export const SEARCH_RESULT_LIMIT = 40;
export type RankedSearchHit = { hit: SearchHit; rank: number; recency: string };

export function matchSearchRank(title: string, description: string, needle: string): number | null {
  const lower = title.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return description.toLowerCase().includes(needle) ? 3 : null;
}

/** Rank before capping; grouping is presentation, never a reason to lose an exact match. */
export function searchWindow(
  ranked: RankedSearchHit[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
  offset = 0,
  scope: SearchScope = "all",
): SearchResults {
  const matches = ranked.filter(({ hit }) => scope === "all" || hit.group === scope);
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      SEARCH_GROUPS.indexOf(a.hit.group) - SEARCH_GROUPS.indexOf(b.hit.group) ||
      b.recency.localeCompare(a.recency) ||
      a.hit.id.localeCompare(b.hit.id),
  );
  const hits = matches.slice(offset, offset + limit).map(({ hit }) => hit);
  const next = offset + hits.length;
  return { query, total: matches.length, hits, ...(next < matches.length ? { nextOffset: next } : {}) };
}
