import { useMemo, useState } from "react";
import type { Chapter, Member, Page, PageCategory, ProjectCategory } from "../../shared/types";
import { useTypingFocus } from "../hooks/use-typing-focus";
import { categoryDisplay, categoryStyle } from "../lib/category-style";
import { type ChapterFilter, matchesChapter, NO_CHAPTER } from "../lib/chapter-filter";
import { compareCompletion } from "../lib/page-order";
import { pageText } from "../lib/page-search";
import { Drawer } from "./Drawer";

type Props = {
  busy: boolean;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  chaptersEnabled: boolean;
  initialChapter: ChapterFilter;
  members: Member[];
  onClose: () => void;
  onOpenPage: (id: string) => void;
  onReopen: (id: string) => Promise<void>;
};

export function DoneHistoryDialog({
  busy,
  pages,
  categories,
  chapters,
  chaptersEnabled,
  initialChapter,
  members,
  onClose,
  onOpenPage,
  onReopen,
}: Props) {
  const focusForTyping = useTypingFocus<HTMLInputElement>();
  const [chapter, setChapter] = useState(initialChapter);
  const selectedChapter =
    chaptersEnabled && (chapter === NO_CHAPTER || chapters.some((value) => value.slug === chapter))
      ? chapter
      : null;
  const chapterPages = useMemo(
    () => pages.filter((page) => matchesChapter(page, selectedChapter)),
    [pages, selectedChapter],
  );
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PageCategory | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const usedCategories = useMemo(
    () => [
      ...new Set(pages.map((page) => page.category).filter((value): value is PageCategory => Boolean(value))),
    ],
    [pages],
  );
  const visiblePages = useMemo(
    () =>
      chapterPages
        .filter((page) => {
          if (category && page.category !== category) return false;
          if (person && (page.assigneeId ?? "unassigned") !== person) return false;
          return !normalizedQuery || pageText(page).includes(normalizedQuery);
        })
        .sort(compareCompletion),
    [chapterPages, category, normalizedQuery, person],
  );
  const groups = useMemo(() => groupByMonth(visiblePages), [visiblePages]);

  return (
    <Drawer
      backdropClassName="library-backdrop"
      className="library-dialog"
      labelledBy="history-dialog-title"
      onClose={onClose}
    >
      <header className="dialog-header library-header">
        <div>
          <p className="eyebrow">project record</p>
          <h2 id="history-dialog-title">Completed work</h2>
          <p>
            {chapterPages.length} finished page{chapterPages.length === 1 ? "" : "s"}
          </p>
        </div>
        <button aria-label="Close completed work" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="library-tools">
        {chaptersEnabled && (
          <label className="completed-chapter-filter">
            <span>chapter</span>
            <select
              aria-label="Completed work chapter"
              value={selectedChapter ?? ""}
              onChange={(event) => setChapter(event.target.value || null)}
            >
              <option value="">All work</option>
              {chapters.map((value) => (
                <option key={value.slug} value={value.slug}>
                  {value.name}
                  {value.state === "closed" ? " (closed)" : ""}
                </option>
              ))}
              <option value={NO_CHAPTER}>No chapter</option>
            </select>
          </label>
        )}
        <label className="library-search">
          <span className="sr-only">Search completed work</span>
          <input
            aria-label="Search completed work"
            ref={focusForTyping}
            id="completed-work-search"
            name="completedWorkSearch"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search completed work..."
            type="search"
            value={query}
          />
        </label>
        <div aria-label="Completed work filters" className="library-filters" role="group">
          <button
            aria-pressed={person === "unassigned"}
            className={person === "unassigned" ? "active" : ""}
            onClick={() => setPerson(person === "unassigned" ? null : "unassigned")}
            type="button"
          >
            unassigned
          </button>
          {members.map((member) => (
            <button
              aria-pressed={person === member.id}
              className={person === member.id ? "active" : ""}
              key={member.id}
              onClick={() => setPerson(person === member.id ? null : member.id)}
              type="button"
            >
              {member.name}
            </button>
          ))}
        </div>
        {usedCategories.length > 0 && (
          <div
            aria-label="Completed work categories"
            className="library-filters category-filters"
            role="group"
          >
            {usedCategories.map((value) => (
              <button
                aria-pressed={category === value}
                className={category === value ? "active" : ""}
                key={value}
                onClick={() => setCategory(category === value ? null : value)}
                type="button"
              >
                <span className="category-swatch" style={categoryStyle(categories, value)} />
                {categoryDisplay(categories, value)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="history-results" aria-live="polite">
        {groups.map(([label, groupPages]) => (
          <section className="history-group" key={label}>
            <header>
              <h3>{label}</h3>
              <span>{groupPages.length}</span>
            </header>
            <div>
              {groupPages.map((page) => (
                <article
                  className={`history-page ${page.category ? "" : "category-none"}`}
                  key={page.id}
                  style={categoryStyle(categories, page.category)}
                >
                  <button className="history-page-main" onClick={() => onOpenPage(page.id)} type="button">
                    <span
                      className={`category-swatch ${page.category ? "" : "category-none"}`}
                      style={categoryStyle(categories, page.category)}
                    />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.assigneeName ?? "unassigned"}</small>
                    </span>
                    <time dateTime={page.completedAt ?? page.updatedAt}>{formatCompletion(page)}</time>
                  </button>
                  <button
                    aria-label={`Move ${page.title} to Up Next`}
                    className="history-reopen"
                    disabled={busy}
                    onClick={() => void onReopen(page.id)}
                    type="button"
                  >
                    reopen
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
        {visiblePages.length === 0 && (
          <div className="library-empty">
            <strong>
              {chapterPages.length === 0 ? "Nothing finished yet." : "No completed pages match."}
            </strong>
            <span>
              {chapterPages.length === 0
                ? "Finished work will collect here automatically."
                : "Try a broader search or remove a filter."}
            </span>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function groupByMonth(pages: Page[]): Array<[string, Page[]]> {
  const groups = new Map<string, Page[]>();
  const formatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  for (const page of pages) {
    const label = formatter.format(new Date(page.completedAt ?? page.updatedAt));
    groups.set(label, [...(groups.get(label) ?? []), page]);
  }
  return [...groups.entries()];
}

function formatCompletion(page: Page): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(page.completedAt ?? page.updatedAt),
  );
}
