import { useEffect, useRef, useState } from "react";
import type { Page, Chapter } from "../../shared/types";
import { chapterWhen } from "./chapter-dates";
import { Growing } from "./Growing";
import { useDismissOnOutside } from "./use-dismiss-on-outside";

/**
 * What the board is narrowed to: every page, one chapter, or the pages nobody has placed.
 * `null` means all work, which is always reachable so the picker can never hide the project.
 */
export type ChapterFilter = string | null;

/** The value the URL uses for "pages belonging to no chapter". */
export const NO_CHAPTER = "none";

type Props = {
  pages: Page[];
  chapters: Chapter[];
  isOwner: boolean;
  onChange: (value: ChapterFilter) => void;
  onManage: () => void;
  /** Closes whichever chapter is open and opens this one, as one act. */
  onMakeCurrent: (slug: string) => Promise<void>;
  value: ChapterFilter;
};

export function ChapterPicker({ pages, chapters, isOwner, onChange, onManage, onMakeCurrent, value }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected =
    value === null || value === NO_CHAPTER ? undefined : chapters.find((chapter) => chapter.slug === value);

  useDismissOnOutside(rootRef, open, () => setOpen(false));

  const countIn = (slug: string) => pages.filter((page) => page.chapter === slug).length;
  const unplaced = pages.filter((page) => page.chapter === null).length;
  const planned = chapters.filter((chapter) => chapter.state === "planned");
  const closed = chapters.filter((chapter) => chapter.state === "closed");
  const current = chapters.find((chapter) => chapter.state === "open");

  /*
   * Closed chapters fold away. They accumulate for the life of the project and are almost
   * never what somebody reaching for this control wants, so leaving them open pushes the
   * chapters that are live off the bottom and puts a finished one under the pointer. The
   * one time they are worth showing on sight is when the board is already filtered to one,
   * because then the selected row would otherwise be hidden inside the fold.
   */
  const viewingClosed = closed.some((chapter) => chapter.slug === value);
  const [showClosed, setShowClosed] = useState(viewingClosed);

  // Every visit to the picker starts folded again, so expanding it to reach an old chapter
  // is not a decision that quietly outlives the moment it was made in.
  useEffect(() => {
    if (!open) setShowClosed(viewingClosed);
  }, [open, viewingClosed]);

  const label = value === NO_CHAPTER ? "No chapter" : (selected?.name ?? "All work");
  const when =
    value === NO_CHAPTER
      ? `${unplaced} unplaced`
      : selected
        ? chapterWhen(selected)
        : `${pages.length} pages`;

  const choose = (next: ChapterFilter) => {
    onChange(next);
    setOpen(false);
  };

  /**
   * One row of the picker. `makeCurrent` is offered on every chapter that is not the current
   * one, because a chapter with no dates has nothing to imply it should be - somebody has to
   * say so, and this is where they are already looking at the list.
   */
  const option = (
    key: string,
    name: string,
    sub: string,
    count: number,
    next: ChapterFilter,
    isCurrent: boolean,
    makeCurrent?: string,
  ) => (
    <div className={`chapter-row-option ${isCurrent ? "current" : ""}`} key={key}>
      <button
        aria-current={value === next ? "true" : undefined}
        className={`chapter-option ${isCurrent ? "current" : ""} ${value === next ? "selected" : ""}`}
        onClick={() => choose(next)}
        role="menuitem"
        type="button"
      >
        <span className="chapter-option-name">
          {name}
          {sub && <span className="chapter-option-sub">{sub}</span>}
        </span>
        <span className="chapter-option-count">{count}</span>
      </button>
      {makeCurrent && isOwner && (
        <button
          aria-label={`Make ${name} the current chapter`}
          className="chapter-make-current"
          onClick={() => void onMakeCurrent(makeCurrent)}
          title={current ? `Closes ${current.name} first` : undefined}
          type="button"
        >
          make current
        </button>
      )}
    </div>
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
        {when && <span className="chapter-trigger-when">{when}</span>}
        <span aria-hidden="true" className="chapter-trigger-caret">
          ▾
        </span>
      </button>
      {open && (
        <div aria-label="Chapters" className="chapter-panel" role="menu">
          {option(
            "all",
            "All work",
            `${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`,
            pages.length,
            null,
            false,
          )}
          {current && (
            <>
              <p className="chapter-group-label">current</p>
              {option(
                current.slug,
                current.name,
                chapterWhen(current),
                countIn(current.slug),
                current.slug,
                true,
              )}
            </>
          )}
          {planned.length > 0 && (
            <>
              <p className="chapter-group-label">planned</p>
              {planned.map((chapter) =>
                option(
                  chapter.slug,
                  chapter.name,
                  chapterWhen(chapter),
                  countIn(chapter.slug),
                  chapter.slug,
                  false,
                  chapter.slug,
                ),
              )}
            </>
          )}
          {closed.length > 0 && (
            <Growing className="chapter-group-fold">
              <button
                aria-expanded={showClosed}
                className="chapter-group-label as-toggle"
                onClick={() => setShowClosed((shown) => !shown)}
                type="button"
              >
                <span>earlier</span>
                <span className="chapter-group-count">{closed.length}</span>
                <span aria-hidden="true" className="chapter-group-caret">
                  {showClosed ? "▾" : "▸"}
                </span>
              </button>
              {showClosed &&
                closed.map((chapter) =>
                  option(
                    chapter.slug,
                    chapter.name,
                    chapterWhen(chapter),
                    countIn(chapter.slug),
                    chapter.slug,
                    false,
                    chapter.slug,
                  ),
                )}
            </Growing>
          )}
          <div className="chapter-panel-foot">
            {option("none", "No chapter", "not placed yet", unplaced, NO_CHAPTER, false)}
            {isOwner && (
              <button
                className="chapter-manage"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
                role="menuitem"
                type="button"
              >
                Manage chapters…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
