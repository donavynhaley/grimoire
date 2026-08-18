import { useState } from "react";
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

/**
 * A choice found by typing rather than read from a wall of buttons.
 *
 * A plain choice field shows every option at once, which is right up to about the point a
 * team's option list outgrows the rail. This one rests as its value, and opens into the same
 * search-and-pick the blocker finder uses: type a little, tap the answer.
 */
function SearchableChoice({ field, onSet, value }: {
  field: ProjectField;
  onSet: (value: string | null) => void;
  value: FieldValue | undefined;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const matches = field.options.filter((option) => option.toLowerCase().includes(normalized)).slice(0, 8);

  const close = () => {
    setSearching(false);
    setQuery("");
  };

  if (!searching) {
    return (
      <div className="rail-value">
        <span className="rail-current">{fieldValueText(field, value)}</span>
        <button
          aria-label={`Change ${field.label}`}
          className="rail-change"
          onClick={() => setSearching(true)}
          type="button"
        >change</button>
      </div>
    );
  }

  return (
    <div className="dependency-search">
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
      <div>
        {value !== undefined && (
          <button className="text-button" onClick={() => { onSet(null); close(); }} type="button">clear</button>
        )}
        <button className="text-button" onClick={close} type="button">cancel</button>
      </div>
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
