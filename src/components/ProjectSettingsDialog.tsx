import { useEffect, useState } from "react";
import { Drawer } from "./Drawer";
import type { ArchivedProject, Page, Chapter, Member, ProjectCategory, ProjectField, User, UserRole } from "../../shared/types";
import { archivedProjects } from "../api/client";
import { Growing } from "./Growing";
import { CategoriesSection, type CategoryActions } from "./CategoriesSection";
import { ChaptersSection, type ChapterActions } from "./ChaptersSection";
import { FieldsSection, type FieldActions } from "./FieldsSection";
import { AgentAccessSection } from "./AgentAccessSection";
import { TeamSection } from "./TeamSection";
import { type SettingsRun, useSettingsAction } from "./use-settings-action";

export const SETTINGS_SECTIONS = ["general", "categories", "fields", "chapters", "github", "team", "agents", "danger"] as const;
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
  github: "GitHub",
  team: "Team",
  agents: "Agent access",
  danger: "Danger zone",
};

export type ProjectSettingsActions = {
  rename: (name: string) => Promise<void>;
  setDescription: (description: string) => Promise<void>;
  setChaptersEnabled: (enabled: boolean) => Promise<void>;
  setGithubRepo: (repo: string) => Promise<void>;
  setGithubToken: (token: string) => Promise<void>;
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
  project: { id: string; name: string; description: string; githubRepo: string; githubTokenSet: boolean };
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

  return (
    <Drawer className="dialog-panel settings-dialog" labelledBy="project-settings-title" onClose={onClose}>
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
          {active === "github" && (
            <GithubSection busy={busy} project={project} onSetRepo={actions.setGithubRepo} onSetToken={actions.setGithubToken} run={run} />
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
    </Drawer>
  );
}

type GeneralProps = {
  busy: boolean;
  canManage: boolean;
  project: { id: string; name: string; description: string; githubRepo: string; githubTokenSet: boolean };
  onRename: (name: string) => Promise<void>;
  onSetDescription: (description: string) => Promise<void>;
  run: SettingsRun;
};

/**
 * Where a project says which repository its pull requests live in.
 *
 * The token is write-only from here: the form can tell one is held and can replace or clear
 * it, but never reads it back, because a secret that round-trips to a browser is not one.
 */
function GithubSection({ busy, project, onSetRepo, onSetToken, run }: {
  busy: boolean;
  project: { githubRepo: string; githubTokenSet: boolean };
  onSetRepo: (repo: string) => Promise<void>;
  onSetToken: (token: string) => Promise<void>;
  run: SettingsRun;
}) {
  const [repo, setRepo] = useState(project.githubRepo);
  const [token, setToken] = useState("");

  const saveRepo = () => {
    const next = repo.trim();
    if (next === project.githubRepo) return;
    void run(() => onSetRepo(next), "The repository could not be saved");
  };

  const saveToken = () => {
    const next = token.trim();
    if (!next) return;
    setToken("");
    void run(() => onSetToken(next), "The token could not be saved");
  };

  return (
    <div className="settings-section">
      <p className="chapters-note">
        Link a page to a pull request or branch, and the board follows the code: the page moves
        into Review while its pull request is open, and into Done when it merges. Grimoire checks
        every couple of minutes, and only ever moves a page forward.
      </p>
      <div className="settings-row">
        <label className="field-label" htmlFor="settings-github-repo">Repository</label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-github-repo"
            name="githubRepo"
            onBlur={saveRepo}
            onChange={(event) => setRepo(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveRepo(); } }}
            placeholder="owner/repository"
            value={repo}
          />
        </div>
        <p className="settings-summary">Where this project&apos;s pull requests live. Clearing it pauses the automation.</p>
      </div>
      <div className="settings-row">
        <label className="field-label" htmlFor="settings-github-token">Access token</label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-github-token"
            name="githubToken"
            onBlur={saveToken}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveToken(); } }}
            placeholder={project.githubTokenSet ? "A token is saved. Paste a new one to replace it." : "github_pat_..."}
            type="password"
            value={token}
          />
        </div>
        <p className="settings-summary">
          A fine-grained token with read access to pull requests. Optional for public repositories.
          It stays on the server and is never shown again.
        </p>
        {project.githubTokenSet && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void run(() => onSetToken(""), "The token could not be cleared")}
            type="button"
          >forget the saved token</button>
        )}
      </div>
    </div>
  );
}

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
