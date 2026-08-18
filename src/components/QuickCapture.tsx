import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type FieldValue, type PageCategory, type PageStatus, type Chapter, type Member, type ProjectCategory, type ProjectField } from "../../shared/types";
import { useTypingFocus } from "./use-typing-focus";

export type CapturePageInput = {
  title: string;
  category: PageCategory | null;
  chapter: string | null;
  assigneeId: string | null;
  status: PageStatus;
  /** Values for the project's own fields, present only for the ones actually chosen. */
  fields?: Record<string, FieldValue>;
};

type CaptureSettings = Omit<CapturePageInput, "title" | "fields"> & { fields: Record<string, FieldValue> };
type PickerKind = "category" | "chapter" | "assignee" | "status" | "field";
type PickerState = {
  kind: PickerKind;
  /** Which of the project's fields is open, when `kind` is "field". */
  fieldKey?: string;
  query: string;
  commandStart: number | null;
};
type PickerOption = {
  id: string;
  label: string;
  search: string;
  value: string | boolean | null;
  color?: string;
};

type Props = {
  busy: boolean;
  categories: ProjectCategory[];
  /** Empty when the project has not enabled chapters, which hides the control entirely. */
  chapters: Chapter[];
  /** The project's own fields; the ones a picker can answer get capture chips of their own. */
  fields?: ProjectField[];
  members: Member[];
  onCreate: (input: CapturePageInput) => Promise<void>;
};

const DEFAULT_SETTINGS: CaptureSettings = {
  category: null,
  chapter: null,
  assigneeId: null,
  status: "backlog",
  fields: {},
};

/** Whether a field answers with a choice among options, or has to be written in. */
function picksFromList(field: ProjectField): boolean {
  return field.type === "select" || field.type === "checkbox";
}

/** How a written value becomes the field's value; null means "could not". */
function parseWritten(field: ProjectField, raw: string): FieldValue | null {
  const value = raw.trim();
  if (!value) return null;
  if (field.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return value;
}

const statusLabels: Partial<Record<PageStatus, string>> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
};

export function QuickCapture({ busy, categories, chapters, fields = [], members, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * The caret lands here on a desktop, where typing was going to start anyway, and waits on a
   * phone, where it would raise the keyboard over the board the reader has just opened.
   */
  const focusOnArrival = useTypingFocus<HTMLInputElement>();
  const fieldChips = fields;
  /** What has been typed into a written field's panel, before it is set. */
  const [fieldDraft, setFieldDraft] = useState("");
  const options = useMemo(
    () => pickerOptions(picker, categories, chapters, members, fieldChips),
    [categories, chapters, fieldChips, members, picker],
  );
  const visibleOptions = useMemo(() => filterOptions(options, picker?.query ?? ""), [options, picker?.query]);
  const selectedCategory = settings.category
    ? categories.find((category) => category.slug === settings.category) ?? null
    : null;
  const categoryLabel = selectedCategory?.name ?? settings.category;
  const assigneeLabel = members.find((member) => member.id === settings.assigneeId)?.name ?? null;
  const chapterLabel = settings.chapter
    ? chapters.find((chapter) => chapter.slug === settings.chapter)?.name ?? settings.chapter
    : null;
  const statusLabel = statusLabels[settings.status] ?? "Backlog";

  useEffect(() => {
    setHighlighted(0);
  }, [picker?.kind, picker?.query]);

  const changeTitle = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setTitle(value);
    const command = commandAtEnd(value, event.target.selectionStart ?? value.length);
    setPicker(command);
  };

  const openPicker = (kind: PickerKind, fieldKey?: string) => {
    setPicker({ kind, fieldKey, query: "", commandStart: null });
    setHighlighted(0);
    // A written field's panel opens holding what it already has, ready to be corrected.
    const held = fieldKey ? settings.fields[fieldKey] : undefined;
    setFieldDraft(held === undefined ? "" : String(held));
  };

  /** The field the open panel belongs to, when it is one of the project's own. */
  const openField = picker?.kind === "field"
    ? fieldChips.find((candidate) => candidate.key === picker.fieldKey) ?? null
    : null;
  const writingField = openField && !picksFromList(openField) ? openField : null;

  /**
   * Commits whatever the panel holds; an empty or unparseable value clears the field.
   *
   * Written through the ref as well as state, because the commit often runs from a blur
   * whose very next event - the tap that caused it - may be the submit itself, one render
   * before state catches up.
   */
  const setWrittenField = ({ refocus }: { refocus: boolean }) => {
    if (!writingField) return;
    const parsed = parseWritten(writingField, fieldDraft);
    const nextFields = { ...settingsRef.current.fields };
    if (parsed === null) delete nextFields[writingField.key];
    else nextFields[writingField.key] = parsed;
    settingsRef.current = { ...settingsRef.current, fields: nextFields };
    setSettings(settingsRef.current);
    setPicker(null);
    // Enter means "done, back to the title"; a tap-away already chose where focus goes.
    if (refocus) inputRef.current?.focus();
  };

  const choose = (option: PickerOption) => {
    if (!picker) return;
    setSettings((current) => {
      if (picker.kind === "category") return { ...current, category: option.value as PageCategory | null };
      if (picker.kind === "chapter") return { ...current, chapter: option.value as string | null };
      if (picker.kind === "assignee") return { ...current, assigneeId: option.value as string | null };
      if (picker.kind === "field" && picker.fieldKey) {
        // Choosing "not set" removes the key entirely, so the created page never carries it.
        const next = { ...current.fields };
        if (option.value === null) delete next[picker.fieldKey];
        else next[picker.fieldKey] = option.value;
        return { ...current, fields: next };
      }
      return { ...current, status: (option.value ?? "backlog") as PageStatus };
    });
    if (picker.commandStart !== null) {
      // Keep one trailing space so the next trigger char still follows
      // whitespace — commandAtEnd only fires after whitespace, and without
      // this a second command can't be typed until a space is added by hand.
      setTitle((current) => {
        const kept = current.slice(0, picker.commandStart!).trimEnd();
        return kept ? `${kept} ` : "";
      });
    }
    setPicker(null);
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!picker) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleOptions.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + direction + visibleOptions.length) % visibleOptions.length);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && visibleOptions.length > 0) {
      event.preventDefault();
      choose(visibleOptions[Math.min(highlighted, visibleOptions.length - 1)]);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || picker) return;
    const { fields: chosenFields, ...submitted } = settingsRef.current;
    setTitle("");
    // Settings carry over to the next page on purpose: runs of similar pages
    // shouldn't need re-picking. "start fresh" below returns to the defaults.
    setPicker(null);
    inputRef.current?.focus();
    // An empty patch is left off entirely, so a capture with no fields sends what it always sent.
    await onCreate({ title: cleanTitle, ...submitted, ...(Object.keys(chosenFields).length ? { fields: chosenFields } : {}) });
  };

  const resetSettings = () => {
    setSettings({ ...DEFAULT_SETTINGS, fields: {} });
    setPicker(null);
    inputRef.current?.focus();
  };

  const showTools = Boolean(title.trim()) || hasCustomSettings(settings);

  return (
    <form
      className={`quick-capture workspace-capture ${showTools ? "expanded" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPicker(null);
      }}
      onSubmit={(event) => void submit(event)}
    >
      <label className="sr-only" htmlFor="quick-page">Capture work page</label>
      <input
        aria-activedescendant={picker && visibleOptions.length ? `capture-option-${visibleOptions[Math.min(highlighted, visibleOptions.length - 1)].id}` : undefined}
        aria-controls={picker ? "capture-options" : undefined}
        aria-expanded={Boolean(picker)}
        aria-haspopup="listbox"
        autoComplete="off"
        id="quick-page"
        name="quickPage"
        onChange={changeTitle}
        onKeyDown={handleInputKeyDown}
        placeholder="Capture work..."
        ref={(node) => { inputRef.current = node; focusOnArrival(node); }}
        value={title}
      />
      <button className="primary-button" disabled={busy || !title.trim() || Boolean(picker)} type="submit">add page</button>

      {showTools && (
        <div className="capture-toolbar">
          <div className="capture-fields">
            <button
              aria-expanded={picker?.kind === "category"}
              aria-label={categoryLabel ? `Category: ${categoryLabel}` : "Choose category"}
              className={categoryLabel ? "capture-field active" : "capture-field"}
              onClick={() => openPicker("category")}
              style={selectedCategory ? ({ "--category-color": selectedCategory.color } as React.CSSProperties) : undefined}
              type="button"
            ><span aria-hidden="true">#</span>{categoryLabel ?? "category"}</button>
            {chapters.length > 0 && (
              <button
                aria-expanded={picker?.kind === "chapter"}
                aria-label={chapterLabel ? `Chapter: ${chapterLabel}` : "Choose chapter"}
                className={chapterLabel ? "capture-field active" : "capture-field"}
                onClick={() => openPicker("chapter")}
                type="button"
              ><span aria-hidden="true">~</span>{chapterLabel ?? "chapter"}</button>
            )}
            <button
              aria-expanded={picker?.kind === "assignee"}
              aria-label={assigneeLabel ? `Assignee: ${assigneeLabel}` : "Choose assignee"}
              className={assigneeLabel ? "capture-field active" : "capture-field"}
              onClick={() => openPicker("assignee")}
              type="button"
            ><span aria-hidden="true">@</span>{assigneeLabel ?? "assign"}</button>
            <button
              aria-expanded={picker?.kind === "status"}
              aria-label={settings.status === "backlog" ? "Choose column" : `Column: ${statusLabel}`}
              className={settings.status === "backlog" ? "capture-field" : "capture-field active"}
              onClick={() => openPicker("status")}
              type="button"
            >{/* The glyph is the trigger it teaches: typing "/" is what opens this picker. */}
            <span aria-hidden="true">/</span>{statusLabel}</button>
            {fieldChips.map((field) => {
              const chosen = settings.fields[field.key];
              const shown = typeof chosen === "string" && chosen.length > 18 ? `${chosen.slice(0, 17)}…` : chosen;
              const label = chosen === undefined
                ? field.label
                : field.type === "checkbox"
                  ? `${field.label}: ${chosen ? "yes" : "no"}`
                  : `${field.label}: ${shown}`;
              return (
                <button
                  aria-expanded={picker?.kind === "field" && picker.fieldKey === field.key}
                  aria-label={chosen === undefined ? `Choose ${field.label}` : label}
                  className={chosen === undefined ? "capture-field" : "capture-field active"}
                  key={field.key}
                  onClick={() => openPicker("field", field.key)}
                  type="button"
                ><span aria-hidden="true">•</span>{label}</button>
              );
            })}
          </div>
          {hasCustomSettings(settings) && (
            <button
              aria-label="Start fresh with default settings"
              className="reset-settings"
              onClick={resetSettings}
              type="button"
            ><span>start fresh</span></button>
          )}
        </div>
      )}

      {picker && writingField && (
        <div aria-label={`Set ${writingField.label}`} className="capture-picker capture-picker-field" id="capture-options" role="group">
          <header><span>{writingField.label}</span></header>
          <div className="capture-write">
            <label className="sr-only" htmlFor="capture-field-value">{writingField.label}</label>
            <input
              autoFocus
              id="capture-field-value"
              inputMode={writingField.type === "number" ? "decimal" : undefined}
              onBlur={() => setWrittenField({ refocus: false })}
              onChange={(event) => setFieldDraft(event.target.value)}
              onKeyDown={(event) => {
                // The panel owns its keys: Enter sets without submitting the capture form,
                // and Escape leaves the panel holding what the field held before.
                if (event.key === "Enter") {
                  event.preventDefault();
                  setWrittenField({ refocus: true });
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setPicker(null);
                  inputRef.current?.focus();
                }
              }}
              placeholder={writingField.type === "number" ? "A number..." : "A value..."}
              type={writingField.type === "date" ? "date" : "text"}
              value={fieldDraft}
            />
          </div>
        </div>
      )}

      {picker && !writingField && (
        <div aria-label={`Choose ${pickerHeading(picker, fieldChips).toLowerCase()}`} className={`capture-picker capture-picker-${picker.kind}`} id="capture-options" role="listbox">
          <header>
            <span>{pickerHeading(picker, fieldChips)}</span>
            {/* The project's own fields have no trigger character to teach. */}
            {picker.kind !== "field" && <kbd>{pickerTrigger(picker.kind)}</kbd>}
          </header>
          <div>
            {visibleOptions.map((option, index) => (
              <button
                aria-selected={option.value === selectedValue(settings, picker)}
                className={`${index === highlighted ? "highlighted" : ""} ${option.value === selectedValue(settings, picker) ? "selected" : ""}`}
                id={`capture-option-${option.id}`}
                key={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(option)}
                role="option"
                type="button"
              >
                {picker.kind === "category" && (
                  <span
                    className={`category-swatch ${option.value ? "" : "category-none"}`}
                    style={option.color ? ({ "--category-color": option.color } as React.CSSProperties) : undefined}
                  />
                )}
                {picker.kind === "status" && <span className={`column-dot ${option.value}`} />}
                <span>{option.label}</span>
                {option.value === selectedValue(settings, picker) && <span aria-hidden="true">✓</span>}
              </button>
            ))}
            {visibleOptions.length === 0 && <p>No matches</p>}
          </div>
        </div>
      )}
    </form>
  );
}

function commandAtEnd(value: string, caret: number): PickerState | null {
  if (caret !== value.length) return null;
  const match = value.match(/(^|\s)([#@/~])([^\s]*)$/);
  if (!match) return null;
  const kind = match[2] === "#"
    ? "category"
    : match[2] === "~"
      ? "chapter"
      : match[2] === "@" ? "assignee" : "status";
  return {
    kind,
    query: match[3].toLowerCase(),
    commandStart: value.length - match[2].length - match[3].length,
  };
}

function pickerOptions(
  picker: PickerState | null,
  categories: ProjectCategory[],
  chapters: Chapter[],
  members: Member[],
  fields: ProjectField[],
): PickerOption[] {
  const kind = picker?.kind ?? null;
  if (kind === "field") {
    const field = fields.find((candidate) => candidate.key === picker?.fieldKey);
    if (!field) return [];
    if (field.type === "checkbox") {
      return [
        { id: `field-${field.key}-none`, label: "Not set", search: "not set none clear", value: null },
        { id: `field-${field.key}-yes`, label: "Yes", search: "yes true checked", value: true },
        { id: `field-${field.key}-no`, label: "No", search: "no false unchecked", value: false },
      ];
    }
    return [
      { id: `field-${field.key}-none`, label: "Not set", search: "not set none clear", value: null },
      ...field.options.map((option) => ({
        id: `field-${field.key}-${option}`,
        label: option,
        search: option.toLowerCase(),
        value: option,
      })),
    ];
  }
  if (kind === "category") {
    return [
      { id: "category-none", label: "No category", search: "none uncategorized", value: null },
      ...categories.map((category) => ({
        id: `category-${category.slug}`,
        label: category.name,
        search: `${category.name} ${category.slug}`.toLowerCase(),
        value: category.slug,
        color: category.color,
      })),
    ];
  }
  if (kind === "chapter") {
    return [
      { id: "chapter-none", label: "No chapter", search: "none no chapter", value: null },
      ...chapters.map((chapter) => ({
        id: `chapter-${chapter.slug}`,
        label: chapter.state === "open" ? `${chapter.name} (open)` : chapter.name,
        search: `${chapter.name} ${chapter.slug}`.toLowerCase(),
        value: chapter.slug,
      })),
    ];
  }
  if (kind === "assignee") {
    return [
      { id: "assignee-none", label: "Unassigned", search: "unassigned none", value: null },
      ...members.map((member) => ({
        id: `assignee-${member.id}`,
        label: member.name,
        search: `${member.name} ${member.email}`.toLowerCase(),
        value: member.id,
      })),
    ];
  }
  if (kind === "status") {
    return [
      { id: "status-backlog", label: "Backlog", search: "backlog", value: "backlog" },
      { id: "status-ready", label: "Up Next", search: "up next ready", value: "ready" },
      { id: "status-in-progress", label: "In progress", search: "in progress active working", value: "in_progress" },
      { id: "status-review", label: "Review", search: "review check verify", value: "review" },
    ];
  }
  return [];
}

function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  if (!query) return options;
  return options
    .filter((option) => option.search.includes(query))
    .sort((left, right) => Number(!left.search.startsWith(query)) - Number(!right.search.startsWith(query)));
}

function selectedValue(settings: CaptureSettings, picker: PickerState): string | boolean | null {
  if (picker.kind === "category") return settings.category;
  if (picker.kind === "chapter") return settings.chapter;
  if (picker.kind === "assignee") return settings.assigneeId;
  if (picker.kind === "field") {
    const held = picker.fieldKey ? settings.fields[picker.fieldKey] : undefined;
    return held === undefined ? null : (held as string | boolean);
  }
  return settings.status;
}

function hasCustomSettings(settings: CaptureSettings): boolean {
  return (
    settings.category !== null ||
    settings.chapter !== null ||
    settings.assigneeId !== null ||
    settings.status !== "backlog" ||
    Object.keys(settings.fields).length > 0
  );
}

function pickerHeading(picker: PickerState, fields: ProjectField[]): string {
  if (picker.kind === "category") return "Category";
  if (picker.kind === "chapter") return "Chapter";
  if (picker.kind === "assignee") return "Assign to";
  if (picker.kind === "field") {
    return fields.find((candidate) => candidate.key === picker.fieldKey)?.label ?? "Field";
  }
  return "Column";
}

function pickerTrigger(kind: PickerKind): string {
  if (kind === "category") return "#";
  if (kind === "chapter") return "~";
  if (kind === "assignee") return "@";
  return "/";
}
