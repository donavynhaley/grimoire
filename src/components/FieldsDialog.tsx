import { type FormEvent, useState } from "react";
import { FIELD_TYPES, type FieldType, type ProjectField } from "../../shared/types";
import { ApiError } from "../api/client";
import { useDialogEscape } from "./use-dialog-escape";

export type FieldActions = {
  create: (input: { label: string; type: FieldType; options?: string[]; showOnTile?: boolean }) => Promise<void>;
  update: (key: string, input: { label?: string; options?: string[]; showOnTile?: boolean }) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type Props = {
  fields: ProjectField[];
  busy: boolean;
  actions: FieldActions;
  onClose: () => void;
};

const TYPE_LABELS: Record<FieldType, string> = {
  text: "text",
  number: "number",
  select: "choice",
  date: "date",
  checkbox: "yes / no",
};

/** Said plainly, because the difference between these only matters once you pick one. */
const TYPE_HINTS: Record<FieldType, string> = {
  text: "Anything typed in.",
  number: "A number someone wrote down. Nothing adds them up.",
  select: "One of a fixed set of answers you list.",
  date: "A day, like 2026-08-16.",
  checkbox: "Yes or no.",
};

function optionsToText(options: string[]): string {
  return options.join(", ");
}

function textToOptions(value: string): string[] {
  return [...new Set(value.split(",").map((option) => option.trim()).filter(Boolean))];
}

export function FieldsDialog({ fields, busy, actions, onClose }: Props) {
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");
  const [newOptions, setNewOptions] = useState("");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");

  const run = async (change: () => Promise<void>, failure: string) => {
    setError("");
    try {
      await change();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : failure);
    }
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    const options = textToOptions(newOptions);
    void run(async () => {
      await actions.create({ label, type: newType, ...(newType === "select" ? { options } : {}) });
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

  useDialogEscape(onClose);

  const creatingChoice = newType === "select";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="fields-dialog-title" aria-modal="true" className="dialog-panel fields-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">project setup</p><h2 id="fields-dialog-title">Page fields</h2></div>
          <button aria-label="Close fields" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <p className="settings-summary field-intro">
          Extra properties every page can carry — a priority, an estimate, whatever this project tracks.
          Nothing here is counted or added up.
        </p>

        <div className="field-manager">
          {fields.map((field) => (
            <div className="field-row" key={field.key}>
              <div className="field-row-top">
                <label className="sr-only" htmlFor={`field-label-${field.key}`}>Rename {field.label}</label>
                <input
                  id={`field-label-${field.key}`}
                  name={`fieldLabel-${field.key}`}
                  onBlur={() => saveLabel(field)}
                  onChange={(event) => setLabelDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveLabel(field); } }}
                  value={labelDrafts[field.key] ?? field.label}
                />
                {/* The type is fixed once values exist under it, so it reads rather than edits. */}
                <span className="field-type">{TYPE_LABELS[field.type]}</span>
                <label className="settings-toggle compact">
                  <input
                    aria-label={`Show ${field.label} on tiles`}
                    checked={field.showOnTile}
                    disabled={busy}
                    name={`fieldOnTile-${field.key}`}
                    onChange={(event) => void run(
                      () => actions.update(field.key, { showOnTile: event.target.checked }),
                      "The field could not be changed",
                    )}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="settings-knob" />
                  <span className="settings-toggle-label">on tiles</span>
                </label>
                {removing === field.key ? (
                  <span className="archive-confirm">
                    <span>remove?</span>
                    <button
                      aria-label={`Confirm delete ${field.label}`}
                      className="danger-text"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await actions.remove(field.key);
                        setRemoving(null);
                      }, "The field could not be deleted")}
                      type="button"
                    >yes</button>
                    <button aria-label={`Cancel deleting ${field.label}`} onClick={() => setRemoving(null)} type="button">no</button>
                  </span>
                ) : (
                  <button
                    aria-label={`Delete ${field.label}`}
                    className="icon-button"
                    onClick={() => setRemoving(field.key)}
                    type="button"
                  >×</button>
                )}
              </div>
              {removing === field.key && (
                <p className="settings-summary field-warning">
                  Deleting it also clears its value from every page that has one.
                </p>
              )}
              {field.type === "select" && (
                <div className="field-options">
                  <label className="sr-only" htmlFor={`field-options-${field.key}`}>Options for {field.label}</label>
                  <input
                    id={`field-options-${field.key}`}
                    name={`fieldOptions-${field.key}`}
                    onBlur={() => saveOptions(field)}
                    onChange={(event) => setOptionDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveOptions(field); } }}
                    placeholder="p0, p1, p2"
                    value={optionDrafts[field.key] ?? optionsToText(field.options)}
                  />
                  <span className="settings-summary">
                    Comma separated. Removing one clears it from any page holding it.
                  </span>
                </div>
              )}
            </div>
          ))}
          {fields.length === 0 && <p className="empty-dependencies">No fields yet. Add the first one below.</p>}
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
              >{TYPE_LABELS[type]}</button>
            ))}
          </div>
          <p className="settings-summary">{TYPE_HINTS[newType]}</p>
          <div className="field-add-row">
            <label className="sr-only" htmlFor="new-field-label">New field name</label>
            <input
              id="new-field-label"
              name="newFieldLabel"
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="Field name..."
              value={newLabel}
            />
            {creatingChoice && (
              <>
                <label className="sr-only" htmlFor="new-field-options">Options</label>
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
              disabled={busy || !newLabel.trim() || (creatingChoice && textToOptions(newOptions).length === 0)}
              type="submit"
            >add</button>
          </div>
        </form>

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
