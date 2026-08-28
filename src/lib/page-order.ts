import type { Page } from "../../shared/types";

/**
 * How finished work is ordered wherever it is listed: most recently completed first, so
 * the Done column and the history read as one record. Pages finished before completion
 * was stamped fall back to their last edit, and a shared instant falls back to board
 * position so the order never shuffles between renders.
 */
export function compareCompletion(left: Page, right: Page): number {
  const timestamp = (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
  return timestamp || right.position - left.position;
}
