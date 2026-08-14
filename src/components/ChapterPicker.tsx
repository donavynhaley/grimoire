import { useEffect, useRef, useState } from "react";
import type { Card, Chapter } from "../../shared/types";
import { chapterWhen } from "./chapter-dates";

/**
 * What the board is narrowed to: every card, one chapter, or the cards nobody has placed.
 * `null` means all work, which is always reachable so the picker can never hide the project.
 */
export type ChapterFilter = string | null;

/** The value the URL uses for "cards belonging to no chapter". */
export const NO_CHAPTER = "none";

type Props = {
  cards: Card[];
  chapters: Chapter[];
  isOwner: boolean;
  onChange: (value: ChapterFilter) => void;
  onManage: () => void;
  value: ChapterFilter;
};


export function ChapterPicker({ cards, chapters, isOwner, onChange, onManage, value }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = value === null || value === NO_CHAPTER
    ? undefined
    : chapters.find((chapter) => chapter.slug === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  const countIn = (slug: string) => cards.filter((card) => card.chapter === slug).length;
  const unplaced = cards.filter((card) => card.chapter === null).length;
  const planned = chapters.filter((chapter) => chapter.state === "planned");
  const closed = chapters.filter((chapter) => chapter.state === "closed");
  const current = chapters.find((chapter) => chapter.state === "open");

  const label = value === NO_CHAPTER ? "No chapter" : selected?.name ?? "All work";
  const when = value === NO_CHAPTER ? `${unplaced} unplaced` : selected ? chapterWhen(selected) : `${cards.length} cards`;

  const choose = (next: ChapterFilter) => {
    onChange(next);
    setOpen(false);
  };

  const option = (key: string, name: string, sub: string, count: number, next: ChapterFilter, isCurrent: boolean) => (
    <button
      aria-current={value === next ? "true" : undefined}
      className={`chapter-option ${isCurrent ? "current" : ""} ${value === next ? "selected" : ""}`}
      key={key}
      onClick={() => choose(next)}
      role="menuitem"
      type="button"
    >
      <span className="chapter-option-name">{name}<span className="chapter-option-sub">{sub}</span></span>
      <span className="chapter-option-count">{count}</span>
    </button>
  );

  return (
    <div className="chapter-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Filter by chapter, showing ${label}`}
        className={`chapter-trigger ${selected?.state === "open" ? "live" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="chapter-dot" />
        <span className="chapter-trigger-name">{label}</span>
        <span className="chapter-trigger-when">{when}</span>
        <span aria-hidden="true" className="chapter-trigger-caret">▾</span>
      </button>
      {open && (
        <div aria-label="Chapters" className="chapter-panel" role="menu">
          {option("all", "All work", `${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`, cards.length, null, false)}
          {current && (
            <>
              <p className="chapter-group-label">current</p>
              {option(current.slug, current.name, chapterWhen(current), countIn(current.slug), current.slug, true)}
            </>
          )}
          {planned.length > 0 && (
            <>
              <p className="chapter-group-label">planned</p>
              {planned.map((chapter) =>
                option(chapter.slug, chapter.name, chapterWhen(chapter), countIn(chapter.slug), chapter.slug, false),
              )}
            </>
          )}
          {closed.length > 0 && (
            <>
              <p className="chapter-group-label">earlier</p>
              {closed.map((chapter) =>
                option(chapter.slug, chapter.name, chapterWhen(chapter), countIn(chapter.slug), chapter.slug, false),
              )}
            </>
          )}
          <div className="chapter-panel-foot">
            {option("none", "No chapter", "not placed yet", unplaced, NO_CHAPTER, false)}
            {isOwner && (
              <button
                className="chapter-manage"
                onClick={() => { setOpen(false); onManage(); }}
                role="menuitem"
                type="button"
              >Manage chapters…</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
