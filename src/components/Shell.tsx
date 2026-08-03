import type { ReactNode } from "react";
import type { Workspace } from "../../shared/types";

export type ViewName = "overview" | "direction" | "outcomes" | "ideas" | "assets" | "playtests" | "my work" | "team";

type Props = {
  workspace: Workspace;
  activeView: ViewName;
  onNavigate: (view: ViewName) => void;
  onLogout: () => void;
  children: ReactNode;
};

const primaryViews: ViewName[] = ["overview", "direction", "outcomes", "ideas", "assets", "playtests"];

export function Shell({ workspace, activeView, onNavigate, onLogout, children }: Props) {
  const myOpenWork = workspace.workItems.filter(
    (item) => item.ownerId === workspace.currentUser.id && item.status !== "done",
  ).length;
  const inboxCount = workspace.ideas.filter((idea) => idea.status === "inbox").length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => onNavigate("overview")} type="button">
          <span className="brand-mark">g</span>
          <span>grimoire</span>
        </button>
        <div className="project-name">{workspace.project.name.toLowerCase()}</div>
        <div className="connection">
          <span className="connection-dot" />
          project online
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label="Project navigation">
            {primaryViews.map((view) => (
              <button
                className={`nav-item ${activeView === view ? "active" : ""}`}
                key={view}
                onClick={() => onNavigate(view)}
                type="button"
              >
                <span>{view}</span>
                {view === "ideas" && <span className="nav-count">{inboxCount}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className={`nav-item ${activeView === "my work" ? "active" : ""}`}
              onClick={() => onNavigate("my work")}
              type="button"
            >
              <span>my work</span>
              <span className="nav-count">{myOpenWork}</span>
            </button>
            <button
              className={`nav-item ${activeView === "team" ? "active" : ""}`}
              onClick={() => onNavigate("team")}
              type="button"
            >
              <span>team</span>
              <span className="nav-count">{workspace.members.length}</span>
            </button>
            <div className="account-row">
              <span className="avatar small">{workspace.currentUser.name[0]}</span>
              <div>
                <strong>{workspace.currentUser.name}</strong>
                <span>{workspace.currentUser.role}</span>
              </div>
              <button className="text-button" onClick={onLogout} type="button">sign out</button>
            </div>
          </div>
        </aside>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

