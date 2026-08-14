import { useEffect, useMemo, useRef, useState } from "react";
import { SEARCH_GROUPS, type SearchGroup, type SearchHit, type SearchResults } from "../../shared/types";
import { ApiError, search as searchProject } from "../api/client";

const GROUP_LABELS: Record<SearchGroup, string> = {
  active: "Active board",
  backlog: "Backlog",
  ideas: "Ideas",
  done: "Completed",
  archived: "Archived",
};

const QUERY_DELAY = 160;

type Props = {
  initialQuery: string;
  onClose: () => void;
  onOpenPage: (id: string) => void;
  onOpenIdea: (id: string) => void;
  /** Brings an archived page back to the place it was archived from. */
  onRestorePage: (id: string) => Promise<void>;
};

/**
 * One search over the whole project.
 *
 * The board can only draw four columns, so its filter quietly drops matches that live in
 * the backlog, in the idea garden, or in a page that was archived. This asks the server
 * instead, and says where each answer lives so the result is a place to go, not just a row.
 *
 * An archived page has no editable home to open, so its row carries a restore instead.
 * This is the only route back to one: the eight-second undo after archiving is long gone,
 * and nothing else in the interface can reach the archive at all.
 */
export function SearchDialog({ initialQuery, onClose, onOpenPage, onOpenIdea, onRestorePage }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();

  // Opening from a filtered board seeds the query, so a fresh search is one keystroke away.
  useEffect(() => inputRef.current?.select(), []);

  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      searchProject(trimmed, controller.signal)
        .then((value) => {
          setResults(value);
          setFailed(false);
          setActive(0);
        })
        .catch((error) => {
          // An aborted request is just a newer keystroke winning.
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          setFailed(error instanceof ApiError || error instanceof Error);
          setResults(null);
        });
    }, QUERY_DELAY);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [trimmed]);

  const grouped = useMemo(() => {
    const hits = results?.query === trimmed ? results.hits : [];
    return SEARCH_GROUPS.map((group) => ({ group, hits: hits.filter((hit) => hit.group === group) }))
      .filter((section) => section.hits.length > 0);
  }, [results, trimmed]);

  // Archived pages cannot be opened, so they are not part of the keyboard walk either.
  const openable = useMemo(
    () => grouped.flatMap((section) => section.hits).filter(canOpen),
    [grouped],
  );

  useEffect(() => {
    if (active >= openable.length) setActive(0);
  }, [active, openable.length]);

  const open = (hit: SearchHit) => {
    if (hit.kind === "idea") onOpenIdea(hit.id);
    else onOpenPage(hit.id);
  };

  /**
   * Restoring closes the search and opens the page.
   *
   * A page returns to the column it was archived from, which may not be one the board
   * draws, so showing the page itself is the only honest answer to "where did it go".
   */
  const restore = async (id: string) => {
    if (restoring) return;
    setRestoring(id);
    try {
      await onRestorePage(id);
      onOpenPage(id);
    } catch {
      // The failure is already reported outside the overlay; the row stays put.
      setRestoring(null);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (openable.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + openable.length) % openable.length);
      return;
    }
    if (event.key === "Enter") {
      const hit = openable[active];
      if (!hit) return;
      event.preventDefault();
      open(hit);
    }
  };

  useEffect(() => {
    const highlighted = listRef.current?.querySelector<HTMLElement>(".search-hit.active");
    highlighted?.scrollIntoView?.({ block: "nearest" });
  }, [active, grouped]);

  const showEmpty = Boolean(trimmed) && !failed && results?.query === trimmed && grouped.length === 0;
  const hidden = results && results.query === trimmed ? results.total - results.hits.length : 0;

  return (
    <div className="modal-backdrop search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label="Search everything" aria-modal="true" className="search-dialog" role="dialog">
        <div className="search-input">
          <span aria-hidden="true" className="search-glyph">/</span>
          <label className="sr-only" htmlFor="global-search">Search pages, notes, ideas, and archived work</label>
          <input
            autoFocus
            id="global-search"
            name="globalSearch"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, notes, ideas, archived work..."
            ref={inputRef}
            type="search"
            value={query}
          />
          <button aria-label="Close search" className="icon-button" onClick={onClose} type="button">×</button>
        </div>

        <div aria-live="polite" className="search-results" ref={listRef}>
          {!trimmed && (
            <p className="search-hint">
              Everything is in here: every column, the backlog, the idea garden, completed work, and pages that were archived.
            </p>
          )}
          {failed && <p className="search-hint">Search could not be reached. Try again in a moment.</p>}
          {showEmpty && <p className="search-hint">Nothing in this project mentions “{trimmed}”.</p>}
          {grouped.map((section) => (
            <div className="search-group" key={section.group}>
              <p className="search-group-label">{GROUP_LABELS[section.group]} <span>{section.hits.length}</span></p>
              {section.hits.map((hit) => {
                const index = openable.indexOf(hit);
                const openableHit = index >= 0;
                const className = `search-hit ${openableHit && index === active ? "active" : ""} ${openableHit ? "" : "closed"}`;
                const body = (
                  <span className="search-hit-body">
                    <span className="search-hit-line">
                      {hit.category && (
                        <span
                          className="category-pill"
                          style={hit.categoryColor ? ({ "--category-color": hit.categoryColor } as React.CSSProperties) : undefined}
                        >{hit.category}</span>
                      )}
                      <strong>{hit.title}</strong>
                      <span className="search-hit-where">{hit.where}</span>
                    </span>
                    {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                  </span>
                );
                return openableHit ? (
                  <button
                    className={className}
                    key={hit.id}
                    onClick={() => open(hit)}
                    onMouseEnter={() => setActive(index)}
                    type="button"
                  >{body}</button>
                ) : (
                  <div className={className} key={hit.id}>
                    {body}
                    {/* Search is the only way back to an archived page, so it carries the way back. */}
                    <button
                      aria-label={`Restore ${hit.title}`}
                      className="search-restore"
                      disabled={restoring !== null}
                      onClick={() => void restore(hit.id)}
                      type="button"
                    >{restoring === hit.id ? "restoring..." : "restore"}</button>
                  </div>
                );
              })}
            </div>
          ))}
          {hidden > 0 && <p className="search-hint">{hidden} more match{hidden === 1 ? "" : "es"}. Narrow the search to reach them.</p>}
        </div>

        <div className="search-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>enter</kbd> to open</span>
          <span><kbd>esc</kbd> to close</span>
        </div>
      </section>
    </div>
  );
}

function canOpen(hit: SearchHit): boolean {
  return hit.group !== "archived";
}
