import type { Page } from "../../shared/types";

/**
 * Everything a filter box can match a page on, as one lowercase string - the unset values
 * included under the names the screen shows for them, so typing "unassigned" finds what
 * reads as unassigned.
 */
export function pageText(page: Page): string {
  return `${page.title}\n${page.description}\n${page.category ?? "uncategorized"}\n${page.assigneeName ?? "unassigned"}`.toLowerCase();
}
