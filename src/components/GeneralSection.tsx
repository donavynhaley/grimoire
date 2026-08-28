import { useState } from "react";
import type { SettingsRun } from "../hooks/use-settings-action";

type GeneralProps = {
  busy: boolean;
  canManage: boolean;
  project: { id: string; name: string; description: string; githubRepo: string; githubTokenSet: boolean };
  onRename: (name: string) => Promise<void>;
  onSetDescription: (description: string) => Promise<void>;
  run: SettingsRun;
};

export function GeneralSection({ busy, canManage, project, onRename, onSetDescription, run }: GeneralProps) {
  const [nameDraft, setNameDraft] = useState<string | undefined>(undefined);
  const [descriptionDraft, setDescriptionDraft] = useState<string | undefined>(undefined);
  const name = nameDraft ?? project.name;
  const description = descriptionDraft ?? project.description;

  const saveName = () => {
    const next = name.trim();
    if (!next) {
      setNameDraft(undefined);
      return;
    }
    if (next === project.name) return;
    void run(async () => {
      await onRename(next);
      setNameDraft(undefined);
    }, "The project could not be renamed");
  };

  const saveDescription = () => {
    const next = description.trim();
    if (next === project.description) return;
    void run(async () => {
      await onSetDescription(next);
      setDescriptionDraft(undefined);
    }, "The description could not be saved");
  };

  if (!canManage) {
    return (
      <div className="settings-section">
        <div className="settings-row">
          <span className="field-label">Name</span>
          <p className="settings-readonly-value">{project.name}</p>
        </div>
        <div className="settings-row">
          <span className="field-label">Description</span>
          <p className="settings-readonly-value">{project.description || "No description yet."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="settings-row">
        <label className="field-label" htmlFor="settings-project-name">
          Name
        </label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-project-name"
            name="projectName"
            onBlur={saveName}
            onChange={(event) => setNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveName();
              }
            }}
            value={name}
          />
        </div>
      </div>
      <div className="settings-row">
        <label className="field-label" htmlFor="settings-project-description">
          Description
        </label>
        <textarea
          disabled={busy}
          id="settings-project-description"
          name="projectDescription"
          onBlur={saveDescription}
          onChange={(event) => setDescriptionDraft(event.target.value)}
          placeholder="One sentence saying what this project is. It shows in the project switcher."
          rows={2}
          value={description}
        />
      </div>
    </div>
  );
}
