import { type FormEvent, useState } from "react";
import { FIELD_TYPES, type FieldType, type ProjectField } from "../../shared/types";
import { Growing } from "./Growing";
import type { SettingsRun } from "./use-settings-action";

export type FieldActions = {
  create: (input: { label: string; type: FieldType; options?: string[]; showOnTile?: boolean }) => Promise<void>;
  update: (key: string, input: { label?: string; options?: string[]; showOnTile?: boolean; position?: number }) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type Props = {
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

export function FieldsSection({ fields, busy, actions, canManage, run }: Props) {
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

  // Positions are index-shaped, so a move is two neighbours trading indexes.
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const moved = ordered[index];
    const displaced = ordered[target];
    void run(async () => {
      await actions.update(moved.key, { position: target });
      await actions.update(displaced.key, { position: index });
    }, "The field could not be moved");
  };

  if (!canManage) {
    return (
      <div className="settings-section">
        <p className="settings-summary">
          Extra properties every page can carry — a priority, an estimate, whatever this project tracks.
          Only an owner can change what exists; anyone can fill them in on a page.
        </p>
        <ul className="settings-readonly-list">
          {ordered.map((field) => (
            <li key={field.key}>
              {field.label}
              <span className="field-type">{TYPE_LABELS[field.type]}</span>
              {field.type === "select" && <span className="settings-summary">{optionsToText(field.options)}</span>}
            </li>
          ))}
          {ordered.length === 0 && <li className="settings-summary">No fields yet.</li>}
        </ul>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <p className="settings-summary field-intro">
        Extra properties every page can carry — a priority, an estimate, whatever this project tracks.
        Nothing here is counted or added up.
      </p>

      <div className="field-manager">
        {ordered.map((field, index) => (
          <Growing className="field-row" key={field.key}>
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
              <span className="reorder-buttons">
                <button
                  aria-label={`Move ${field.label} up`}
                  className="icon-button"
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                  type="button"
                >↑</button>
                <button
                  aria-label={`Move ${field.label} down`}
                  className="icon-button"
                  disabled={busy || index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                  type="button"
                >↓</button>
              </span>
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
          </Growing>
        ))}
        {ordered.length === 0 && <p className="empty-dependencies">No fields yet. Add the first one below.</p>}
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
          {newType === "select" && (
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
            disabled={busy || !newLabel.trim() || (newType === "select" && textToOptions(newOptions).length === 0)}
            type="submit"
          >add</button>
        </div>
      </form>
    </div>
  );
}
