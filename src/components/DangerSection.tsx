import { useEffect, useState } from "react";
import type { ArchivedProject } from "../../shared/types";
import { archivedProjects } from "../api/client";
import type { SettingsRun } from "../hooks/use-settings-action";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";

type DangerProps = {
  busy: boolean;
  canArchive: boolean;
  projectName: string;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  run: SettingsRun;
};

export function DangerSection({ busy, canArchive, projectName, onArchive, onRestore, run }: DangerProps) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archived, setArchived] = useState<ArchivedProject[] | null>(null);
  const [listFailed, setListFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    archivedProjects()
      .then((value) => {
        if (alive) setArchived(value.projects);
      })
      .catch(() => {
        if (alive) setListFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="settings-section">
      <Growing className="settings-row danger">
        <span className="field-label danger-label">Archive this project</span>
        <div className="settings-row-top">
          <p className="settings-summary">
            {canArchive
              ? "Archiving hides this project for everyone. Its files stay on disk, and it can be restored from the list below."
              : "The last project cannot be archived."}
          </p>
          <ConfirmInline
            className="archive-confirm"
            confirmDisabled={busy}
            onCancel={() => setConfirmingArchive(false)}
            onConfirm={() => void run(() => onArchive(), "The project could not be archived")}
            onOpen={() => setConfirmingArchive(true)}
            open={confirmingArchive}
            question={`archive ${projectName}?`}
            trigger="archive project"
            triggerClass="danger-text"
            triggerDisabled={!canArchive}
          />
        </div>
      </Growing>

      <Growing className="settings-row archived-projects">
        <span className="field-label">Archived projects</span>
        {listFailed ? (
          <p className="settings-summary">The archived list could not be loaded.</p>
        ) : archived === null ? (
          <p className="settings-summary">Loading…</p>
        ) : archived.length === 0 ? (
          <p className="settings-summary">Nothing is archived.</p>
        ) : (
          <ul className="archived-project-list">
            {archived.map((candidate) => (
              <li key={candidate.id}>
                <span>{candidate.name}</span>
                <button
                  aria-label={`Restore ${candidate.name}`}
                  className="settings-link"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await onRestore(candidate.id);
                      setArchived((current) => current?.filter((value) => value.id !== candidate.id) ?? null);
                    }, `${candidate.name} could not be restored`)
                  }
                  type="button"
                >
                  restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </Growing>
    </div>
  );
}
