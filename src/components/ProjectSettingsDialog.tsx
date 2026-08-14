import { type FormEvent, useState } from "react";
import type { Page, Chapter, ProjectCategory } from "../../shared/types";
import { ApiError } from "../api/client";
import { dayLabel } from "./chapter-dates";
import { useDialogEscape } from "./use-dialog-escape";

export type ProjectSettingsActions = {
  rename: (name: string) => Promise<void>;
  setChaptersEnabled: (enabled: boolean) => Promise<void>;
  archive: () => Promise<void>;
};

type Props = {
  actions: ProjectSettingsActions;
  busy: boolean;
  canArchive: boolean;
  /** Issuing a credential is the owner's decision, so members never see the section. */
  canManageAgents: boolean;
  agentCount: number;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  chaptersEnabled: boolean;
  project: { id: string; name: string };
  onClose: () => void;
  onManageAgents: () => void;
  onManageCategories: () => void;
  onManageChapters: () => void;
};

/**
 * One place for everything that configures a project.
 *
 * The project dropdown used to carry these as a wrapping row of bare text links, which grew
 * by one every time the product gained a project-level idea. Here each concern is a section
 * with a live summary, so the next one adds a section rather than another link - and a
 * genuine on/off state like the chapters gate has somewhere honest to sit, instead of
 * masquerading as a verb.
 */
export function ProjectSettingsDialog({
  actions,
  busy,
  canArchive,
  canManageAgents,
  agentCount,
  pages,
  categories,
  chapters,
  chaptersEnabled,
  project,
  onClose,
  onManageAgents,
  onManageCategories,
  onManageChapters,
}: Props) {
  const [name, setName] = useState(project.name);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [error, setError] = useState("");
  const current = chapters.find((chapter) => chapter.state === "open");
  const placed = pages.filter((page) => page.chapter !== null).length;

  const run = async (change: () => Promise<void>, failure: string) => {
    setError("");
    try {
      await change();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : failure);
    }
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === project.name) return;
    void run(() => actions.rename(next), "The project could not be renamed");
  };

  useDialogEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="project-settings-title" aria-modal="true" className="dialog-panel settings-dialog" role="dialog">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">project settings</p>
            <h2 id="project-settings-title">{project.name}</h2>
          </div>
          <button aria-label="Close project settings" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <form className="settings-row" onSubmit={submitRename}>
          <span className="field-label">Name</span>
          <div className="settings-input">
            <label className="sr-only" htmlFor="settings-project-name">Project name</label>
            <input
              id="settings-project-name"
              name="projectName"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <button
              className="primary-button compact"
              disabled={busy || !name.trim() || name.trim() === project.name}
              type="submit"
            >save</button>
          </div>
        </form>

        <div className="settings-row">
          <div className="settings-row-top">
            <span className="field-label">Categories</span>
            <button className="settings-link" onClick={onManageCategories} type="button">edit →</button>
          </div>
          <p className="settings-summary">
            {categories.length === 0
              ? "None yet"
              : `${categories.length} in use · ${categories.slice(0, 4).map((category) => category.name).join(", ")}${categories.length > 4 ? ` +${categories.length - 4}` : ""}`}
          </p>
        </div>

        <div className="settings-row">
          <div className="settings-row-top">
            <span className="field-label">Chapters</span>
            <label className="settings-toggle">
              <input
                aria-label="Chapters"
                checked={chaptersEnabled}
                disabled={busy}
                name="chaptersEnabled"
                onChange={(event) => void run(
                  () => actions.setChaptersEnabled(event.target.checked),
                  "The chapters setting could not be changed",
                )}
                type="checkbox"
              />
              <span aria-hidden="true" className="settings-knob" />
              <span className="settings-toggle-label">{chaptersEnabled ? "on" : "off"}</span>
            </label>
          </div>
          <p className="settings-summary">
            {!chaptersEnabled
              ? "Group pages into named stretches of work. No points, no rollover."
              : current
                ? `Open: ${current.name}${current.startsOn && current.endsOn ? ` · ${dayLabel(current.startsOn)} → ${dayLabel(current.endsOn)}` : current.endsOn ? ` · ends ${dayLabel(current.endsOn)}` : ""}`
                : "No chapter open right now."}
          </p>
          {chaptersEnabled && (
            <div className="settings-row-top">
              <p className="settings-summary">
                {chapters.length} chapter{chapters.length === 1 ? "" : "s"} · {placed} page{placed === 1 ? "" : "s"} placed
              </p>
              <button className="settings-link" onClick={onManageChapters} type="button">manage →</button>
            </div>
          )}
        </div>

        {canManageAgents && (
          <div className="settings-row">
            <div className="settings-row-top">
              <span className="field-label">Agent access</span>
              <button className="settings-link" onClick={onManageAgents} type="button">manage →</button>
            </div>
            <p className="settings-summary">
              {agentCount === 0
                ? "Let an agent write pages here. It acts as you, and can never archive or promote."
                : `${agentCount} agent${agentCount === 1 ? "" : "s"} with access · each acts as the person who issued it`}
            </p>
          </div>
        )}

        <div className="settings-row danger">
          <span className="field-label danger-label">Danger zone</span>
          <div className="settings-row-top">
            <p className="settings-summary">
              {canArchive
                ? "Archiving hides this project for everyone. Its files stay on disk."
                : "The last project cannot be archived."}
            </p>
            {confirmingArchive ? (
              <span className="archive-confirm">
                <span>archive {project.name}?</span>
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => void run(() => actions.archive(), "The project could not be archived")}
                  type="button"
                >yes</button>
                <button onClick={() => setConfirmingArchive(false)} type="button">no</button>
              </span>
            ) : (
              <button
                className="danger-text"
                disabled={!canArchive}
                onClick={() => setConfirmingArchive(true)}
                type="button"
              >archive project</button>
            )}
          </div>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
