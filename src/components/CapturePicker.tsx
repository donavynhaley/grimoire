import type { RefObject } from "react";
import type { ProjectField } from "../../shared/types";
import type { CapturePickerControl } from "../hooks/use-capture-picker";
import { type CaptureSettings, pickerHeading, pickerTrigger, selectedValue } from "../lib/capture-pickers";
import { categoryColorStyle } from "../lib/category-style";

type Props = {
  control: CapturePickerControl;
  /** The project's own fields, naming the "!" list and each field's panel. */
  fields: ProjectField[];
  /** The capture's title input, where focus returns when the panel closes from the keyboard. */
  inputRef: RefObject<HTMLInputElement | null>;
  settings: CaptureSettings;
};

/**
 * The open picker under the capture bar: a written field's panel when the open field is
 * written in, otherwise the listbox of choices.
 */
export function CapturePicker({ control, fields, inputRef, settings }: Props) {
  const {
    picker,
    setPicker,
    highlighted,
    setHighlighted,
    options,
    visibleOptions,
    openField,
    writingField,
    fieldDraft,
    setFieldDraft,
    setWrittenField,
    choose,
  } = control;
  if (!picker) return null;

  if (writingField) {
    return (
      <div
        aria-label={`Set ${writingField.label}`}
        className="capture-picker capture-picker-field"
        id="capture-options"
        role="group"
      >
        <header>
          <span>{writingField.label}</span>
        </header>
        <div className="capture-write">
          <label className="sr-only" htmlFor="capture-field-value">
            {writingField.label}
          </label>
          <input
            // biome-ignore lint/a11y/noAutofocus: this input is mounted by the user's own action - it exists because they clicked add, edit or open - so focus follows the request rather than stealing it on arrival, which is the case the rule is for
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
    );
  }

  return (
    <div className={`capture-picker capture-picker-${picker.kind}`}>
      <header>
        <span>{pickerHeading(picker, fields)}</span>
        <kbd>{pickerTrigger(picker.kind)}</kbd>
      </header>
      {openField?.type === "search-select" && (
        <div className="capture-write capture-filter">
          <label
            className="sr-only"
            htmlFor="capture-field-filter"
          >{`Search ${openField.label} options`}</label>
          <input
            // biome-ignore lint/a11y/noAutofocus: this input is mounted by the user's own action - it exists because they clicked add, edit or open - so focus follows the request rather than stealing it on arrival, which is the case the rule is for
            autoFocus
            id="capture-field-filter"
            onChange={(event) =>
              setPicker((current) =>
                current ? { ...current, query: event.target.value.toLowerCase() } : current,
              )
            }
            onKeyDown={(event) => {
              // Enter takes the best match, the way the title bar's typed pickers do.
              if (event.key === "Enter") {
                event.preventDefault();
                if (visibleOptions.length > 0) choose(visibleOptions[0]!);
                return;
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setPicker(null);
                inputRef.current?.focus();
              }
            }}
            placeholder="Type to search..."
            type="search"
            value={picker.query}
          />
        </div>
      )}
      {/*
        The listbox is the options and nothing else - the header and the search field
        are neighbours, not options - and what is "selected" for assistive tech is the
        row the keyboard is on, the same row aria-activedescendant names. The value the
        page already holds stays a visual mark.
      */}
      <div
        aria-label={`Choose ${pickerHeading(picker, fields).toLowerCase()}`}
        id="capture-options"
        role="listbox"
      >
        {visibleOptions.map((option, index) => {
          const chosen = picker.kind !== "field-cmd" && option.value === selectedValue(settings, picker);
          return (
            <button
              aria-selected={index === highlighted}
              className={`${index === highlighted ? "highlighted" : ""} ${chosen ? "selected" : ""}`}
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
                  style={option.color ? categoryColorStyle(option.color) : undefined}
                />
              )}
              {picker.kind === "status" && <span className={`column-dot ${option.value}`} />}
              <span>{option.label}</span>
              {option.hint && (
                <span aria-hidden="true" className="option-hint">
                  {option.hint}
                </span>
              )}
              {chosen && <span aria-hidden="true">✓</span>}
            </button>
          );
        })}
        {visibleOptions.length === 0 && (
          <p>
            {picker.kind === "field-cmd" && options.length === 0
              ? "This project has no fields yet. Define them in project settings."
              : "No matches"}
          </p>
        )}
      </div>
    </div>
  );
}
