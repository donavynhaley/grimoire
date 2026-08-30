import { useState } from "react";
import {
  type Chapter,
  type Member,
  PAGE_STATUS_LABELS,
  PAGE_STATUSES,
  type Page,
  type ProjectCategory,
  type ProjectField,
} from "../../shared/types";
import { categoryColorStyle, categoryStyle } from "../lib/category-style";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";
import { EstimateRow, PageFieldsEditor } from "./PageFields";

const labels = PAGE_STATUS_LABELS;

type Props = {
  page: Page;
  /** Every page on the board, searched when this one names what blocks it. */
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  fields: ProjectField[];
  /** Off unless the project asked for estimates, and then no page shows one. */
  estimatesEnabled: boolean;
  members: Member[];
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
};

/**
 * The page's properties, in one column: column, assignee, chapter, category, estimate, the
 * project's own fields, and what blocks it.
 *
 * The dialog renders it keyed by the page's id, so opening a different page starts every fold
 * and picker here where it would have started on first sight - reaching into the earlier
 * chapters for one page is not a choice the next page inherits.
 */
export function PageRail({
  page,
  pages,
  categories,
  chapters,
  estimatesEnabled,
  fields,
  members,
  onUpdate,
}: Props) {
  /**
   * Category is the only attribute long enough to be worth folding: ten choices against four
   * or five everywhere else, and it is usually set once at capture time with `#` and rarely
   * revisited. Column, assignee, and chapter stay one click, because those are the ones
   * someone opens a page to change.
   */
  const [changingCategory, setChangingCategory] = useState(false);
  /*
   * Finished chapters fold away here for the same reason they do in the board's picker: they
   * accumulate for the life of the project, and a project a year in offers a page fifteen
   * buttons of which one is live. The fold opens on sight when this page belongs to a closed
   * chapter, because otherwise the row would show no selection and the reason would be hidden.
   */
  const inClosedChapter = chapters.some(
    (chapter) => chapter.state === "closed" && chapter.slug === page.chapter,
  );
  const [showingClosedChapters, setShowingClosedChapters] = useState(inClosedChapter);
  const liveChapters = chapters.filter((chapter) => chapter.state !== "closed");
  const closedChapters = chapters.filter((chapter) => chapter.state === "closed");
  const [findingBlocker, setFindingBlocker] = useState(false);
  const [blockerQuery, setBlockerQuery] = useState("");

  const blockers = page.blockedBy
    .map((id) => pages.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Page => Boolean(candidate));
  const normalizedBlockerQuery = blockerQuery.trim().toLowerCase();
  const blockerResults = normalizedBlockerQuery
    ? pages
        .filter(
          (candidate) =>
            candidate.id !== page.id &&
            candidate.status !== "done" &&
            !page.blockedBy.includes(candidate.id) &&
            `${candidate.title}\n${candidate.category ?? "uncategorized"}`
              .toLowerCase()
              .includes(normalizedBlockerQuery),
        )
        .slice(0, 6)
    : [];

  const addBlocker = async (id: string) => {
    await onUpdate({ blockedBy: [...page.blockedBy, id] });
    setFindingBlocker(false);
    setBlockerQuery("");
  };

  const removeBlocker = (id: string) =>
    onUpdate({
      blockedBy: page.blockedBy.filter((dependencyId) => dependencyId !== id),
    });

  return (
    <div aria-label="Page properties" className="page-rail">
      <div className="rail-row">
        <span className="field-label">Column</span>
        <div className="choice-grid status-choices">
          {PAGE_STATUSES.map((status) => (
            <button
              aria-label={`Move to ${labels[status]}`}
              className={page.status === status ? "choice active" : "choice"}
              key={status}
              onClick={() => onUpdate({ status, position: 99_999 })}
              type="button"
            >
              <span className={`column-dot ${status}`} />
              {labels[status]}
            </button>
          ))}
        </div>
      </div>

      <div className="rail-row">
        <span className="field-label">Who</span>
        <div className="choice-grid assignee-choices">
          <button
            className={!page.assigneeId ? "choice active" : "choice"}
            onClick={() => onUpdate({ assigneeId: null })}
            type="button"
          >
            unassigned
          </button>
          {members.map((member) => (
            <button
              aria-label={`Assign ${member.name}`}
              className={page.assigneeId === member.id ? "choice active" : "choice"}
              key={member.id}
              onClick={() => onUpdate({ assigneeId: member.id })}
              type="button"
            >
              <Avatar avatarUrl={member.avatarUrl} className="avatar tiny" name={member.name} />
              {member.name}
            </button>
          ))}
        </div>
      </div>

      {chapters.length > 0 && (
        <Growing className="rail-row">
          <span className="field-label">Chapter</span>
          <div className="choice-grid chapter-choices">
            <button
              aria-label="Remove from every chapter"
              className={!page.chapter ? "choice active" : "choice"}
              onClick={() => onUpdate({ chapter: null })}
              type="button"
            >
              none
            </button>
            {liveChapters.map((chapter) => (
              <ChapterChoice chapter={chapter} key={chapter.slug} onUpdate={onUpdate} page={page} />
            ))}
          </div>
          {closedChapters.length > 0 && (
            <>
              <button
                aria-expanded={showingClosedChapters}
                className="chapter-group-label as-toggle in-rail"
                onClick={() => setShowingClosedChapters((showing) => !showing)}
                type="button"
              >
                <span>earlier</span>
                <span className="chapter-group-count">{closedChapters.length}</span>
                <span aria-hidden="true" className="chapter-group-caret">
                  {showingClosedChapters ? "▾" : "▸"}
                </span>
              </button>
              {showingClosedChapters && (
                <div className="choice-grid chapter-choices">
                  {closedChapters.map((chapter) => (
                    <ChapterChoice chapter={chapter} key={chapter.slug} onUpdate={onUpdate} page={page} />
                  ))}
                </div>
              )}
            </>
          )}
        </Growing>
      )}

      <Growing className="rail-row">
        <span className="field-label">Category</span>
        {changingCategory ? (
          <div className="choice-grid category-choices">
            <button
              aria-label="Clear category"
              className={!page.category ? "choice active" : "choice"}
              onClick={() => {
                void onUpdate({ category: null });
                setChangingCategory(false);
              }}
              type="button"
            >
              none
            </button>
            {categories.map((category) => (
              <button
                aria-label={`Categorize as ${category.name}`}
                className={page.category === category.slug ? "choice active" : "choice"}
                key={category.slug}
                onClick={() => {
                  void onUpdate({ category: category.slug });
                  setChangingCategory(false);
                }}
                type="button"
              >
                <span className="category-swatch" style={categoryColorStyle(category.color)} />
                {category.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="rail-value">
            <span className="rail-current">
              <span
                className={`category-swatch ${page.category ? "" : "category-none"}`}
                style={categoryStyle(categories, page.category)}
              />
              {page.category
                ? (categories.find((category) => category.slug === page.category)?.name ?? page.category)
                : "uncategorized"}
            </span>
            <button
              aria-label="Change category"
              className="rail-change"
              onClick={() => setChangingCategory(true)}
              type="button"
            >
              change
            </button>
          </div>
        )}
      </Growing>

      {estimatesEnabled && (
        <Growing className="rail-row">
          <span className="field-label">Estimate</span>
          <EstimateRow estimate={page.estimate} onUpdate={onUpdate} />
        </Growing>
      )}

      <PageFieldsEditor fields={fields} values={page.fields} onUpdate={onUpdate} />

      <Growing className="rail-row dependency-section">
        <span className="field-label">Blocked by</span>
        {blockers.length > 0 ? (
          <div className="dependency-list">
            {blockers.map((blocker) => (
              <div
                className={blocker.status === "done" ? "dependency resolved" : "dependency"}
                key={blocker.id}
              >
                <span
                  className={`category-swatch ${blocker.category ? "" : "category-none"}`}
                  style={categoryStyle(categories, blocker.category)}
                />
                <span>
                  <strong>{blocker.title}</strong>
                  <small>{blocker.status === "done" ? "resolved" : labels[blocker.status]}</small>
                </span>
                <button
                  aria-label={`Remove blocker ${blocker.title}`}
                  onClick={() => void removeBlocker(blocker.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-dependencies">This page can move forward now.</p>
        )}
        {findingBlocker ? (
          <div className="dependency-search">
            <label>
              <span className="sr-only">Find a blocking page</span>
              <input
                aria-label="Find a blocking page"
                autoFocus
                onChange={(event) => setBlockerQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // Leaving the search must not also close the whole page.
                  event.stopPropagation();
                  setFindingBlocker(false);
                }}
                placeholder="Type a page title..."
                type="search"
                value={blockerQuery}
              />
            </label>
            {normalizedBlockerQuery && (
              <div className="dependency-results">
                {blockerResults.map((candidate) => (
                  <button
                    aria-label={`Blocked by ${candidate.title}`}
                    key={candidate.id}
                    onClick={() => void addBlocker(candidate.id)}
                    type="button"
                  >
                    <span
                      className={`category-swatch ${candidate.category ? "" : "category-none"}`}
                      style={categoryStyle(categories, candidate.category)}
                    />
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>
                        {candidate.category
                          ? (categories.find((category) => category.slug === candidate.category)?.name ??
                            candidate.category)
                          : "uncategorized"}
                      </small>
                    </span>
                  </button>
                ))}
                {blockerResults.length === 0 && <p>No matching open pages.</p>}
              </div>
            )}
            <button
              className="text-button"
              onClick={() => {
                setFindingBlocker(false);
                setBlockerQuery("");
              }}
              type="button"
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            aria-label="Add blocking page"
            className="add-dependency"
            onClick={() => setFindingBlocker(true)}
            type="button"
          >
            + add blocking page
          </button>
        )}
      </Growing>
    </div>
  );
}

/**
 * One chapter this page could be placed in.
 *
 * Shared by the live chapters and the folded ones so a chapter reads and behaves identically
 * either side of the fold: what is hidden is a group, never a different kind of control.
 */
function ChapterChoice({
  chapter,
  onUpdate,
  page,
}: {
  chapter: Chapter;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  page: Page;
}) {
  return (
    <button
      aria-label={`Place in ${chapter.name}`}
      className={page.chapter === chapter.slug ? "choice active" : "choice"}
      onClick={() => onUpdate({ chapter: chapter.slug })}
      type="button"
    >
      {chapter.name}
      {chapter.state === "open" && <span className="choice-note">open</span>}
    </button>
  );
}
