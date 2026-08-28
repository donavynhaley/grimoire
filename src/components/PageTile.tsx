import { type PointerEvent as ReactPointerEvent } from "react";
import { type Member, type Page, type ProjectCategory, type ProjectField } from "../../shared/types";
import { Avatar } from "./Avatar";
import { PageFieldChips } from "./PageFields";
import { categoryColorStyle } from "../lib/category-style";
import { plainTextFromMarkdown } from "../lib/markdown-text";

type Props = {
  page: Page;
  /** Every page on the board, so blockers can be named even when they sit in another column. */
  pages: Page[];
  category: ProjectCategory | undefined;
  /** The category's display name resolved by the board's own table - "uncategorized" when none. */
  categoryLabel: string;
  estimatesEnabled: boolean;
  fields: ProjectField[];
  members: Member[];
  /** The tile is being carried, so it has left the flow of its column. */
  hidden: boolean;
  /** The tile is the one currently held by tap or key. */
  moving: boolean;
  /** Changed while the reader was away and not yet opened this visit. */
  unseen: boolean;
  /** Whether the click now being handled is the tail of a drag; see usePointerDrag. */
  guardClick: () => boolean;
  onOpen: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onToggleMove: () => void;
};

/** One page on the kanban board: its grip, its signals, and the button that opens it. */
export function PageTile({
  page,
  pages,
  category,
  categoryLabel,
  estimatesEnabled,
  fields,
  members,
  hidden,
  moving,
  unseen,
  guardClick,
  onOpen,
  onPointerDown,
  onToggleMove,
}: Props) {
  const blockers = page.blockedBy
    .map((id) => pages.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Page => Boolean(candidate && candidate.status !== "done"));
  const preview = page.description ? plainTextFromMarkdown(page.description) : "";
  return (
    <article
      className={`board-page ${page.category ? "" : "category-none"} ${hidden ? "drag-hidden" : ""} ${unseen ? "unseen" : ""}`}
      data-flip-id={page.id}
      onPointerDown={onPointerDown}
      style={category ? categoryColorStyle(category.color) : undefined}
    >
      <button
        aria-label={`Move ${page.title}`}
        aria-pressed={moving}
        className="drag-grip"
        onClick={() => {
          if (guardClick()) return;
          onToggleMove();
        }}
        title={`Move ${page.title}`}
        type="button"
      >
        ⠿
      </button>
      <button
        aria-label={`Open ${page.title}${preview ? `. ${preview}` : ""}. ${categoryLabel}. ${blockers.length ? `Blocked by ${blockers.map((blocker) => blocker.title).join(", ")}. ` : ""}${page.assigneeName ?? "unassigned"}${unseen ? ". Changed while you were away" : ""}`}
        className="page-open"
        onClick={() => {
          if (!guardClick()) onOpen();
        }}
        type="button"
      >
        {(page.category ||
          blockers.length > 0 ||
          page.github ||
          page.openThreads > 0 ||
          (estimatesEnabled && page.estimate !== null)) && (
          <span className="page-signals">
            {page.category && <span className="category-pill">{categoryLabel}</span>}
            {blockers.length > 0 && <span className="page-blocked">blocked by {blockers.length}</span>}
            {estimatesEnabled && page.estimate !== null && (
              <span className="estimate-pill" title={`Estimated at ${page.estimate}`}>
                {page.estimate}
              </span>
            )}
            {/*
              Only unanswered threads are worth a tile: a page whose questions
              have all been answered looks exactly as it did before anyone
              asked one.
            */}
            {page.openThreads > 0 && (
              <span
                className="discussion-pill"
                title={page.openThreads === 1 ? "1 open thread" : `${page.openThreads} open threads`}
              >
                {page.openThreads} open
              </span>
            )}
            {page.github && (
              <span className={`github-pill github-state-${page.githubStatus?.state ?? "unchecked"}`}>
                {page.githubStatus?.prNumber
                  ? `#${page.githubStatus.prNumber}`
                  : page.github.kind === "pr"
                    ? `#${page.github.number}`
                    : `⎇ ${page.github.name}`}
              </span>
            )}
          </span>
        )}
        <strong>{page.title}</strong>
        {preview && <p>{preview}</p>}
        <PageFieldChips fields={fields} values={page.fields} />
        <span className={`assignee ${page.assigneeId ? "assigned" : ""}`}>
          {page.assigneeName ? (
            <>
              <Avatar
                avatarUrl={members.find((member) => member.id === page.assigneeId)?.avatarUrl}
                className="avatar tiny"
                name={page.assigneeName}
              />
              {page.assigneeName}
            </>
          ) : (
            "unassigned"
          )}
        </span>
      </button>
    </article>
  );
}
