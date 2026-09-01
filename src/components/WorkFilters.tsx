import type { RefObject } from "react";
import type { BoardWorkspace, Page, PageStatus } from "../../shared/types";
import type { BoardFilters } from "../hooks/use-board-filters";
import type { CardHint } from "../hooks/use-card-board";
import { Avatar } from "./Avatar";
import { ChapterPicker } from "./ChapterPicker";
import { PageFilters } from "./PageFilters";

type Props = {
  /** The backlog pill doubles as a drop target, so the board's own geometry needs its node. */
  backlogRef: RefObject<HTMLButtonElement | null>;
  backlogPages: Page[];
  board: BoardWorkspace;
  drag: { id: string; height: number } | null;
  dropHint: CardHint<PageStatus> | null;
  filters: BoardFilters;
  /** The column a capture just landed in, so the backlog pill can glow when it was the target. */
  landed: PageStatus | null;
  moving: string | null;
  movingPage: Page | null;
  online: ReadonlySet<string>;
  onMakeChapterCurrent: (slug: string) => Promise<void>;
  onManageChapters: () => void;
  onOpenBacklog: () => void;
  placeMoving: (slot: PageStatus, index: number) => Promise<void>;
};

/** The filter row: the backlog pill, the chapter picker, search, facets, and the people chips. */
export function WorkFilters({
  backlogRef,
  backlogPages,
  board,
  drag,
  dropHint,
  filters,
  landed,
  moving,
  movingPage,
  online,
  onMakeChapterCurrent,
  onManageChapters,
  onOpenBacklog,
  placeMoving,
}: Props) {
  const chaptersOn = board.project.chaptersEnabled;
  return (
    <div className="work-filters" aria-label="Work filters" role="group">
      <button
        aria-label={
          moving
            ? `Move ${movingPage?.title ?? "page"} to the backlog`
            : `Open backlog, ${backlogPages.length} page${backlogPages.length === 1 ? "" : "s"}`
        }
        className={`library-trigger ${drag ? "drop-ready" : ""} ${dropHint?.slot === "backlog" ? "drop-over" : ""} ${moving ? "move-target" : ""} ${landed === "backlog" ? "landed" : ""}`}
        onClick={() => {
          if (moving) void placeMoving("backlog", 0);
          else onOpenBacklog();
        }}
        ref={backlogRef}
        title="Backlog (B)"
        type="button"
      >
        <span>Backlog</span>
        <strong>{backlogPages.length}</strong>
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character */}
        <kbd aria-hidden="true">B</kbd>
      </button>
      {chaptersOn && (
        <ChapterPicker
          pages={board.pages}
          chapters={board.chapters}
          isOwner={board.viewerIsOwner}
          onChange={filters.changeChapter}
          onManage={onManageChapters}
          onMakeCurrent={onMakeChapterCurrent}
          value={filters.chapter}
        />
      )}
      <label className="page-search">
        <span className="sr-only">Search pages</span>
        <input
          aria-label="Search pages"
          name="pageSearch"
          onChange={(event) => filters.changeQuery(event.target.value)}
          placeholder="Search pages..."
          type="search"
          value={filters.query}
        />
      </label>
      {/* Everything else a page can be narrowed by, next to the people it can be narrowed to. */}
      <PageFilters
        context={filters.facetContext}
        onChange={filters.changeFacets}
        pages={filters.pagesBeforeFacets}
        selection={filters.facets}
      />
      <div className="people-filters">
        <button
          aria-pressed={filters.people.has("unassigned")}
          className={filters.people.has("unassigned") ? "active" : ""}
          onClick={() => filters.togglePerson("unassigned")}
          type="button"
        >
          unassigned
        </button>
        {board.members.map((member) => {
          const isCurrentUser = member.id === board.currentUser.id;
          return (
            <button
              aria-label={isCurrentUser ? "Filter to my work" : `Filter by ${member.name}`}
              aria-pressed={filters.people.has(member.id)}
              className={`${filters.people.has(member.id) ? "active" : ""} ${isCurrentUser ? "self-filter" : ""}`}
              key={member.id}
              onClick={() => filters.togglePerson(member.id)}
              type="button"
            >
              {isCurrentUser && <span className="self-filter-label">me</span>}
              {/* The self chip clips its contents and slides on toggle, so the glow stays off it. */}
              <Avatar
                avatarUrl={member.avatarUrl}
                className="avatar tiny"
                name={member.name}
                online={!isCurrentUser && online.has(member.id)}
                title={online.has(member.id) ? `${member.name} (online)` : member.name}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
