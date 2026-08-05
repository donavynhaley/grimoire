import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type CardCategory, type CardStatus, type Member, type ProjectCategory } from "../../shared/types";

export type CaptureCardInput = {
  title: string;
  category: CardCategory | null;
  assigneeId: string | null;
  status: CardStatus;
};

type CaptureSettings = Omit<CaptureCardInput, "title">;
type PickerKind = "category" | "assignee" | "status";
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
  members: Member[];
  onCreate: (input: CaptureCardInput) => Promise<void>;
};

const DEFAULT_SETTINGS: CaptureSettings = {
  category: null,
  assigneeId: null,
  status: "backlog",
};

const statusLabels: Partial<Record<CardStatus, string>> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
};

export function QuickCapture({ busy, categories, members, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_SETTINGS);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [recent, setRecent] = useState<CaptureSettings | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useMemo(
    () => pickerOptions(picker?.kind ?? null, categories, members),
    [categories, members, picker?.kind],
  );
  const visibleOptions = useMemo(() => filterOptions(options, picker?.query ?? ""), [options, picker?.query]);
  const selectedCategory = settings.category
    ? categories.find((category) => category.slug === settings.category) ?? null
    : null;
  const categoryLabel = selectedCategory?.name ?? settings.category;
  const assigneeLabel = members.find((member) => member.id === settings.assigneeId)?.name ?? null;
  const statusLabel = statusLabels[settings.status] ?? "Backlog";

  useEffect(() => {
    setHighlighted(0);
  }, [picker?.kind, picker?.query]);

  useEffect(() => {
    if (!recent) return;
    const timeout = window.setTimeout(() => setRecent(null), 12_000);
    return () => window.clearTimeout(timeout);
  }, [recent]);

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
      if (picker.kind === "category") return { ...current, category: option.value as CardCategory | null };
      if (picker.kind === "assignee") return { ...current, assigneeId: option.value };
      return { ...current, status: (option.value ?? "backlog") as CardStatus };
    });
    if (picker.commandStart !== null) {
      setTitle((current) => current.slice(0, picker.commandStart!).trimEnd());
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
    setSettings(DEFAULT_SETTINGS);
    if (hasCustomSettings(submitted)) setRecent(submitted);
    setPicker(null);
    inputRef.current?.focus();
    await onCreate({ title: cleanTitle, ...submitted });
  };

  const reuseRecent = () => {
    if (!recent) return;
    setSettings(recent);
    setRecent(null);
    setPicker(null);
    inputRef.current?.focus();
  };

  const showTools = Boolean(title.trim()) || hasCustomSettings(settings);
  const recentSummary = recent ? settingsSummary(recent, categories, members) : "";

  return (
    <form
      className={`quick-capture workspace-capture ${showTools || recent ? "expanded" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPicker(null);
      }}
      onSubmit={(event) => void submit(event)}
    >
      <label className="sr-only" htmlFor="quick-card">Capture work card</label>
      <input
        aria-activedescendant={picker && visibleOptions.length ? `capture-option-${visibleOptions[Math.min(highlighted, visibleOptions.length - 1)].id}` : undefined}
        aria-controls={picker ? "capture-options" : undefined}
        aria-expanded={Boolean(picker)}
        aria-haspopup="listbox"
        autoComplete="off"
        autoFocus
        id="quick-card"
        name="quickCard"
        onChange={changeTitle}
        onKeyDown={handleInputKeyDown}
        placeholder="Capture work..."
        ref={inputRef}
        value={title}
      />
      <button className="primary-button" disabled={busy || !title.trim() || Boolean(picker)} type="submit">add card</button>

      {(showTools || recent) && (
        <div className="capture-toolbar">
          {showTools && <div className="capture-fields">
            <button
              aria-expanded={picker?.kind === "category"}
              aria-label={categoryLabel ? `Category: ${categoryLabel}` : "Choose category"}
              className={categoryLabel ? "capture-field active" : "capture-field"}
              onClick={() => openPicker("category")}
              style={selectedCategory ? ({ "--category-color": selectedCategory.color } as React.CSSProperties) : undefined}
              type="button"
            ><span aria-hidden="true">#</span>{categoryLabel ?? "category"}</button>
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
            ><span aria-hidden="true">→</span>{statusLabel}</button>
          </div>}
          {recent && (
            <button
              aria-label={`Reuse ${recentSummary} settings`}
              className="reuse-settings"
              onClick={reuseRecent}
              type="button"
            ><span>same settings</span><small>{recentSummary}</small></button>
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
  const match = value.match(/(^|\s)([#@/])([^\s]*)$/);
  if (!match) return null;
  const kind = match[2] === "#" ? "category" : match[2] === "@" ? "assignee" : "status";
  return {
    kind,
    query: match[3].toLowerCase(),
    commandStart: value.length - match[2].length - match[3].length,
  };
}

function pickerOptions(kind: PickerKind | null, categories: ProjectCategory[], members: Member[]): PickerOption[] {
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
  if (kind === "assignee") return settings.assigneeId;
  return settings.status;
}

function hasCustomSettings(settings: CaptureSettings): boolean {
  return settings.category !== null || settings.assigneeId !== null || settings.status !== "backlog";
}

function settingsSummary(settings: CaptureSettings, categories: ProjectCategory[], members: Member[]): string {
  const values = [
    settings.category
      ? categories.find((category) => category.slug === settings.category)?.name ?? settings.category
      : null,
    members.find((member) => member.id === settings.assigneeId)?.name ?? null,
    settings.status !== "backlog" ? statusLabels[settings.status] : null,
  ];
  return values.filter(Boolean).join(", ");
}

function pickerHeading(kind: PickerKind): string {
  if (kind === "category") return "Category";
  if (kind === "assignee") return "Assign to";
  return "Column";
}

function pickerTrigger(kind: PickerKind): string {
  if (kind === "category") return "#";
  if (kind === "assignee") return "@";
  return "/";
}
