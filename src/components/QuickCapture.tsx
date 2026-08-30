import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import {
  type Chapter,
  type FieldValue,
  type Member,
  PAGE_STATUS_LABELS,
  type PageCategory,
  type PageStatus,
  type ProjectCategory,
  type ProjectField,
} from "../../shared/types";
import { useCapturePicker } from "../hooks/use-capture-picker";
import { useTypingFocus } from "../hooks/use-typing-focus";
import { type CaptureSettings, commandAtEnd, hasCustomSettings } from "../lib/capture-pickers";
import { categoryColorStyle } from "../lib/category-style";
import { CapturePicker } from "./CapturePicker";

export type CapturePageInput = {
  title: string;
  category: PageCategory | null;
  chapter: string | null;
  assigneeId: string | null;
  status: PageStatus;
  /** Values for the project's own fields, present only for the ones actually chosen. */
  fields?: Record<string, FieldValue>;
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

/** New work belongs to the chapter the project has declared current, when it has one. */
function defaultSettings(chapters: Chapter[]): CaptureSettings {
  return {
    ...DEFAULT_SETTINGS,
    chapter: chapters.find((chapter) => chapter.state === "open")?.slug ?? null,
    fields: {},
  };
}

const statusLabels = PAGE_STATUS_LABELS;

export function QuickCapture({ busy, categories, chapters, fields = [], members, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [settings, setSettings] = useState<CaptureSettings>(() => defaultSettings(chapters));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * The caret lands here on a desktop, where typing was going to start anyway, and waits on a
   * phone, where it would raise the keyboard over the board the reader has just opened.
   */
  const focusOnArrival = useTypingFocus<HTMLInputElement>();
  const fieldChips = fields;
  const control = useCapturePicker({
    categories,
    chapters,
    fields: fieldChips,
    members,
    settings,
    settingsRef,
    setSettings,
    setTitle,
    inputRef,
  });
  const { picker, setPicker, highlighted, visibleOptions, openPicker, steerPicker } = control;
  const selectedCategory = settings.category
    ? (categories.find((category) => category.slug === settings.category) ?? null)
    : null;
  const categoryLabel = selectedCategory?.name ?? settings.category;
  const assigneeLabel = members.find((member) => member.id === settings.assigneeId)?.name ?? null;
  const chapterLabel = settings.chapter
    ? (chapters.find((chapter) => chapter.slug === settings.chapter)?.name ?? settings.chapter)
    : null;
  const statusLabel = statusLabels[settings.status] ?? "Backlog";

  const changeTitle = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setTitle(value);
    const command = commandAtEnd(value, event.target.selectionStart ?? value.length);
    setPicker(command);
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
    await onCreate({
      title: cleanTitle,
      ...submitted,
      ...(Object.keys(chosenFields).length ? { fields: chosenFields } : {}),
    });
  };

  const resetSettings = () => {
    setSettings(defaultSettings(chapters));
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
      <label className="sr-only" htmlFor="quick-page">
        Capture work page
      </label>
      <input
        role="combobox"
        aria-activedescendant={
          picker && visibleOptions.length
            ? `capture-option-${visibleOptions[Math.min(highlighted, visibleOptions.length - 1)]!.id}`
            : undefined
        }
        aria-controls={picker ? "capture-options" : undefined}
        aria-expanded={Boolean(picker)}
        aria-haspopup="listbox"
        autoComplete="off"
        id="quick-page"
        name="quickPage"
        onChange={changeTitle}
        onKeyDown={steerPicker}
        placeholder="Capture work..."
        ref={(node) => {
          inputRef.current = node;
          focusOnArrival(node);
        }}
        value={title}
      />
      <button className="primary-button" disabled={busy || !title.trim() || Boolean(picker)} type="submit">
        add page
      </button>

      {showTools && (
        <div className="capture-toolbar">
          <div className="capture-fields">
            <button
              aria-expanded={picker?.kind === "category"}
              aria-label={categoryLabel ? `Category: ${categoryLabel}` : "Choose category"}
              className={categoryLabel ? "capture-field active" : "capture-field"}
              onClick={() => openPicker("category")}
              style={selectedCategory ? categoryColorStyle(selectedCategory.color) : undefined}
              type="button"
            >
              <span aria-hidden="true">#</span>
              {categoryLabel ?? "category"}
            </button>
            {chapters.length > 0 && (
              <button
                aria-expanded={picker?.kind === "chapter"}
                aria-label={chapterLabel ? `Chapter: ${chapterLabel}` : "Choose chapter"}
                className={chapterLabel ? "capture-field active" : "capture-field"}
                onClick={() => openPicker("chapter")}
                type="button"
              >
                <span aria-hidden="true">~</span>
                {chapterLabel ?? "chapter"}
              </button>
            )}
            <button
              aria-expanded={picker?.kind === "assignee"}
              aria-label={assigneeLabel ? `Assignee: ${assigneeLabel}` : "Choose assignee"}
              className={assigneeLabel ? "capture-field active" : "capture-field"}
              onClick={() => openPicker("assignee")}
              type="button"
            >
              <span aria-hidden="true">@</span>
              {assigneeLabel ?? "assign"}
            </button>
            <button
              aria-expanded={picker?.kind === "status"}
              aria-label={settings.status === "backlog" ? "Choose column" : `Column: ${statusLabel}`}
              className={settings.status === "backlog" ? "capture-field" : "capture-field active"}
              onClick={() => openPicker("status")}
              type="button"
            >
              {/* The glyph is the trigger it teaches: typing "/" is what opens this picker. */}
              <span aria-hidden="true">/</span>
              {statusLabel}
            </button>
            {fieldChips.map((field) => {
              const chosen = settings.fields[field.key];
              const shown =
                typeof chosen === "string" && chosen.length > 18 ? `${chosen.slice(0, 17)}…` : chosen;
              const label =
                chosen === undefined
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
                >
                  <span aria-hidden="true">!</span>
                  {label}
                </button>
              );
            })}
          </div>
          {hasCustomSettings(settings) && (
            <button
              aria-label="Start fresh with default settings"
              className="reset-settings"
              onClick={resetSettings}
              type="button"
            >
              <span>start fresh</span>
            </button>
          )}
        </div>
      )}

      <CapturePicker control={control} fields={fieldChips} inputRef={inputRef} settings={settings} />
    </form>
  );
}
