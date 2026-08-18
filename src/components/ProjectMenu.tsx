import { type FormEvent, useState } from "react";
import type { ProjectSummary } from "../../shared/types";

export type ProjectActions = {
  select: (id: string) => Promise<void>;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
};

type Props = {
  project: { id: string; name: string };
  projects: ProjectSummary[];
  isOwner: boolean;
  busy: boolean;
  actions: ProjectActions;
  onOpenSettings: () => void;
  /**
   * Where activity and team live on a phone, whose top bar has no room for their buttons.
   * The entries are in the menu on every screen and shown only where the buttons are not,
   * so nothing desktop-visible changes.
   */
  onOpenActivity?: () => void;
  onOpenTeam: () => void;
  /** Changes waiting on the activity log, carried here because the phone bar hides its button. */
  activityBadge?: number;
};

/**
 * A project switcher, and nothing else.
 *
 * Configuration used to live here as a wrapping row of bare text links that grew with every
 * project-level feature the product gained. It moved into the settings dialog, which leaves
 * this menu doing the one thing its name promises and the one thing it is used for almost
 * every time it opens. Settings is offered to every member - the dialog itself decides what
 * a member may read versus what an owner may change.
 */
export function ProjectMenu({ project, projects, isOwner, busy, actions, onOpenSettings, onOpenActivity, onOpenTeam, activityBadge = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const close = () => {
    setOpen(false);
    setCreating(false);
    setNewName("");
    setError("");
  };

  const run = async (change: () => Promise<void>, failure: string) => {
    setError("");
    try {
      await change();
      close();
    } catch (value) {
      setError(value instanceof Error ? value.message : failure);
    }
  };

  const submitNewProject = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await actions.create(name);
      setNewName("");
    }, "The project could not be created");
  };

  return (
    <div
      className="project-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <h1>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          className="project-menu-trigger"
          onClick={() => (open ? close() : setOpen(true))}
          type="button"
        >
          {/* Named separately so a long project name can give way on narrow screens. */}
          <span className="project-menu-name">{project.name}</span>
          <span aria-hidden="true" className="project-menu-caret">▾</span>
        </button>
      </h1>
      {open && (
        <div aria-label="Projects" className="project-menu-panel" role="menu">
          <p className="project-menu-label">projects</p>
          <div className="project-menu-list">
            {projects.map((candidate) => (
              <button
                aria-current={candidate.id === project.id ? "true" : undefined}
                className={candidate.id === project.id ? "current" : ""}
                disabled={busy}
                key={candidate.id}
                onClick={() => {
                  if (candidate.id === project.id) close();
                  else void run(() => actions.select(candidate.id), "The project could not be opened");
                }}
                role="menuitem"
                type="button"
              >
                <span className="project-menu-option-name">{candidate.name}</span>
                {candidate.description && <span className="project-menu-desc">{candidate.description}</span>}
              </button>
            ))}
          </div>
          <div className="project-menu-owner">
            {/* Collapsed behind a reveal, the way every column's "+ add page" already works. */}
            {isOwner && (creating ? (
              <form className="project-menu-create" onSubmit={submitNewProject}>
                <label className="sr-only" htmlFor="new-project-name">New project name</label>
                <input
                  autoFocus
                  id="new-project-name"
                  name="newProjectName"
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setCreating(false); }}
                  placeholder="New project name..."
                  value={newName}
                />
                <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">create</button>
              </form>
            ) : (
              <button className="project-menu-entry" onClick={() => setCreating(true)} role="menuitem" type="button">
                <span aria-hidden="true" className="project-menu-glyph">+</span>New project
              </button>
            ))}
            {onOpenActivity && (
              <button
                className="project-menu-entry phone-only"
                onClick={() => { close(); onOpenActivity(); }}
                role="menuitem"
                type="button"
              >
                <span aria-hidden="true" className="project-menu-glyph">≡</span>Activity
                {activityBadge > 0 && (
                  <span aria-label={`${activityBadge} changes since your last visit`} className="away-badge">
                    {activityBadge > 99 ? "99+" : activityBadge}
                  </span>
                )}
              </button>
            )}
            <button
              className="project-menu-entry phone-only"
              onClick={() => { close(); onOpenTeam(); }}
              role="menuitem"
              type="button"
            >
              <span aria-hidden="true" className="project-menu-glyph">◔</span>Team
            </button>
            <button
              className="project-menu-entry settings"
              onClick={() => { close(); onOpenSettings(); }}
              role="menuitem"
              type="button"
            >
              <span aria-hidden="true" className="project-menu-glyph">⚙</span>Project settings
            </button>
          </div>
          {error && <p className="project-menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
