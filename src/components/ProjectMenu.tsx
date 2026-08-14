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
  onManageCategories: () => void;
};

export function ProjectMenu({ project, projects, isOwner, busy, actions, onManageCategories }: Props) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [error, setError] = useState("");
  const hasMenu = isOwner || projects.length > 1;

  const close = () => {
    setOpen(false);
    setRenaming(false);
    setConfirmingArchive(false);
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

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name) return;
    if (name === project.name) {
      setRenaming(false);
      return;
    }
    void run(() => actions.rename(project.id, name), "The project could not be renamed");
  };

  if (!hasMenu) return <h1>{project.name}</h1>;

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
                {candidate.name}
              </button>
            ))}
          </div>
          {isOwner && (
            <div className="project-menu-owner">
              <form className="project-menu-create" onSubmit={submitNewProject}>
                <label className="sr-only" htmlFor="new-project-name">New project name</label>
                <input
                  id="new-project-name"
                  name="newProjectName"
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="New project name..."
                  value={newName}
                />
                <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">create</button>
              </form>
              <div className="project-menu-actions">
                <button onClick={onManageCategories} type="button">edit categories</button>
                {renaming ? (
                  <form className="project-menu-rename" onSubmit={submitRename}>
                    <label className="sr-only" htmlFor="rename-project">Rename project</label>
                    <input
                      autoFocus
                      id="rename-project"
                      name="renameProject"
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setRenaming(false); }}
                      value={renameValue}
                    />
                    <button className="primary-button compact" disabled={busy || !renameValue.trim()} type="submit">save</button>
                  </form>
                ) : (
                  <button onClick={() => { setRenaming(true); setRenameValue(project.name); }} type="button">rename project</button>
                )}
                {confirmingArchive ? (
                  <span className="archive-confirm">
                    archive {project.name}?
                    <button
                      className="danger-text"
                      disabled={busy}
                      onClick={() => void run(() => actions.archive(project.id), "The project could not be archived")}
                      type="button"
                    >yes</button>
                    <button onClick={() => setConfirmingArchive(false)} type="button">no</button>
                  </span>
                ) : (
                  <button
                    className="danger-text"
                    disabled={projects.length < 2}
                    onClick={() => setConfirmingArchive(true)}
                    title={projects.length < 2 ? "The last project cannot be archived" : undefined}
                    type="button"
                  >archive project</button>
                )}
              </div>
            </div>
          )}
          {error && <p className="project-menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
