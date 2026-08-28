import { useMemo, useState } from "react";
import { Drawer } from "./Drawer";
import { type Page, type PageCategory, type Chapter, type Member, type ProjectCategory } from "../../shared/types";
import { categoryDisplay, categoryStyle } from "./category-style";
import { plainTextFromMarkdown } from "./markdown-text";
import { useTypingFocus } from "./use-typing-focus";
import { Growing } from "./Growing";

type Props = {
  allPages: Page[];
  busy: boolean;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  members: Member[];
  /** The chapter the board is looking at, which is the one a pull adds to. */
  targetChapter: string | null;
  onClose: () => void;
  onMoveToNext: (id: string) => Promise<void>;
  onOpenPage: (id: string) => void;
  onSetChapter: (id: string, chapter: string | null) => Promise<void>;
};

/** Which chapter a library row must belong to: any, a named one, or none yet. */
type ChapterChoice = string | null | "unplaced";

export function BacklogDialog({ allPages, busy, pages, categories, chapters, members, targetChapter, onClose, onMoveToNext, onOpenPage, onSetChapter }: Props) {
  const focusForTyping = useTypingFocus<HTMLInputElement>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PageCategory | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [chapterFilter, setChapterFilter] = useState<ChapterChoice>(null);
  const [showClosedChapters, setShowClosedChapters] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const target = chapters.find((chapter) => chapter.slug === targetChapter);
  const activeChapters = chapters.filter((chapter) => chapter.state !== "closed");
  const closedChapters = chapters.filter((chapter) => chapter.state === "closed");
  const usedCategories = useMemo(
    () => [...new Set(pages.map((page) => page.category).filter((value): value is PageCategory => Boolean(value)))],
    [pages],
  );
  const visiblePages = useMemo(
    () => pages
      .filter((page) => {
        if (category && page.category !== category) return false;
        if (person && (page.assigneeId ?? "unassigned") !== person) return false;
        if (blockedOnly && !isBlocked(page, allPages)) return false;
        if (chapterFilter === "unplaced" && page.chapter !== null) return false;
        if (chapterFilter !== null && chapterFilter !== "unplaced" && page.chapter !== chapterFilter) return false;
        return !normalizedQuery || pageText(page).includes(normalizedQuery);
      })
      .sort((left, right) => left.position - right.position),
    [allPages, blockedOnly, pages, category, chapterFilter, normalizedQuery, person],
  );

  return (
    <Drawer backdropClassName="library-backdrop" className="library-dialog" labelledBy="backlog-dialog-title" onClose={onClose}>
      <header className="dialog-header library-header">
        <div>
          <p className="eyebrow">work library</p>
          <h2 id="backlog-dialog-title">Backlog</h2>
          <p>
            {pages.length} accepted page{pages.length === 1 ? "" : "s"} outside the active deck
            {target && ` · ${pages.filter((page) => page.chapter === target.slug).length} already in ${target.name}`}
          </p>
        </div>
        <button aria-label="Close backlog" className="icon-button" onClick={onClose} type="button">×</button>
      </header>

      <div className="library-tools">
        <label className="library-search">
          <span className="sr-only">Search backlog</span>
          <input
            aria-label="Search backlog"
            ref={focusForTyping}
            id="backlog-search"
            name="backlogSearch"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the backlog..."
            type="search"
            value={query}
          />
        </label>
        <div aria-label="Backlog filters" className="library-filters">
          <button aria-pressed={blockedOnly} className={blockedOnly ? "active" : ""} onClick={() => setBlockedOnly((value) => !value)} type="button">blocked</button>
          <button aria-pressed={person === "unassigned"} className={person === "unassigned" ? "active" : ""} onClick={() => setPerson(person === "unassigned" ? null : "unassigned")} type="button">unassigned</button>
          {members.map((member) => (
            <button
              aria-pressed={person === member.id}
              className={person === member.id ? "active" : ""}
              key={member.id}
              onClick={() => setPerson(person === member.id ? null : member.id)}
              type="button"
            >{member.name}</button>
          ))}
        </div>
        {chapters.length > 0 && (
          <div aria-label="Backlog chapters" className="library-filters chapter-filters">
            <span className="library-filter-label">chapter</span>
            <button aria-pressed={chapterFilter === null} className={chapterFilter === null ? "active" : ""} onClick={() => setChapterFilter(null)} type="button">any</button>
            {activeChapters.map((chapter) => (
              <button
                aria-pressed={chapterFilter === chapter.slug}
                className={chapterFilter === chapter.slug ? "active" : ""}
                key={chapter.slug}
                onClick={() => setChapterFilter(chapterFilter === chapter.slug ? null : chapter.slug)}
                type="button"
              >{chapter.name}</button>
            ))}
            {closedChapters.length > 0 && (
              <Growing className="library-chapter-fold">
                <button
                  aria-expanded={showClosedChapters}
                  className="library-chapter-fold-toggle"
                  onClick={() => setShowClosedChapters((shown) => !shown)}
                  type="button"
                >
                  earlier <span>{closedChapters.length}</span>
                  <span aria-hidden="true">{showClosedChapters ? "▾" : "▸"}</span>
                </button>
                {showClosedChapters && closedChapters.map((chapter) => (
                  <button
                    aria-pressed={chapterFilter === chapter.slug}
                    className={chapterFilter === chapter.slug ? "active" : ""}
                    key={chapter.slug}
                    onClick={() => setChapterFilter(chapterFilter === chapter.slug ? null : chapter.slug)}
                    type="button"
                  >{chapter.name}</button>
                ))}
              </Growing>
            )}
            <button aria-pressed={chapterFilter === "unplaced"} className={chapterFilter === "unplaced" ? "active" : ""} onClick={() => setChapterFilter(chapterFilter === "unplaced" ? null : "unplaced")} type="button">no chapter</button>
          </div>
        )}
        {usedCategories.length > 0 && (
          <div aria-label="Backlog categories" className="library-filters category-filters">
            {usedCategories.map((value) => (
              <button
                aria-pressed={category === value}
                className={category === value ? "active" : ""}
                key={value}
                onClick={() => setCategory(category === value ? null : value)}
                type="button"
              ><span className="category-swatch" style={categoryStyle(categories, value)} />{categoryDisplay(categories, value)}</button>
            ))}
          </div>
        )}
      </div>

      <div className="library-results" aria-live="polite">
        {visiblePages.map((page) => (
          <article className={`library-page ${page.category ? "" : "category-none"}`} key={page.id} style={categoryStyle(categories, page.category)}>
            <button className="library-page-main" onClick={() => onOpenPage(page.id)} type="button">
              <span className="library-page-signals">
                {page.category && <span className="category-pill">{categoryDisplay(categories, page.category)}</span>}
                {isBlocked(page, allPages) && <span className="page-blocked">blocked</span>}
              </span>
              <strong>{page.title}</strong>
              {page.description && <p>{plainTextFromMarkdown(page.description)}</p>}
              <span>{page.assigneeName ?? "unassigned"}</span>
            </button>
            <div className="library-page-actions">
              {/* Placing a page in a chapter leaves it in the Backlog. Committing to a
                  stretch and being ready to start are separate decisions, which is what
                  keeps Up Next the small set someone can pick up now. */}
              {target && (
                page.chapter === target.slug ? (
                  <button
                    aria-label={`Remove ${page.title} from ${target.name}`}
                    className="library-chapter in"
                    disabled={busy}
                    onClick={() => void onSetChapter(page.id, null)}
                    type="button"
                  >in {target.name}</button>
                ) : (
                  <button
                    aria-label={`Add ${page.title} to ${target.name}`}
                    className="library-chapter"
                    disabled={busy}
                    onClick={() => void onSetChapter(page.id, target.slug)}
                    type="button"
                  >+ {target.name}</button>
                )
              )}
              <button
                aria-label={`Move ${page.title} to Up Next`}
                className="library-promote"
                disabled={busy}
                onClick={() => void onMoveToNext(page.id)}
                type="button"
              >up next <span aria-hidden="true">→</span></button>
            </div>
          </article>
        ))}
        {visiblePages.length === 0 && (
          <div className="library-empty">
            <strong>{pages.length === 0 ? "The backlog is clear." : "No pages match these filters."}</strong>
            <span>{pages.length === 0 ? "Capture work above whenever something earns a place here." : "Try a broader search or remove a filter."}</span>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function pageText(page: Page): string {
  return `${page.title}\n${page.description}\n${page.category ?? "uncategorized"}\n${page.assigneeName ?? "unassigned"}`.toLowerCase();
}

function isBlocked(page: Page, allPages: Page[]): boolean {
  return page.blockedBy.some((id) => allPages.some((candidate) => candidate.id === id && candidate.status !== "done"));
}
