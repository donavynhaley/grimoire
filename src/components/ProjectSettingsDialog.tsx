import { useEffect, useState } from "react";
import { Drawer } from "./Drawer";
import type { ArchivedProject, Page, Chapter, ChapterVelocity, Member, ProjectCategory, ProjectField, User, UserRole } from "../../shared/types";
import { archivedProjects, mutate, verifyGithub, type GithubVerification } from "../api/client";
import { Growing } from "./Growing";
import { CategoriesSection, type CategoryActions } from "./CategoriesSection";
import { ChaptersSection, type ChapterActions } from "./ChaptersSection";
import { FieldsSection, type FieldActions } from "./FieldsSection";
import { AgentAccessSection } from "./AgentAccessSection";
import { TeamSection } from "./TeamSection";
import { type SettingsRun, useSettingsAction } from "./use-settings-action";

export const SETTINGS_SECTIONS = ["general", "categories", "fields", "chapters", "github", "discord", "team", "agents", "danger"] as const;
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
  discord: "Discord",
  team: "Team",
  agents: "Agent access",
  danger: "Danger zone",
};

export type ProjectSettingsActions = {
  rename: (name: string) => Promise<void>;
  setDescription: (description: string) => Promise<void>;
  setChaptersEnabled: (enabled: boolean) => Promise<void>;
  setEstimatesEnabled: (enabled: boolean) => Promise<void>;
  setDiscordWebhook: (webhook: string) => Promise<void>;
  setRecapOnClose: (enabled: boolean) => Promise<void>;
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
  /** Per-chapter totals, passed through to the chapters section that shows them. */
  velocity: ChapterVelocity[];
  fields: ProjectField[];
  project: {
    id: string;
    name: string;
    description: string;
    githubRepo: string;
    githubTokenSet: boolean;
    estimatesEnabled: boolean;
    discordWebhookSet: boolean;
    recapOnClose: boolean;
  };
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
  velocity,
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
          {active === "discord" && (
            <DiscordSection
              busy={busy}
              chapters={chapters}
              chaptersEnabled={chaptersEnabled}
              onSetRecapOnClose={actions.setRecapOnClose}
              onSetWebhook={actions.setDiscordWebhook}
              project={project}
              run={run}
            />
          )}
          {active === "categories" && (
            <CategoriesSection actions={categoryActions} busy={busy} canManage={isOwner} categories={categories} run={run} />
          )}
          {active === "fields" && (
            <FieldsSection
              actions={fieldActions}
              busy={busy}
              canManage={isOwner}
              estimatesEnabled={project.estimatesEnabled}
              fields={fields}
              onSetEstimatesEnabled={actions.setEstimatesEnabled}
              run={run}
            />
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
              velocity={velocity}
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
/**
 * Where a chapter's recap goes when it closes.
 *
 * The webhook is write-only from here, like the GitHub token: settings can tell one is held,
 * replace it, or clear it, and never reads it back. Posting by hand is offered beside the
 * automation because the first thing anyone wants after pasting a webhook is to see something
 * arrive in the channel.
 */
function DiscordSection({ busy, chapters, chaptersEnabled, onSetRecapOnClose, onSetWebhook, project, run }: {
  busy: boolean;
  chapters: Chapter[];
  chaptersEnabled: boolean;
  onSetRecapOnClose: (enabled: boolean) => Promise<void>;
  onSetWebhook: (webhook: string) => Promise<void>;
  project: { discordWebhookSet: boolean; recapOnClose: boolean };
  run: SettingsRun;
}) {
  const [webhook, setWebhook] = useState("");
  const [showingSetup, setShowingSetup] = useState(!project.discordWebhookSet);
  const [posted, setPosted] = useState<string | null>(null);
  const closed = chapters.filter((chapter) => chapter.state === "closed");

  const saveWebhook = () => {
    const next = webhook.trim();
    if (!next) return;
    setWebhook("");
    void run(() => onSetWebhook(next), "The webhook could not be saved");
  };

  const postNow = async (slug: string, name: string) => {
    setPosted(null);
    try {
      await mutate(`/api/chapters/${slug}/recap`, "POST");
      setPosted(`Posted the recap for ${name}.`);
    } catch {
      setPosted("Discord would not take the post. Check the webhook.");
    }
  };

  return (
    <div className="settings-section">
      <div className="github-intro">
        <p className="chapters-note">
          When a chapter closes, Grimoire posts what it delivered, what it carried onward, and who
          shipped what. Nothing is written on anyone&apos;s behalf - it is the board&apos;s own numbers.
        </p>
        <button
          aria-expanded={showingSetup}
          aria-label={showingSetup ? "Hide setup instructions" : "How do I set this up?"}
          className="github-help"
          onClick={() => setShowingSetup((showing) => !showing)}
          title="How do I set this up?"
          type="button"
        >?</button>
      </div>

      <Growing className="github-setup-fold">
        {showingSetup && (
          <ol className="github-setup">
            <li>
              In Discord, open <em>Server Settings → Integrations → Webhooks</em>, make a webhook
              pointed at the channel you want recaps in, and copy its URL.
            </li>
            <li>Paste it below. It stays on the server and is never shown again.</li>
            <li>Leave <em>post on close</em> on, and every chapter you close announces itself.</li>
          </ol>
        )}
      </Growing>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-discord-webhook">Webhook URL</label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-discord-webhook"
            name="discordWebhook"
            onBlur={saveWebhook}
            onChange={(event) => setWebhook(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveWebhook(); } }}
            placeholder={project.discordWebhookSet ? "A webhook is saved. Paste a new one to replace it." : "https://discord.com/api/webhooks/..."}
            type="password"
            value={webhook}
          />
        </div>
        {project.discordWebhookSet && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void run(() => onSetWebhook(""), "The webhook could not be cleared")}
            type="button"
          >forget the saved webhook</button>
        )}
      </div>

      <Growing className="settings-row">
        <div className="settings-row-top">
          <span className="field-label">Post on close</span>
          <label className="settings-toggle">
            <input
              aria-label="Post on close"
              checked={project.recapOnClose}
              disabled={busy || !project.discordWebhookSet}
              name="recapOnClose"
              onChange={(event) => void run(
                () => onSetRecapOnClose(event.target.checked),
                "The setting could not be changed",
              )}
              type="checkbox"
            />
            <span aria-hidden="true" className="settings-knob" />
            <span className="settings-toggle-label">{project.recapOnClose ? "on" : "off"}</span>
          </label>
        </div>
        <p className="settings-summary">
          {chaptersEnabled
            ? "Closing a chapter posts its recap. Turn this off to post only by hand."
            : "Chapters are off, so nothing closes and nothing posts. Turn them on to use this."}
        </p>
      </Growing>

      {project.discordWebhookSet && closed.length > 0 && (
        <div className="settings-row">
          <span className="field-label">Post one now</span>
          <div className="library-filters">
            {closed.slice(0, 6).map((chapter) => (
              <button
                disabled={busy}
                key={chapter.slug}
                onClick={() => void postNow(chapter.slug, chapter.name)}
                type="button"
              >{chapter.name}</button>
            ))}
          </div>
          {posted && <p className="github-check-result ok" role="status">{posted}</p>}
        </div>
      )}
    </div>
  );
}

function GithubSection({ busy, project, onSetRepo, onSetToken, run }: {
  busy: boolean;
  project: { githubRepo: string; githubTokenSet: boolean };
  onSetRepo: (repo: string) => Promise<void>;
  onSetToken: (token: string) => Promise<void>;
  run: SettingsRun;
}) {
  const [repo, setRepo] = useState(project.githubRepo);
  const [token, setToken] = useState("");
  const [verdict, setVerdict] = useState<GithubVerification | "checking" | null>(null);
  // Open on arrival only while nothing is configured, which is exactly when it is needed.
  const [showingSetup, setShowingSetup] = useState(!project.githubRepo);

  const saveRepo = () => {
    const next = repo.trim();
    if (next === project.githubRepo) return;
    setVerdict(null);
    void run(() => onSetRepo(next), "The repository could not be saved");
  };

  const saveToken = () => {
    const next = token.trim();
    if (!next) return;
    setToken("");
    setVerdict(null);
    void run(() => onSetToken(next), "The token could not be saved");
  };

  const check = async () => {
    setVerdict("checking");
    try {
      setVerdict(await verifyGithub());
    } catch {
      setVerdict({ ok: false, reason: "unreachable", message: "The check itself failed. Try again in a moment." });
    }
  };

  return (
    <div className="settings-section">
      {/*
        The steps are onboarding: needed once, in the way every visit after. They fold behind
        the question mark, which stays beside the sentence that says what the section is for.
      */}
      <div className="github-intro">
        <p className="chapters-note">
          Link a page to a pull request or branch, and the board follows the code: the page moves
          into Review while its pull request is open, and into Done when it merges.
        </p>
        <button
          aria-expanded={showingSetup}
          aria-label={showingSetup ? "Hide setup instructions" : "How do I set this up?"}
          className="github-help"
          onClick={() => setShowingSetup((showing) => !showing)}
          title="How do I set this up?"
          type="button"
        >?</button>
      </div>

      <Growing className="github-setup-fold">
        {showingSetup && (
          <ol className="github-setup">
            <li>Name the repository this project&apos;s pull requests live in, as <code>owner/name</code>.</li>
            <li>
              For a private repository,{" "}
              <a href="https://github.com/settings/personal-access-tokens/new" rel="noreferrer" target="_blank">
                create a fine-grained access token
              </a>{" "}
              on GitHub: under <em>Only select repositories</em> choose this one, and under{" "}
              <em>Repository permissions</em> grant <em>Pull requests: read-only</em>. Nothing else is
              needed. A public repository needs no token at all.
            </li>
            <li>Paste the token below, then check the connection.</li>
            <li>
              On any page, the <strong>GitHub</strong> row in its details takes a pull request URL, a
              number like <code>#12</code>, or a branch name. A linked branch adopts whichever pull
              request it grows.
            </li>
            <li>Grimoire checks every couple of minutes, and only ever moves a page forward.</li>
          </ol>
        )}
      </Growing>

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
        <p className="settings-summary">Clearing it pauses the automation; nothing already linked is forgotten.</p>
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
        <p className="settings-summary">It stays on the server and is never shown again.</p>
        {project.githubTokenSet && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void run(() => onSetToken(""), "The token could not be cleared")}
            type="button"
          >forget the saved token</button>
        )}
      </div>

      <div className="settings-row">
        <span className="field-label">Connection</span>
        <div className="github-check">
          <button className="quiet-button" disabled={busy || verdict === "checking"} onClick={() => void check()} type="button">
            {verdict === "checking" ? "checking..." : "check the connection"}
          </button>
          {verdict !== null && verdict !== "checking" && (
            <p className={verdict.ok ? "github-check-result ok" : "github-check-result failed"} role="status">
              {verdict.ok
                ? `Connected: ${verdict.repo} (${verdict.private ? "private" : "public"} repository).`
                : verdict.message}
            </p>
          )}
        </div>
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
