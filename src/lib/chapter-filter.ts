import type { Page } from "../../shared/types";

/** Null means all work; the URL reserves "none" for pages without a chapter. */
export type ChapterFilter = string | null;
export const NO_CHAPTER = "none";

export function matchesChapter(page: Pick<Page, "chapter">, chapter: ChapterFilter): boolean {
  return chapter === null || page.chapter === (chapter === NO_CHAPTER ? null : chapter);
}
