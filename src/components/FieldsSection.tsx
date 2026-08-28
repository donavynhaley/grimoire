import { type FormEvent, useState } from "react";
import { FIELD_TYPES, fieldHasOptions, type FieldType, type ProjectField } from "../../shared/types";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";
import type { SettingsRun } from "../hooks/use-settings-action";

export type FieldActions = {
  create: (input: {
    label: string;
    type: FieldType;
    options?: string[];
    showOnTile?: boolean;
  }) => Promise<void>;
  update: (
    key: string,
    input: { label?: string; type?: FieldType; options?: string[]; showOnTile?: boolean; position?: number },
  ) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type Props = {
  /** Estimates are a built-in field with its own gate, so it lives with the others. */
  estimatesEnabled: boolean;
  onSetEstimatesEnabled: (enabled: boolean) => Promise<void>;
  fields: ProjectField[];
  busy: boolean;
  actions: FieldActions;
  /** Members read what the project tracks; only an owner decides it. */
  canManage: boolean;
  run: SettingsRun;
};

const TYPE_LABELS: Record<FieldType, string> = {
  text: "text",
  number: "number",
  select: "choice",
  "search-select": "searchable choice",
  date: "date",
  checkbox: "yes / no",
};

/** Said plainly, because the difference between these only matters once you pick one. */
const TYPE_HINTS: Record<FieldType, string> = {
  text: "Anything typed in.",
  number: "A number someone wrote down. Nothing adds them up.",
  select: "One of a fixed set of answers you list, offered as buttons.",
  "search-select": "The same fixed answers, found by typing - for lists too long to read.",
  date: "A day, like 2026-08-16.",
  checkbox: "Yes or no.",
};

/**
 * The other way a choice field can ask.
 *
 * Which one a project wants is a fact about how long its option list grew, and that is learned
 * after the field exists — so this is a swap, not a decision made once at creation.
 */
function otherChoiceType(type: FieldType): FieldType {
  return type === "search-select" ? "select" : "search-select";
}

function optionsToText(options: string[]): string {
  return options.join(", ");
}

function textToOptions(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((option) => option.trim())
        .filter(Boolean),
    ),
  ];
}

export function FieldsSection({
  estimatesEnabled,
  onSetEstimatesEnabled,
  fields,
  busy,
  actions,
  canManage,
  run,
}: Props) {
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");
  const [newOptions, setNewOptions] = useState("");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const ordered = [...fields].sort((a, b) => a.position - b.position);

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    const options = textToOptions(newOptions);
    void run(async () => {
      await actions.create({ label, type: newType, ...(fieldHasOptions(newType) ? { options } : {}) });
      setNewLabel("");
      setNewOptions("");
      setNewType("text");
    }, "The field could not be created");
  };

  const saveLabel = (field: ProjectField) => {
    const draft = labelDrafts[field.key]?.trim();
    if (draft === undefined || draft === field.label) return;
    if (!draft) {
      setLabelDrafts((current) => ({ ...current, [field.key]: field.label }));
      return;
    }
    void run(() => actions.update(field.key, { label: draft }), "The field could not be renamed");
  };

  const saveOptions = (field: ProjectField) => {
    const draft = optionDrafts[field.key];
    if (draft === undefined) return;
    const options = textToOptions(draft);
    if (optionsToText(options) === optionsToText(field.options)) return;
    if (options.length === 0) {
      setOptionDrafts((current) => ({ ...current, [field.key]: optionsToText(field.options) }));
      return;
    }
    void run(() => actions.update(field.key, { options }), "The options could not be changed");
  };

  // Positions are index-shaped, so a move is two neighbours trading indexes.
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const moved = ordered[index]!;
    const displaced = ordered[target]!;
    void run(async () => {
      await actions.update(moved.key, { position: target });
      await actions.update(displaced.key, { position: index });
    }, "The field could not be moved");
  };

  if (!canManage) {
    return (
      <div className="settings-section">
        <p className="settings-summary">
          Extra properties every page can carry — a priority, an estimate, whatever this project tracks. Only
          an owner can change what exists; anyone can fill them in on a page.
        </p>
        <ul className="settings-readonly-list">
          {ordered.map((field) => (
            <li key={field.key}>
              {field.label}
              <span className="field-type">{TYPE_LABELS[field.type]}</span>
              {fieldHasOptions(field.type) && (
                <span className="settings-summary">{optionsToText(field.options)}</span>
              )}
            </li>
          ))}
          {ordered.length === 0 && <li className="settings-summary">No fields yet.</li>}
        </ul>
      </div>
    );
  }

  return (
    <div className="settings-section">
      {canManage && (
        <Growing className="settings-row chapters-gate">
          <div className="settings-row-top">
            <span className="field-label">Estimates</span>
            <label className="settings-toggle">
              <input
                aria-label="Estimates"
                checked={estimatesEnabled}
                disabled={busy}
                name="estimatesEnabled"
                onChange={(event) =>
                  void run(
                    () => onSetEstimatesEnabled(event.target.checked),
                    "The estimates setting could not be changed",
                  )
                }
                type="checkbox"
              />
              <span aria-hidden="true" className="settings-knob" />
              <span className="settings-toggle-label">{estimatesEnabled ? "on" : "off"}</span>
            </label>
          </div>
          <p className="settings-summary">
            A number on every page saying how much work it is, in whatever unit this team means by one.
            Nothing forecasts or multiplies it; with chapters on, it is added up per chapter so a closed
            stretch can say what it delivered.
          </p>
        </Growing>
      )}
      <p className="settings-summary field-intro">
        Extra properties every page can carry — a priority, an estimate, whatever this project tracks. Nothing
        here is counted or added up.
      </p>

      <div className="field-manager">
        {ordered.map((field, index) => (
          <Growing className="field-row" key={field.key}>
            <div className="field-row-top">
              <label className="sr-only" htmlFor={`field-label-${field.key}`}>
                Rename {field.label}
              </label>
              <input
                id={`field-label-${field.key}`}
                name={`fieldLabel-${field.key}`}
                onBlur={() => saveLabel(field)}
                onChange={(event) =>
                  setLabelDrafts((current) => ({ ...current, [field.key]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveLabel(field);
                  }
                }}
                value={labelDrafts[field.key] ?? field.label}
              />
              {/* The type is fixed once values exist under it, except between the two choice
                  kinds, where nothing stored changes and only the control does. */}
              {fieldHasOptions(field.type) ? (
                <button
                  aria-label={`Show ${field.label} as ${TYPE_LABELS[otherChoiceType(field.type)]}`}
                  className="field-type as-toggle"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => actions.update(field.key, { type: otherChoiceType(field.type) }),
                      "The field could not be changed",
                    )
                  }
                  title={TYPE_HINTS[otherChoiceType(field.type)]}
                  type="button"
                >
                  {TYPE_LABELS[field.type]}
                </button>
              ) : (
                <span className="field-type">{TYPE_LABELS[field.type]}</span>
              )}
              <label className="settings-toggle compact">
                <input
                  aria-label={`Show ${field.label} on tiles`}
                  checked={field.showOnTile}
                  disabled={busy}
                  name={`fieldOnTile-${field.key}`}
                  onChange={(event) =>
                    void run(
                      () => actions.update(field.key, { showOnTile: event.target.checked }),
                      "The field could not be changed",
                    )
                  }
                  type="checkbox"
                />
                <span aria-hidden="true" className="settings-knob" />
                <span className="settings-toggle-label">on tiles</span>
              </label>
              <span className="reorder-buttons">
                <button
                  aria-label={`Move ${field.label} up`}
                  className="icon-button"
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${field.label} down`}
                  className="icon-button"
                  disabled={busy || index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                  type="button"
                >
                  ↓
                </button>
              </span>
              <ConfirmInline
                cancelAriaLabel={`Cancel deleting ${field.label}`}
                className="archive-confirm"
                confirmAriaLabel={`Confirm delete ${field.label}`}
                confirmDisabled={busy}
                onCancel={() => setRemoving(null)}
                onConfirm={() =>
                  void run(async () => {
                    await actions.remove(field.key);
                    setRemoving(null);
                  }, "The field could not be deleted")
                }
                onOpen={() => setRemoving(field.key)}
                open={removing === field.key}
                question="remove?"
                trigger="×"
                triggerAriaLabel={`Delete ${field.label}`}
                triggerClass="icon-button"
              />
            </div>
            {removing === field.key && (
              <p className="settings-summary field-warning">
                Deleting it also clears its value from every page that has one.
              </p>
            )}
            {fieldHasOptions(field.type) && (
              <div className="field-options">
                <label className="sr-only" htmlFor={`field-options-${field.key}`}>
                  Options for {field.label}
                </label>
                <input
                  id={`field-options-${field.key}`}
                  name={`fieldOptions-${field.key}`}
                  onBlur={() => saveOptions(field)}
                  onChange={(event) =>
                    setOptionDrafts((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveOptions(field);
                    }
                  }}
                  placeholder="p0, p1, p2"
                  value={optionDrafts[field.key] ?? optionsToText(field.options)}
                />
                <span className="settings-summary">
                  Comma separated. Removing one clears it from any page holding it.
                </span>
              </div>
            )}
          </Growing>
        ))}
        {ordered.length === 0 && (
          <p className="empty-dependencies">No fields yet. Add the first one below.</p>
        )}
      </div>

      <form className="field-add" onSubmit={submitCreate}>
        <span className="field-label">Add a field</span>
        <div className="field-type-picker" role="group" aria-label="Field type">
          {FIELD_TYPES.map((type) => (
            <button
              aria-pressed={newType === type}
              className={newType === type ? "selected" : ""}
              key={type}
              onClick={() => setNewType(type)}
              type="button"
            >
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
        <p className="settings-summary">{TYPE_HINTS[newType]}</p>
        <div className="field-add-row">
          <label className="sr-only" htmlFor="new-field-label">
            New field name
          </label>
          <input
            id="new-field-label"
            name="newFieldLabel"
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder="Field name..."
            value={newLabel}
          />
          {fieldHasOptions(newType) && (
            <>
              <label className="sr-only" htmlFor="new-field-options">
                Options
              </label>
              <input
                id="new-field-options"
                name="newFieldOptions"
                onChange={(event) => setNewOptions(event.target.value)}
                placeholder="p0, p1, p2"
                value={newOptions}
              />
            </>
          )}
          <button
            className="primary-button compact"
            disabled={
              busy || !newLabel.trim() || (fieldHasOptions(newType) && textToOptions(newOptions).length === 0)
            }
            type="submit"
          >
            add
          </button>
        </div>
      </form>
    </div>
  );
}
