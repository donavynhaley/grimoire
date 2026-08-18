import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type PageCategory, type PageStatus, type Chapter, type Member, type ProjectCategory } from "../../shared/types";
import { useTypingFocus } from "./use-typing-focus";

export type CapturePageInput = {
  title: string;
  category: PageCategory | null;
  chapter: string | null;
  assigneeId: string | null;
  status: PageStatus;
};

type CaptureSettings = Omit<CapturePageInput, "title">;
type PickerKind = "category" | "chapter" | "assignee" | "status";
type PickerState = {
  kind: PickerKind;
  query: string;
  commandStart: number | null;
};
type PickerOption = {
  id: string;
  label: string;
  search: string;
  value: string | null;
  color?: string;
};

type Props = {
  busy: boolean;
  categories: ProjectCategory[];
  /** Empty when the project has not enabled chapters, which hides the control entirely. */
  chapters: Chapter[];
  members: Member[];
  onCreate: (input: CapturePageInput) => Promise<void>;
};

const DEFAULT_SETTINGS: CaptureSettings = {
  category: null,
  chapter: null,
  assigneeId: null,
  status: "backlog",
};

const statusLabels: Partial<Record<PageStatus, string>> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
};

export function QuickCapture({ busy, categories, chapters, members, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_SETTINGS);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * The caret lands here on a desktop, where typing was going to start anyway, and waits on a
   * phone, where it would raise the keyboard over the board the reader has just opened.
   */
  const focusOnArrival = useTypingFocus<HTMLInputElement>();
  const options = useMemo(
    () => pickerOptions(picker?.kind ?? null, categories, chapters, members),
    [categories, chapters, members, picker?.kind],
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

  const openPicker = (kind: PickerKind) => {
    setPicker({ kind, query: "", commandStart: null });
    setHighlighted(0);
  };

  const choose = (option: PickerOption) => {
    if (!picker) return;
    setSettings((current) => {
      if (picker.kind === "category") return { ...current, category: option.value as PageCategory | null };
      if (picker.kind === "chapter") return { ...current, chapter: option.value };
      if (picker.kind === "assignee") return { ...current, assigneeId: option.value };
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
    const submitted = settings;
    setTitle("");
    // Settings carry over to the next page on purpose: runs of similar pages
    // shouldn't need re-picking. "start fresh" below returns to the defaults.
    setPicker(null);
    inputRef.current?.focus();
    await onCreate({ title: cleanTitle, ...submitted });
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
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

      {picker && (
        <div aria-label={`Choose ${pickerHeading(picker.kind).toLowerCase()}`} className={`capture-picker capture-picker-${picker.kind}`} id="capture-options" role="listbox">
          <header><span>{pickerHeading(picker.kind)}</span><kbd>{pickerTrigger(picker.kind)}</kbd></header>
          <div>
            {visibleOptions.map((option, index) => (
              <button
                aria-selected={option.value === selectedValue(settings, picker.kind)}
                className={`${index === highlighted ? "highlighted" : ""} ${option.value === selectedValue(settings, picker.kind) ? "selected" : ""}`}
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
                {option.value === selectedValue(settings, picker.kind) && <span aria-hidden="true">✓</span>}
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
  kind: PickerKind | null,
  categories: ProjectCategory[],
  chapters: Chapter[],
  members: Member[],
): PickerOption[] {
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

function selectedValue(settings: CaptureSettings, kind: PickerKind): string | null {
  if (kind === "category") return settings.category;
  if (kind === "chapter") return settings.chapter;
  if (kind === "assignee") return settings.assigneeId;
  return settings.status;
}

function hasCustomSettings(settings: CaptureSettings): boolean {
  return (
    settings.category !== null ||
    settings.chapter !== null ||
    settings.assigneeId !== null ||
    settings.status !== "backlog"
  );
}

function pickerHeading(kind: PickerKind): string {
  if (kind === "category") return "Category";
  if (kind === "chapter") return "Chapter";
  if (kind === "assignee") return "Assign to";
  return "Column";
}

function pickerTrigger(kind: PickerKind): string {
  if (kind === "category") return "#";
  if (kind === "chapter") return "~";
  if (kind === "assignee") return "@";
  return "/";
}
