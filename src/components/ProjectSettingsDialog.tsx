import type {
  Chapter,
  ChapterVelocity,
  Member,
  Page,
  ProjectCategory,
  ProjectField,
  ProjectRole,
  User,
} from "../../shared/types";
import { demoMode } from "../demo/mode";
import { useSettingsAction } from "../hooks/use-settings-action";
import { type SettingsSection, settingsSectionsFor } from "../lib/settings-sections";
import { AgentAccessSection } from "./AgentAccessSection";
import { CategoriesSection, type CategoryActions } from "./CategoriesSection";
import { type ChapterActions, ChaptersSection } from "./ChaptersSection";
import { DangerSection } from "./DangerSection";
import { DiscordSection } from "./DiscordSection";
import { Drawer } from "./Drawer";
import { type FieldActions, FieldsSection } from "./FieldsSection";
import { GeneralSection } from "./GeneralSection";
import { GithubSection } from "./GithubSection";
import { Growing } from "./Growing";
import { ImportSection } from "./ImportSection";
import { SignInSection } from "./SignInSection";
import { TeamSection } from "./TeamSection";

export { type SettingsSection, settingsSectionsFor } from "../lib/settings-sections";

const SECTION_LABELS: Record<SettingsSection, string> = {
  general: "General",
  categories: "Categories",
  fields: "Page fields",
  chapters: "Chapters",
  import: "Import",
  github: "GitHub",
  discord: "Discord",
  team: "Team",
  agents: "Agent access",
  signin: "Sign-in",
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
  onAddMember: (email: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onChangeMemberRole: (id: string, role: ProjectRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
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
  onAddMember,
  onCreateInvite,
  onChangeMemberRole,
  onRemoveMember,
  onSectionChange,
  onClose,
}: Props) {
  const sections = settingsSectionsFor(isOwner, currentUser.role === "admin");
  const active = sections.includes(section) ? section : "general";
  const demoExplanations: Record<string, string> = {
    github:
      "Connect a repository on your own installation to link pages to pull requests and follow their progress. The demo does not contact GitHub or accept access tokens.",
    discord:
      "Your own installation can post chapter recaps to Discord. The demo does not connect webhooks or send messages.",
    agents:
      "On your own installation, issue a revocable project credential to let an agent read or update work through MCP. This browser-only demo cannot issue real credentials.",
    import:
      "Your own installation can import boards from Trello and Focalboard. This demo starts with sample data; try creating pages and ideas here instead.",
    signin: "Sign-in providers belong to your own installation. The demo has no real accounts or passwords.",
  };
  const demoExplanation = demoMode ? demoExplanations[active] : undefined;
  const { error, saved, run } = useSettingsAction();

  return (
    <Drawer className="dialog-panel settings-dialog" labelledBy="project-settings-title" onClose={onClose}>
      <header className="dialog-header">
        <div>
          <p className="eyebrow">{project.name}</p>
          <h2 id="project-settings-title">Project settings</h2>
        </div>
        <button aria-label="Close project settings" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
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
          {demoExplanation && <p className="settings-summary">{demoExplanation}</p>}
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
          {!demoExplanation && active === "github" && (
            <GithubSection
              busy={busy}
              project={project}
              onSetRepo={actions.setGithubRepo}
              onSetToken={actions.setGithubToken}
              run={run}
            />
          )}
          {!demoExplanation && active === "discord" && (
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
            <CategoriesSection
              actions={categoryActions}
              busy={busy}
              canManage={isOwner}
              categories={categories}
              run={run}
            />
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
              pages={pages}
              velocity={velocity}
              run={run}
            />
          )}
          {active === "team" && (
            <TeamSection
              busy={busy}
              currentUser={currentUser}
              isOwner={isOwner}
              members={members}
              onChangeMemberRole={onChangeMemberRole}
              onAddMember={onAddMember}
              onCreateInvite={onCreateInvite}
              onRemoveMember={onRemoveMember}
              online={online}
              run={run}
            />
          )}
          {!demoExplanation && active === "import" && isOwner && <ImportSection />}
          {!demoExplanation && active === "agents" && isOwner && <AgentAccessSection run={run} />}
          {!demoExplanation && active === "signin" && currentUser.role === "admin" && (
            <SignInSection run={run} />
          )}
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
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {saved && !error && (
          <div className="saved-note" role="status">
            saved
          </div>
        )}
      </Growing>
    </Drawer>
  );
}
