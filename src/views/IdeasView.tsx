import { FormEvent, useState } from "react";
import type { Idea } from "../../shared/types";
import type { ViewProps } from "./types";
import { EmptyState, PageHeading } from "./OverviewView";

export function IdeasView({ workspace, runMutation, busy }: ViewProps) {
  const [title, setTitle] = useState("");
  const [promoting, setPromoting] = useState<Idea | null>(null);
  const [definition, setDefinition] = useState("");
  const groups: Array<{ status: Idea["status"]; label: string }> = [
    { status: "inbox", label: "inbox" },
    { status: "considering", label: "considering" },
    { status: "later", label: "saved for later" },
    { status: "rejected", label: "rejected" },
    { status: "promoted", label: "promoted" },
  ];

  const capture = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await runMutation("/api/ideas", "POST", { title: title.trim() });
    setTitle("");
  };

  const promote = async (event: FormEvent) => {
    event.preventDefault();
    if (!promoting) return;
    await runMutation(`/api/ideas/${promoting.id}/promote`, "POST", {
      title: promoting.title,
      description: promoting.notes,
      definitionOfPlayable: definition,
      ownerId: workspace.currentUser.id,
      milestoneId: workspace.milestones.find((item) => item.status === "active")?.id,
    });
    setPromoting(null);
    setDefinition("");
  };

  return (
    <>
      <PageHeading eyebrow="idea vault" title="Capture freely. Commit deliberately." copy="An idea costs nothing until the team promotes it into a playable outcome." />
      <form className="capture slim" onSubmit={capture}>
        <label htmlFor="idea-page-capture">new idea</label>
        <div className="capture-row">
          <input id="idea-page-capture" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What might make the game better?" />
          <button className="primary-button" disabled={busy || !title.trim()} type="submit">capture</button>
        </div>
      </form>

      <div className="idea-columns">
        {groups.map((group) => {
          const ideas = workspace.ideas.filter((idea) => idea.status === group.status);
          return (
            <section className="idea-group" key={group.status}>
              <header><h2>{group.label}</h2><span>{ideas.length}</span></header>
              <div className="idea-cards">
                {ideas.map((idea) => (
                  <article className="idea-card" key={idea.id}>
                    <h3>{idea.title}</h3>
                    {idea.notes && <p>{idea.notes}</p>}
                    <div className="idea-meta"><span>by {idea.creatorName}</span><span>{idea.horizon}</span></div>
                    {idea.status !== "promoted" && (
                      <div className="card-actions">
                        <select
                          aria-label={`status for ${idea.title}`}
                          value={idea.status}
                          onChange={(e) => runMutation(`/api/ideas/${idea.id}`, "PATCH", { status: e.target.value })}
                        >
                          <option value="inbox">inbox</option><option value="considering">considering</option>
                          <option value="later">later</option><option value="rejected">rejected</option>
                        </select>
                        <select
                          aria-label={`horizon for ${idea.title}`}
                          value={idea.horizon}
                          onChange={(e) => runMutation(`/api/ideas/${idea.id}`, "PATCH", { horizon: e.target.value })}
                        >
                          <option value="now">now</option><option value="next">next</option><option value="later">later</option>
                        </select>
                        <button className="text-button accent" onClick={() => setPromoting(idea)} type="button">promote</button>
                      </div>
                    )}
                  </article>
                ))}
                {ideas.length === 0 && <EmptyState text="Nothing here." />}
              </div>
            </section>
          );
        })}
      </div>

      {promoting && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal" onSubmit={promote}>
            <p className="eyebrow">promote idea</p><h2>{promoting.title}</h2>
            <label><span>Definition of playable</span><textarea value={definition} onChange={(e) => setDefinition(e.target.value)} required /></label>
            <div className="form-actions"><button className="secondary-button" onClick={() => setPromoting(null)} type="button">cancel</button><button className="primary-button" disabled={busy} type="submit">create outcome</button></div>
          </form>
        </div>
      )}
    </>
  );
}

