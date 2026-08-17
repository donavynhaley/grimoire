import { useEffect, useState } from "react";
import type { ArchivedProject, Page, Chapter, Member, ProjectCategory, ProjectField, User, UserRole } from "../../shared/types";
import { archivedProjects } from "../api/client";
import { Growing } from "./Growing";
import { CategoriesSection, type CategoryActions } from "./CategoriesSection";
import { ChaptersSection, type ChapterActions } from "./ChaptersSection";
import { FieldsSection, type FieldActions } from "./FieldsSection";
import { AgentAccessSection } from "./AgentAccessSection";
import { TeamSection } from "./TeamSection";
import { useDialogEscape } from "./use-dialog-escape";
import { type SettingsRun, useSettingsAction } from "./use-settings-action";

export const SETTINGS_SECTIONS = ["general", "categories", "fields", "chapters", "team", "agents", "danger"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections a member can read. Agent credentials and archiving stay owner-only. */
const MEMBER_SECTIONS: readonly SettingsSection[] = ["general", "categories", "fields", "chapters", "team"];

export function settingsSectionsFor(isOwner: boolean): readonly SettingsSection[] {
  return isOwner ? SETTINGS_SECTIONS : MEMBER_SECTIONS;
}

const SECTION_LABELS: Record<SettingsSection, string> = {
  general: "General",
  categories: "Categories",
  fields: "Page fields",
  chapters: "Chapters",
  team: "Team",
  agents: "Agent access",
  danger: "Danger zone",
};

export type ProjectSettingsActions = {
  rename: (name: string) => Promise<void>;
  setDescription: (description: string) => Promise<void>;
  setChaptersEnabled: (enabled: boolean) => Promise<void>;
  archive: () => Promise<void>;
  restore: (id: string) => Promise<void>;
};

type Props = {
  actions: ProjectSettingsActions;
  busy: boolean;
  canArchive: boolean;
  /** Owners get every section; members get a read of the project's shape and its team. */
  isOwner: boolean;
  currentUser: User;
  members: Member[];
  online: ReadonlySet<string>;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  chaptersEnabled: boolean;
  fields: ProjectField[];
  project: { id: string; name: string; description: string };
  section: SettingsSection;
  categoryActions: CategoryActions;
  chapterActions: ChapterActions;
  fieldActions: FieldActions;
  onCreateInvite: () => Promise<string>;
  onChangeMemberRole: (id: string, role: UserRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onSetPageChapter: (id: string, chapter: string | null) => Promise<void>;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
};

/**
 * The one place a project is configured, as one dialog with a section rail.
 *
 * These sections used to be five separate modals launched from a summary screen, plus a Team
 * dialog on its own header button - seven doors into one feature, each with its own close
 * behaviour. Here the rail is the whole map: every section is one click from every other,
 * closing means closing settings, and the address bar carries `?settings=<section>` so a
 * reload or a shared link lands exactly where the reader was.
 */
export function ProjectSettingsDialog({
  actions,
  busy,
  canArchive,
  isOwner,
  currentUser,
  members,
  online,
  pages,
  categories,
  chapters,
  chaptersEnabled,
  fields,
  project,
  section,
  categoryActions,
  chapterActions,
  fieldActions,
  onCreateInvite,
  onChangeMemberRole,
  onRemoveMember,
  onSetPageChapter,
  onSectionChange,
  onClose,
}: Props) {
  const sections = settingsSectionsFor(isOwner);
  const active = sections.includes(section) ? section : "general";
  const { error, saved, run } = useSettingsAction();

  useDialogEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="project-settings-title" aria-modal="true" className="dialog-panel settings-dialog" role="dialog">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">{project.name}</p>
            <h2 id="project-settings-title">Project settings</h2>
          </div>
          <button aria-label="Close project settings" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="settings-layout">
          <nav aria-label="Settings sections" className="settings-rail">
            {sections.map((candidate) => (
              <button
                aria-current={candidate === active ? "true" : undefined}
                className={candidate === "danger" ? "danger" : ""}
                key={candidate}
                onClick={() => onSectionChange(candidate)}
                type="button"
              >
                {SECTION_LABELS[candidate]}
              </button>
            ))}
          </nav>

          <Growing className="settings-content">
            {active === "general" && (
              <GeneralSection
                busy={busy}
                canManage={isOwner}
                onRename={actions.rename}
                onSetDescription={actions.setDescription}
                project={project}
                run={run}
              />
            )}
            {active === "categories" && (
              <CategoriesSection actions={categoryActions} busy={busy} canManage={isOwner} categories={categories} run={run} />
            )}
            {active === "fields" && (
              <FieldsSection actions={fieldActions} busy={busy} canManage={isOwner} fields={fields} run={run} />
            )}
            {active === "chapters" && (
              <ChaptersSection
                actions={chapterActions}
                busy={busy}
                canManage={isOwner}
                chapters={chapters}
                chaptersEnabled={chaptersEnabled}
                onSetChaptersEnabled={actions.setChaptersEnabled}
                onSetPageChapter={onSetPageChapter}
                pages={pages}
                run={run}
              />
            )}
            {active === "team" && (
              <TeamSection
                busy={busy}
                currentUser={currentUser}
                members={members}
                onChangeMemberRole={onChangeMemberRole}
                onCreateInvite={onCreateInvite}
                onRemoveMember={onRemoveMember}
                online={online}
                run={run}
              />
            )}
            {active === "agents" && isOwner && <AgentAccessSection run={run} />}
            {active === "danger" && isOwner && (
              <DangerSection
                busy={busy}
                canArchive={canArchive}
                onArchive={actions.archive}
                onRestore={actions.restore}
                projectName={project.name}
                run={run}
              />
            )}
          </Growing>
        </div>

        <Growing className="settings-feedback">
          {error && <div className="error-banner" role="alert">{error}</div>}
          {saved && !error && <div className="saved-note" role="status">saved</div>}
        </Growing>
      </section>
    </div>
  );
}

type GeneralProps = {
  busy: boolean;
  canManage: boolean;
  project: { id: string; name: string; description: string };
  onRename: (name: string) => Promise<void>;
  onSetDescription: (description: string) => Promise<void>;
  run: SettingsRun;
};

function GeneralSection({ busy, canManage, project, onRename, onSetDescription, run }: GeneralProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);

  const saveName = () => {
    const next = name.trim();
    if (!next) {
      setName(project.name);
      return;
    }
    if (next === project.name) return;
    void run(() => onRename(next), "The project could not be renamed");
  };

  const saveDescription = () => {
    const next = description.trim();
    if (next === project.description) return;
    void run(() => onSetDescription(next), "The description could not be saved");
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
        <label className="field-label" htmlFor="settings-project-name">Name</label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-project-name"
            name="projectName"
            onBlur={saveName}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveName(); } }}
            value={name}
          />
        </div>
      </div>
      <div className="settings-row">
        <label className="field-label" htmlFor="settings-project-description">Description</label>
        <textarea
          disabled={busy}
          id="settings-project-description"
          name="projectDescription"
          onBlur={saveDescription}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="One sentence saying what this project is. It shows in the project switcher."
          rows={2}
          value={description}
        />
      </div>
    </div>
  );
}

type DangerProps = {
  busy: boolean;
  canArchive: boolean;
  projectName: string;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  run: SettingsRun;
};

function DangerSection({ busy, canArchive, projectName, onArchive, onRestore, run }: DangerProps) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archived, setArchived] = useState<ArchivedProject[] | null>(null);
  const [listFailed, setListFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    archivedProjects()
      .then((value) => { if (alive) setArchived(value.projects); })
      .catch(() => { if (alive) setListFailed(true); });
    return () => { alive = false; };
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
          {confirmingArchive ? (
            <span className="archive-confirm">
              <span>archive {projectName}?</span>
              <button
                className="danger-text"
                disabled={busy}
                onClick={() => void run(() => onArchive(), "The project could not be archived")}
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
                  onClick={() => void run(async () => {
                    await onRestore(candidate.id);
                    setArchived((current) => current?.filter((value) => value.id !== candidate.id) ?? null);
                  }, `${candidate.name} could not be restored`)}
                  type="button"
                >restore</button>
              </li>
            ))}
          </ul>
        )}
      </Growing>
    </div>
  );
}
