import packageJson from "../../package.json";
import type { BoardWorkspace } from "../../shared/types";
import { Avatar } from "./Avatar";
import { type ProjectActions, ProjectMenu } from "./ProjectMenu";
import type { SettingsSection } from "./ProjectSettingsDialog";

type Props = {
  board: BoardWorkspace;
  busy: boolean;
  projectActions: ProjectActions;
  /** Agent changes and open questions awaiting review; zero keeps the trigger off screen. */
  reviewCount: number;
  /** Changes since the reader's last visit, shown until the activity history is opened. */
  unseenCount: number;
  view: "work" | "ideas";
  onOpenAccount: () => void;
  onOpenActivity: () => void;
  onOpenAgentReview: () => void;
  onOpenSearch: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

/** The board's header: brand, workspace tabs, the project menu, and the signed-in person's row. */
export function BoardTopBar({
  board,
  busy,
  projectActions,
  reviewCount,
  unseenCount,
  view,
  onOpenAccount,
  onOpenActivity,
  onOpenAgentReview,
  onOpenSearch,
  onOpenSettings,
  onViewChange,
}: Props) {
  const isOwner = board.viewerIsOwner;
  return (
    <header className="board-topbar">
      <div className="brand-lockup">
        <span className="brand-mark">g</span>
        <span className="brand-word">grimoire</span>
        <span className="app-version">v{packageJson.version}</span>
        <nav className="workspace-tabs" aria-label="Project spaces">
          <button
            aria-current={view === "work" ? "page" : undefined}
            aria-label="work"
            onClick={() => void onViewChange("work")}
            title="Work (1)"
            type="button"
          >
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character */}
            work <kbd aria-hidden="true">1</kbd>
          </button>
          <button
            aria-current={view === "ideas" ? "page" : undefined}
            aria-label="ideas"
            onClick={() => void onViewChange("ideas")}
            title="Ideas (2)"
            type="button"
          >
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character */}
            ideas <kbd aria-hidden="true">2</kbd>
          </button>
        </nav>
      </div>
      <div className="board-project">
        <ProjectMenu
          actions={projectActions}
          activityBadge={unseenCount}
          busy={busy}
          isOwner={board.viewerIsOwner}
          onOpenActivity={isOwner ? onOpenActivity : undefined}
          onOpenSettings={() => onOpenSettings("general")}
          onOpenTeam={() => onOpenSettings("team")}
          project={board.project}
          projects={board.projects}
        />
      </div>
      <div className="board-actions">
        {/* Presence lives on the people filters, not here: this row is mostly the signed-in person. */}
        <div className="member-faces" aria-label={`${board.members.length} project members`} role="group">
          {board.members.slice(0, 4).map((member) => (
            <Avatar avatarUrl={member.avatarUrl} key={member.id} name={member.name} title={member.name} />
          ))}
        </div>
        {/* Every member reviews, not only the owner: agent work is attributed to whoever
            issued the credential, and the person it lands in front of is whoever is here. */}
        {reviewCount > 0 && (
          <button className="quiet-button agents-trigger" onClick={onOpenAgentReview} type="button">
            agents
            <span aria-label={`${reviewCount} agent changes to review`} className="away-badge">
              {reviewCount > 99 ? "99+" : reviewCount}
            </span>
          </button>
        )}
        {isOwner && (
          <button className="quiet-button activity-trigger" onClick={onOpenActivity} type="button">
            activity
            {unseenCount > 0 && (
              <span
                aria-label={`${unseenCount} changes since your last visit`}
                className="away-badge"
                role="img"
              >
                {unseenCount > 99 ? "99+" : unseenCount}
              </span>
            )}
          </button>
        )}
        {/*
          Search reaches the whole project from either workspace, and used to be reachable
          only by pressing "/" - a key a phone does not have, on a surface where the one
          visible way in appeared solely once a filter had been typed.
        */}
        <button
          aria-label="Search"
          className="quiet-button search-trigger"
          onClick={onOpenSearch}
          title="Search (/)"
          type="button"
        >
          <span aria-hidden="true">⌕</span>
          <span className="search-trigger-label">search</span>
        </button>
        {/* A shortcut into the one settings surface, landing on its Team section. */}
        <button className="quiet-button team-trigger" onClick={() => onOpenSettings("team")} type="button">
          team
        </button>
        <button
          aria-label={`Open account settings for ${board.currentUser.name}`}
          className="account-button"
          onClick={onOpenAccount}
          title="Account settings"
          type="button"
        >
          <Avatar
            avatarUrl={board.currentUser.avatarUrl}
            className="avatar current"
            name={board.currentUser.name}
          />
          <span>{board.currentUser.name}</span>
        </button>
      </div>
    </header>
  );
}
