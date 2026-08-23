import { useEffect, useRef, useState } from "react";
import type { FieldValue, PageFields as PageFieldValues, ProjectField } from "../../shared/types";
import { Growing } from "./Growing";

type Props = {
  fields: ProjectField[];
  values: PageFieldValues;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
};

/** What a value looks like once it is only being read. */
export function fieldValueText(field: ProjectField, value: FieldValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "checkbox") return value ? "yes" : "no";
  return String(value);
}

/**
 * The project's own fields, on one page.
 *
 * A choice field offers its options as buttons rather than a dropdown, the way the column and
 * assignee controls already do, so setting one is a single click and the possible answers are
 * visible without opening anything. Everything else is the plainest input that fits the type.
 *
 * Every change sends only the field it touched, because the API merges a patch: sending the
 * whole record would make one edit responsible for every other value on the page.
 */
export function PageFieldsEditor({ fields, values, onUpdate }: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (fields.length === 0) return null;

  const set = (key: string, value: FieldValue | null) => onUpdate({ fields: { [key]: value } });

  const commitDraft = (field: ProjectField) => {
    const trimmed = draft.trim();
    setEditingKey(null);
    if (trimmed === fieldValueText(field, values[field.key])) return;
    if (!trimmed) {
      void set(field.key, null);
      return;
    }
    if (field.type === "number") {
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed)) return;
      void set(field.key, parsed);
      return;
    }
    void set(field.key, trimmed);
  };

  return (
    <>
      {fields.map((field) => (
        <Growing className="rail-row" key={field.key}>
          <span className="field-label">{field.label}</span>
          {field.type === "search-select" ? (
            <SearchableChoice
              field={field}
              onSet={(value) => void set(field.key, value)}
              value={values[field.key]}
            />
          ) : field.type === "select" ? (
            <div className="choice-grid field-choices">
              <button
                aria-label={`Clear ${field.label}`}
                className={values[field.key] === undefined ? "choice active" : "choice"}
                onClick={() => void set(field.key, null)}
                type="button"
              >none</button>
              {field.options.map((option) => (
                <button
                  aria-label={`Set ${field.label} to ${option}`}
                  className={values[field.key] === option ? "choice active" : "choice"}
                  key={option}
                  onClick={() => void set(field.key, option)}
                  type="button"
                >{option}</button>
              ))}
            </div>
          ) : field.type === "checkbox" ? (
            <div className="choice-grid field-choices">
              <button
                aria-label={`Set ${field.label} to yes`}
                className={values[field.key] === true ? "choice active" : "choice"}
                onClick={() => void set(field.key, true)}
                type="button"
              >yes</button>
              <button
                aria-label={`Set ${field.label} to no`}
                className={values[field.key] === false ? "choice active" : "choice"}
                onClick={() => void set(field.key, false)}
                type="button"
              >no</button>
              <button
                aria-label={`Clear ${field.label}`}
                className={values[field.key] === undefined ? "choice active" : "choice"}
                onClick={() => void set(field.key, null)}
                type="button"
              >none</button>
            </div>
          ) : editingKey === field.key ? (
            <input
              aria-label={field.label}
              autoFocus
              name={`field-${field.key}`}
              onBlur={() => commitDraft(field)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commitDraft(field); }
                if (event.key === "Escape") setEditingKey(null);
              }}
              placeholder={field.type === "date" ? "YYYY-MM-DD" : ""}
              type={field.type === "number" ? "number" : "text"}
              value={draft}
            />
          ) : (
            <div className="rail-value">
              <span className="rail-current">{fieldValueText(field, values[field.key])}</span>
              <button
                aria-label={`Change ${field.label}`}
                className="rail-change"
                onClick={() => {
                  setDraft(values[field.key] === undefined ? "" : String(values[field.key]));
                  setEditingKey(field.key);
                }}
                type="button"
              >change</button>
            </div>
          )}
        </Growing>
      ))}
    </>
  );
}

/** The popover's own chrome — input, padding, the actions row — which is not list space. */
const MARGIN_AND_INPUT = 108;
/** Below this the list is too short to be worth reading, so it scrolls instead of shrinking. */
const MIN_LIST = 96;

/**
 * A choice found by typing rather than read from a wall of buttons.
 *
 * A plain choice field shows every option at once, which is right up to about the point a
 * team's option list outgrows the rail. This one rests as its value, and opens into the same
 * search-and-pick the blocker finder uses: type a little, tap the answer.
 *
 * The search opens over the rail rather than inside it. Growing the row would push every
 * property below it down the panel the moment somebody reached for this one, and put a
 * different control under the pointer that had just clicked - so the row keeps the height it
 * rests at, and the search is a layer on top of it. It is a popover entering rather than a
 * section unfolding, which is the case the height rule leaves to CSS.
 */
function SearchableChoice({ field, onSet, value }: {
  field: ProjectField;
  onSet: (value: string | null) => void;
  value: FieldValue | undefined;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * Which way the search opens, and how tall its list may be.
   *
   * Fields sit wherever the project ordered them, so the last row of a long rail has no room
   * beneath it — and a popover that opens downward from there is half off the panel. Measured
   * once on opening: it drops upward when that is the roomier side, and the list is capped to
   * whatever room the chosen side actually has.
   */
  const [placement, setPlacement] = useState<{ up: boolean; room: number }>({ up: false, room: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const normalized = query.trim().toLowerCase();
  const matches = field.options.filter((option) => option.toLowerCase().includes(normalized)).slice(0, 8);

  const close = () => {
    setSearching(false);
    setQuery("");
  };

  const open = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      const up = below < above;
      setPlacement({ up, room: (up ? above : below) - MARGIN_AND_INPUT });
    }
    setSearching(true);
  };

  // Clicking anywhere else is the ordinary way out of a popover, and the one people reach for
  // before they find the cancel it covers.
  useEffect(() => {
    if (!searching) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [searching]);

  return (
    <div className="field-search-anchor" ref={rootRef}>
      <div className="rail-value">
        <span className="rail-current">{fieldValueText(field, value)}</span>
        <button
          aria-expanded={searching}
          aria-haspopup="dialog"
          aria-label={`Change ${field.label}`}
          className="rail-change"
          onClick={() => (searching ? close() : open())}
          type="button"
        >change</button>
      </div>
      {searching && (
        <div
          aria-label={`Choose a ${field.label}`}
          className={placement.up ? "field-search-popover drop-up" : "field-search-popover"}
          role="dialog"
          style={{ "--field-search-room": `${Math.max(placement.room, MIN_LIST)}px` } as React.CSSProperties}
        >
          <label>
            <span className="sr-only">{`Find a ${field.label} option`}</span>
            <input
              aria-label={`Find a ${field.label} option`}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches.length > 0) {
                  event.preventDefault();
                  onSet(matches[0]);
                  close();
                  return;
                }
                if (event.key !== "Escape") return;
                // Leaving the search must not also close the whole page.
                event.stopPropagation();
                close();
              }}
              placeholder="Type to search options..."
              type="search"
              value={query}
            />
          </label>
          <div className="dependency-results">
            {matches.map((option) => (
              <button
                aria-label={`Set ${field.label} to ${option}`}
                key={option}
                onClick={() => { onSet(option); close(); }}
                type="button"
              >
                <span>{option === value ? <strong>{option} ✓</strong> : <strong>{option}</strong>}</span>
              </button>
            ))}
            {matches.length === 0 && <p>No matching options.</p>}
          </div>
          <div className="field-search-actions">
            {value !== undefined && (
              <button className="text-button" onClick={() => { onSet(null); close(); }} type="button">clear</button>
            )}
            <button className="text-button" onClick={close} type="button">cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The handful of values a project asked to see without opening a page.
 *
 * Only fields marked for tiles appear, and only when the page actually has one, so a board
 * whose project defined ten fields does not turn into ten rows of blanks.
 */
export function PageFieldChips({ fields, values }: { fields: ProjectField[]; values: PageFieldValues }) {
  const shown = fields.filter((field) => field.showOnTile && values[field.key] !== undefined);
  if (shown.length === 0) return null;
  return (
    <div className="page-field-chips">
      {shown.map((field) => (
        <span className="page-field-chip" key={field.key} title={field.label}>
          {fieldValueText(field, values[field.key])}
        </span>
      ))}
    </div>
  );
}
