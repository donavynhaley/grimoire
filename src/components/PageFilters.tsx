import { useEffect, useMemo, useRef, useState } from "react";
import type { Page } from "../../shared/types";
import { Growing } from "./Growing";
import { buildFacets, countSelected, toggleFacet, type FacetContext, type FacetSelection } from "./page-facets";

type Props = {
  /** Already narrowed by the controls outside this panel, so the counts agree with the board. */
  pages: Page[];
  context: FacetContext;
  selection: FacetSelection;
  onChange: (selection: FacetSelection) => void;
};

/**
 * Everything else a page can be narrowed by, behind one button.
 *
 * The bar beside it holds the three filters worth spending permanent room on - the chapter, the
 * people, the search - and this holds the rest: the project's categories and its own fields,
 * the column, the estimate, whether anything is blocking the page, its GitHub link, who wrote
 * it, and when it last moved. Each is a list of the values that are actually on the board with
 * a count beside them, so there is nothing to type and no way to ask for something that is not
 * there. Ticking two values in a section widens it and ticking one in a second section narrows
 * it, which is the only arrangement where two categories can show anything at all.
 *
 * Sections arrive folded, except the ones already filtering, so the panel opens at the size of
 * its headings and grows only where it is being used.
 */
export function PageFilters({ pages, context, selection, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const active = countSelected(selection);

  const facets = useMemo(
    () => (open ? buildFacets(pages, selection, context) : []),
    [context, open, pages, selection],
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The board's own Escape puts down a page being moved; this one only shuts the panel.
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  /*
   * A section that is filtering is open on arrival, because a fold is the one place a filter
   * could be in force with nothing on screen saying so. Recomputed each time the panel opens,
   * so unfolding a section to read it is not a decision that outlives the visit.
   */
  const openedWith = useRef(selection);
  openedWith.current = selection;
  useEffect(() => {
    if (!open) return;
    const filtering = openedWith.current;
    setExpanded(new Set(Object.keys(filtering).filter((key) => filtering[key]!.length > 0)));
  }, [open]);

  const label = active === 0 ? "Filter pages" : `Filter pages, ${active} value${active === 1 ? "" : "s"} chosen`;

  return (
    <div className="page-filters" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className={`filters-trigger ${active > 0 ? "filtering" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="filters-glyph">⛭</span>
        <span>Filters</span>
        {active > 0 && <strong>{active}</strong>}
      </button>

      {open && (
        <div aria-label="Page filters" className="filters-panel" role="dialog">
          <div className="filters-head">
            <span className="field-label">Filter by</span>
            {active > 0 && (
              <button className="text-button" onClick={() => onChange({})} type="button">clear all</button>
            )}
          </div>

          <div className="filters-sections">
            {facets.map((facet) => {
              const chosen = selection[facet.key] ?? [];
              const showing = expanded.has(facet.key);
              return (
                <Growing className="filters-section" key={facet.key}>
                  <button
                    aria-expanded={showing}
                    className="filters-section-head"
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(facet.key)) next.add(facet.key);
                      return next;
                    })}
                    type="button"
                  >
                    <span aria-hidden="true" className="filters-caret">{showing ? "▾" : "▸"}</span>
                    <span className="filters-section-name">{facet.label}</span>
                    {chosen.length > 0 && <span className="filters-section-count">{chosen.length}</span>}
                  </button>
                  {showing && (
                    <div className="filters-values">
                      {facet.values.map((value) => {
                        const ticked = chosen.includes(value.id);
                        return (
                          <button
                            aria-pressed={ticked}
                            className={`filters-value ${ticked ? "ticked" : ""} ${value.count === 0 ? "empty" : ""}`}
                            key={value.id}
                            onClick={() => onChange(toggleFacet(selection, facet.key, value.id))}
                            type="button"
                          >
                            <span aria-hidden="true" className="filters-tick">{ticked ? "☑" : "☐"}</span>
                            <span className="filters-value-name">{value.label}</span>
                            <span className="filters-value-count">{value.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Growing>
              );
            })}
            {facets.length === 0 && <p className="filters-empty">Nothing to filter by yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
